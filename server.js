#!/usr/bin/env node
'use strict';
/**
 * Pocket Desktop — control your Ubuntu PC screen from your phone.
 *
 * A single-file HTTP server (no npm dependencies) that:
 *   • serves the mobile web app from ./public
 *   • gates everything behind a PIN + signed session cookie
 *   • binds the VNC port to localhost only and proxies it over one WebSocket
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const config = require('./lib/config');
const auth = require('./lib/auth');
const vnc = require('./lib/vnc');
const system = require('./lib/system');
const ws = require('./lib/ws');
const logbuf = require('./lib/logbuf');
const diagnostics = require('./lib/diagnostics');
const pad = require('./lib/pad');
const keyboard = require('./lib/keyboard');
const { log } = logbuf;

const PUBLIC_DIR = path.join(__dirname, 'public');
const TLS_DIR = path.join(config.DATA_DIR, 'tls');
const startedAt = Date.now();

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flags.has('--help') || flags.has('-h')) {
  process.stdout.write(`
${config.APP_NAME} ${config.VERSION} — see and control your PC from your phone

Usage: node server.js [options]

Options:
  --port <n>         Port to listen on            (default: 8765, saved in config)
  --bind <addr>      Interface to bind            (default: 0.0.0.0)
  --tls              Serve over HTTPS with a self-signed certificate
  --no-tls           Serve over plain HTTP        (default)
  --set-pin <pin>    Set/Change the access PIN from the terminal
  --pair             Print a pairing URL + QR code and exit
  --print-pair       Same, but after the server starts
  --doctor           Check the machine and report what is missing
  --report           Full self-test (including the WebSocket proxy) and exit
  --version          Print version
  --help             Show this help

Config file: ${config.CONFIG_PATH}
`);
  process.exit(0);
}
if (flags.has('--version')) {
  process.stdout.write(config.VERSION + '\n');
  process.exit(0);
}

if (flagValue('--set-pin')) {
  const pin = flagValue('--set-pin');
  try {
    auth.setPin(pin);
    process.stdout.write(`PIN set. Config: ${config.CONFIG_PATH}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Could not set PIN: ${err.message}\n`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function primaryUrl({ scheme = 'http', port = config.load().port } = {}) {
  const ips = localAddresses();
  const host = ips[0] || os.hostname();
  return `${scheme}://${host}:${port}`;
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Sessions can arrive three ways: cookie, Authorization header, ?t= query.
 *  Cookies are the normal path; the header keeps the app working in embedded
 *  views (sandboxed iframes) and for anyone browsing with cookies disabled. */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function sessionFor(req, url) {
  return auth.getSession(req)
    || auth.verifyToken(bearerToken(req))
    || auth.verifyToken(url?.searchParams?.get('t') || null);
}

/** Origins the app accepts from a browser: this host, the platform preview, and the opaque origin of a sandboxed frame. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return true;
  if (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`) return true;
  return /^https:\/\/[a-z0-9-]+\.e2b\.app$/i.test(origin);
}

/** CORS for the platform preview iframe (opaque origin) — narrow on purpose. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const sameHost = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  const preview = /^https:\/\/[a-z0-9-]+\.e2b\.app$/i.test(origin);
  if (!sameHost && !preview && origin !== 'null') return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

const ERROR_HINTS = [
  [/\bENOENT\b/, 'File or command not found'],
  [/\bECONNREFUSED\b/, 'Connection refused — is the service running?'],
  [/\bEACCES\b/, 'Permission denied'],
];

function fail(res, err) {
  const status = err.statusCode || 500;
  let message = err?.message || String(err);
  for (const [re, hint] of ERROR_HINTS) {
    if (re.test(message)) {
      message = message.replace(/\s*[A-Z]*:?\s*/, ' ') + ` (${hint})`;
      break;
    }
  }
  if (status >= 500) console.error('[error]', err);
  json(res, status, { ok: false, error: message, hint: err.hint });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let filePath = path.resolve(PUBLIC_DIR, rel || 'index.html');
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { ok: false, error: 'Forbidden' });
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA-ish fallback for unknown paths
  }
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return json(res, 404, { ok: false, error: 'Not found' });
  }
  const ext = path.extname(filePath).toLowerCase();
  const immutable = /\/(vendor|icons)\//.test(filePath) || ext === '.png';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': immutable ? 'public, max-age=604800' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(data);
}

/* ------------------------------------------------------------------ *
 * TLS (optional, needed for clipboard + fullscreen on LAN IPs)
 * ------------------------------------------------------------------ */

function ensureCertificate() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const keyPath = path.join(TLS_DIR, 'key.pem');
  const certPath = path.join(TLS_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const ips = ['127.0.0.1', ...localAddresses()];
  const san = ['DNS:localhost', 'DNS:' + os.hostname(), ...ips.map((ip) => `IP:${ip}`)].join(',');
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-subj', '/CN=pocket-desktop',
    '-addext', `subjectAltName=${san}`,
  ], { encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(certPath)) {
    throw new Error(`Could not create a self-signed certificate (openssl): ${res.stderr || res.error}`);
  }
  fs.chmodSync(keyPath, 0o600);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const PAIR_TOKEN_TTL = 10 * 60 * 1000;

function pairingUrl(req, token) {
  const scheme = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || `${localAddresses()[0] || 'localhost'}:${config.load().port}`;
  return `${scheme}://${host}/?t=${token}`;
}

function qrSvg(text) {
  const qrcode = require('./public/vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true, alt: 'Pairing QR code' });
}

const routes = {
  'GET /api/ping': (ctx) => json(ctx.res, 200, { ok: true, pong: Date.now() }),

  'POST /api/restart': (ctx) => {
    log.warn('app: restart requested from the phone', {
      peer: ctx.req.socket.remoteAddress,
      manager: process.env.INVOCATION_ID ? 'systemd' : 'foreground',
    });
    json(ctx.res, 200, {
      ok: true,
      restarting: true,
      version: config.VERSION,
      supervised: Boolean(process.env.INVOCATION_ID || process.env.POCKET_DESKTOP_SUPERVISED),
      hint: process.env.INVOCATION_ID
        ? 'The service will come back in a couple of seconds.'
        : 'This process was started by hand, so it will exit — start it again with ./run.sh',
    });
    // hand the response to the socket before dying
    setTimeout(() => process.exit(0), 250);
  },

  'POST /api/vnc/restart': async (ctx) => {
    const stopped = await vnc.stop();
    const result = await vnc.start();
    json(ctx.res, result.ok ? 200 : 503, {
      ok: result.ok,
      result,
      displaced: stopped?.displaced || null,
      data: await vnc.status(),
    });
  },

  'GET /api/pad/status': (ctx) => {
    json(ctx.res, 200, { ok: true, data: pad.status() });
  },

  'POST /api/pad/start': async (ctx) => {
    const result = await pad.start();
    json(ctx.res, result.ok ? 200 : 503, { ok: result.ok, ...result, data: pad.status() });
  },

  'POST /api/pad/stop': (ctx) => {
    pad.stop();
    json(ctx.res, 200, { ok: true, data: pad.status() });
  },

  'GET /api/logs': (ctx) => {
    const limit = Number(ctx.query.get('limit') || 200);
    const contains = ctx.query.get('contains') || undefined;
    json(ctx.res, 200, { ok: true, data: logbuf.recent({ limit, contains }) });
  },

  'GET /api/diagnostics': async (ctx) => {
    const report = await diagnostics.run({ req: ctx.req, logbuf });
    json(ctx.res, 200, { ok: true, data: report });
  },

  'GET /api/auth': (ctx) => {
    const session = sessionFor(ctx.req, ctx.url);
    const cfg = config.load();
    json(ctx.res, 200, {
      ok: true,
      configured: auth.hasPin(),
      authed: Boolean(session),
      name: cfg.name,
      host: os.hostname(),
      user: os.userInfo().username,
      version: config.VERSION,
      deviceId: session?.d || null,
      tls: Boolean(ctx.req.socket.encrypted),
      secureContext: Boolean(ctx.req.socket.encrypted),
    });
  },

  'POST /api/setup': async (ctx) => {
    if (auth.hasPin()) {
      return json(ctx.res, 409, { ok: false, error: 'A PIN is already set. Use /api/login.' });
    }
    const body = await readBody(ctx.req);
    try {
      auth.validatePinFormat(body.pin);
    } catch (err) {
      return fail(ctx.res, err);
    }
    auth.setPin(body.pin);
    const patch = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 48);
    if (Object.keys(patch).length) config.save(patch);
    const session = auth.createSession({ d: crypto_id() });
    ctx.res.setHeader('Set-Cookie', auth.sessionCookie(session, { secure: Boolean(ctx.req.socket.encrypted) }));
    json(ctx.res, 200, { ok: true, token: session.token });
  },

  'POST /api/login': async (ctx) => {
    const cfg = config.load();
    if (!auth.hasPin()) return json(ctx.res, 428, { ok: false, error: 'Setup required', setup: true });
    auth.checkRateLimit(ctx.req);
    const body = await readBody(ctx.req);
    if (!auth.verifyPin(body.pin, cfg.pinSalt, cfg.pinHash)) {
      const rec = auth.recordFailure(ctx.req);
      return json(ctx.res, 401, { ok: false, error: 'Wrong PIN', attempts: rec.count });
    }
    auth.clearFailures(ctx.req);
    const session = auth.createSession({ d: crypto_id() });
    ctx.res.setHeader('Set-Cookie', auth.sessionCookie(session, { secure: Boolean(ctx.req.socket.encrypted) }));
    json(ctx.res, 200, { ok: true, token: session.token });
  },

  'POST /api/logout': (ctx) => {
    ctx.res.setHeader('Set-Cookie', auth.clearCookie());
    json(ctx.res, 200, { ok: true });
  },

  'POST /api/pair': async (ctx) => {
    const body = await readBody(ctx.req);
    if (body.revoke) return json(ctx.res, 200, { ok: true, revoked: true });
    const token = auth.sign({ t: 'pair', exp: Date.now() + PAIR_TOKEN_TTL, iat: Date.now() });
    const url = pairingUrl(ctx.req, token);
    json(ctx.res, 200, { ok: true, token, url, svg: qrSvg(url), expiresIn: PAIR_TOKEN_TTL });
  },

  'POST /api/pair/consume': async (ctx) => {
    const body = await readBody(ctx.req);
    const data = auth.verifyToken(body.token);
    if (!data || data.t !== 'pair') {
      return json(ctx.res, 401, { ok: false, error: 'This pairing link has expired. Ask for a new QR code.' });
    }
    const session = auth.createSession({ d: crypto_id(), paired: true });
    ctx.res.setHeader('Set-Cookie', auth.sessionCookie(session, { secure: Boolean(ctx.req.socket.encrypted) }));
    json(ctx.res, 200, { ok: true, token: session.token });
  },

  'GET /api/qr.svg': (ctx) => {
    const token = ctx.query.get('t');
    if (!token) return json(ctx.res, 400, { ok: false, error: 'Missing token' });
    const url = pairingUrl(ctx.req, token);
    const svg = qrSvg(url);
    ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    ctx.res.end(svg);
  },

  'POST /api/keyboard': async (ctx) => {
    const result=await keyboard.send(await readBody(ctx.req));
    json(ctx.res,result.ok?200:(result.status||503),result);
  },

  'GET /api/sysinfo': async (ctx) => json(ctx.res, 200, { ok: true, data: await system.info() }),

  'GET /api/vnc/status': async (ctx) => json(ctx.res, 200, { ok: true, data: await vnc.status() }),

  'POST /api/vnc/start': async (ctx) => {
    const result = await vnc.start();
    const status = await vnc.status();
    json(ctx.res, result.ok ? 200 : 503, { ok: result.ok, result, data: status });
  },

  'POST /api/vnc/stop': async (ctx) => {
    const result = await vnc.stop();
    json(ctx.res, 200, { ok: result.ok, data: await vnc.status() });
  },

  'POST /api/vnc/password': async (ctx) => {
    const body = await readBody(ctx.req);
    if (body.password && !/^.{4,8}$/.test(String(body.password))) {
      return json(ctx.res, 400, { ok: false, error: 'VNC passwords must be 4-8 characters (legacy protocol limit).' });
    }
    if (!body.password) {
      config.save({ vnc: { password: null } });
      return json(ctx.res, 200, { ok: true, disabled: true });
    }
    const result = await vnc.setPassword(body.password);
    if (!result.ok) return json(ctx.res, 500, { ok: false, error: result.error });
    // restart x11vnc so the new password takes effect immediately
    await vnc.stop();
    await vnc.start();
    json(ctx.res, 200, { ok: true, restarted: true });
  },

  'GET /api/screenshot': async (ctx) => {
    const shot = await system.screenshot();
    if (!shot.ok) return json(ctx.res, 503, { ok: false, error: shot.error });
    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': shot.data.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="screenshot-${Date.now()}.png"`,
    });
    ctx.res.end(shot.data);
  },

  'POST /api/power': async (ctx) => {
    const body = await readBody(ctx.req);
    const result = await system.power(body.action);
    json(ctx.res, result.ok ? 200 : 500, result);
  },

  'GET /api/config': (ctx) => {
    const cfg = config.load();
    json(ctx.res, 200, {
      ok: true,
      data: { name: cfg.name, quality: cfg.quality, ptt: cfg.ptt, vnc: { host: cfg.vnc.host, port: cfg.vnc.port, password: cfg.vnc.password || null } },
    });
  },

  'POST /api/config': async (ctx) => {
    const body = await readBody(ctx.req);
    const patch = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 48);
    if (typeof body.quality === 'string' && ['sharp', 'balanced', 'fast'].includes(body.quality)) patch.quality = body.quality;
    if (body.ptt && typeof body.ptt === 'object') {
      const p = {};
      if (typeof body.ptt.key === 'string') p.key = body.ptt.key.slice(0, 24);
      if (typeof body.ptt.device === 'string') p.device = body.ptt.device.slice(0, 64);
      patch.ptt = p;
    }
    if (typeof body.vncPassword === 'string') {
      const p = { vnc: {} };
      if (!body.vncPassword) p.vnc.password = null;
      else p.vnc.password = body.vncPassword.slice(0, 8);
      patch.vnc = { ...(patch.vnc || {}), ...p.vnc };
    }
    config.save(patch);
    json(ctx.res, 200, { ok: true, data: config.load() });
  },

  'POST /api/ptt/start': async (ctx) => json(ctx.res, 200, await system.pttStart()),
  'POST /api/ptt/stop': async (ctx) => {
    const body = await readBody(ctx.req);
    json(ctx.res, 200, await system.pttStop({ play: body.play !== false }));
  },
  'POST /api/ptt/cancel': async (ctx) => json(ctx.res, 200, await system.pttCancel()),
  'GET /api/ptt/state': (ctx) => json(ctx.res, 200, { ok: true, ...system.pttState() }),
};

function crypto_id() {
  return require('crypto').randomBytes(8).toString('hex');
}

/* ------------------------------------------------------------------ *
 * WebSocket proxy: browser  ⇄  localhost VNC
 * ------------------------------------------------------------------ */

function handleWebSocket(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const session = sessionFor(req, url);

  if (!session) {
    log.warn('ws: rejected unauthenticated upgrade', { peer, hasCookie: Boolean(req.headers.cookie), token: url.searchParams.has('t') });
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  const cfg = config.load();
  const client = ws.accept(req, socket, head, { maxMessage: 32 * 1024 * 1024 });
  if (!client) {
    log.warn('ws: handshake failed', { peer });
    return;
  }
  log.info('ws: client connected', { peer, origin: req.headers.origin || null });

  let vncSocket = null;
  let closed = false;
  let bytesToClient = 0;
  let bytesToPc = 0;
  let vncPaused = false;
  let clientPaused = false;
  let stalls = 0;        // times the phone fell behind and we paused the PC
  let maxBuffered = 0;   // deepest the phone's send buffer got

  // Backpressure in both directions. The important detail: a paused source can
  // only be woken by the *other* side draining, never by the paused path
  // itself — otherwise (once the stream stops) nothing ever resumes it and the
  // session wedges forever. That bug looked like "Connecting…" on the phone.
  const pauseVnc = () => {
    if (!vncSocket || vncPaused) return;
    vncPaused = true;
    stalls += 1;
    try { vncSocket.pause(); } catch { /* ignore */ }
  };
  const resumeVnc = () => { if (vncSocket && vncPaused) { vncPaused = false; try { vncSocket.resume(); } catch { /* ignore */ } } };
  const pauseClient = () => { if (!clientPaused) { clientPaused = true; try { client.socket.pause(); } catch { /* ignore */ } } };
  const resumeClient = () => { if (clientPaused) { clientPaused = false; try { client.socket.resume(); } catch { /* ignore */ } } };

  const closeAll = (code, reason) => {
    if (closed) return;
    closed = true;
    try { vncSocket?.destroy(); } catch { /* ignore */ }
    try {
      if (!client.closed) client.close(code, reason);
      else client.destroy();
    } catch { /* ignore */ }
    log.info('ws: closed', {
      peer, code, reason, toClient: bytesToClient, toPc: bytesToPc,
      ms: Date.now() - t0, stalls, maxBufferedKB: Math.round(maxBuffered / 1024),
    });
  };
  const t0 = Date.now();

  const openVnc = (attempt = 1) => {
    vncSocket = net.connect(cfg.vnc.port, cfg.vnc.host);
    vncSocket.setNoDelay(true);
    vncSocket.on('connect', () => {
      if (attempt > 1) log.info('ws: VNC reachable', { attempt });
      // phone → PC, with backpressure towards the phone
      client.on('message', (buf) => {
        if (!vncSocket.writable) return;
        bytesToPc += buf.length;
        if (!vncSocket.write(buf)) {
          pauseClient();                       // the PC cannot take more yet
          vncSocket.once('drain', resumeClient);
        }
      });
      resumeVnc();                             // a reconnect starts flowing
      client.socket.on('drain', resumeVnc);    // phone caught up → feed it again
    });
    vncSocket.on('data', (buf) => {
      bytesToClient += buf.length;
      if (!client.closed) client.send(buf, { binary: true });
      const buffered = client.bufferedAmount;
      if (buffered > maxBuffered) maxBuffered = buffered;
    });
    vncSocket.on('error', async (err) => {
      log.warn('ws: VNC connection error', { peer, code: err.code, message: err.message, attempt });
      if (attempt < 3 && !closed) {
        // The screen server may still be starting (or restarting) — try again.
        setTimeout(() => { if (!closed) openVnc(attempt + 1); }, 500 * attempt);
        return;
      }
      if (!closed) {
        // last resort: ask the VNC layer to start x11vnc, then retry once
        const started = await vnc.start().catch(() => ({ ok: false }));
        if (started.ok && !closed) {
          log.info('ws: started x11vnc on demand', { peer, via: started.via });
          setTimeout(() => { if (!closed) openVnc(1); }, 400);
          return;
        }
        closeAll(1011, 'screen server unavailable');
      }
    });
    vncSocket.on('close', () => {
      if (closed) return;
      // A screen server that answers the handshake and then hangs up having
      // sent almost nothing is not one this app manages (another VNC tool, or
      // an x11vnc attached to a dead display). Say so plainly — the old message
      // ("screen server closed the connection") told the user nothing.
      const handshakeOnly = bytesToClient > 0 && bytesToClient < 4096;
      closeAll(1000, handshakeOnly
        ? 'screen server hung up during the handshake — fixing it automatically'
        : 'screen server closed the connection');
      if (handshakeOnly) {
        // Do not await: the phone is already gone; it will reconnect in a moment
        // and find a working server.
        healScreenServer(`handshake hangup after ${bytesToClient} bytes`).catch((err) => {
          log.error('app: could not replace the screen server', { message: err.message });
        });
      }
    });
  };

  // Bounded memory: if the phone is slow, stop pulling from the PC.
  // onbackpressure only ever *pauses*; only the socket's 'drain' event can
  // resume, so a wedged stream is impossible.
  client.onbackpressure = (congested) => {
    if (congested) pauseVnc();
  };

  client.on('close', (code, reason) => {
    if (!closed) {
      log.info('ws: client closed', { peer, code, reason, toClient: bytesToClient, toPc: bytesToPc });
      closeAll(null, null);
    }
  });
  client.on('error', (err) => {
    log.warn('ws: client socket error', { peer, message: err.message });
    closeAll(1011, 'client error');
  });
  socket.on('error', () => closeAll(1011, 'socket error'));

  openVnc();
}

/* ------------------------------------------------------------------ *
 * Control channel — gamepad, motion mouse, clicks (JSON over /wsctl)
 * ------------------------------------------------------------------ */

const CONTROL_MAX_PER_SEC = 400;   // generous headroom, still bounded

function handleControlSocket(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const session = sessionFor(req, url);
  if (!session) {
    log.warn('ctl: rejected unauthenticated upgrade', { peer });
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  const client = ws.accept(req, socket, head, { maxMessage: 64 * 1024 });
  if (!client) return;
  log.info('ctl: client connected', { peer });

  let windowStart = Date.now();
  let windowCount = 0;
  const pulses=new Map(),requestedButtons=new Set();

  client.on('message', (buf, isBinary) => {
    if (isBinary) return;                      // control channel is JSON text
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
    if (++windowCount > CONTROL_MAX_PER_SEC) return;   // drop, never crash

    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    const ack = ok => { if(Number.isSafeInteger(msg.id))client.send(JSON.stringify({t:'ack',id:msg.id,event:msg.t,button:msg.b,ok:Boolean(ok)}),{binary:false}); };
    if(msg.t==='click' && ['left','right','middle'].includes(msg.b)) {
      // A 60ms PC-side pulse remains visible to frame-polled applications even
      // when network delivery coalesces messages. Never use this path for drags.
      if(pulses.has(msg.b)||requestedButtons.has(msg.b)){ack(false);return;}
      const down=pad.mouseButton(msg.b,true);
      if(!down){ack(false);return;}
      pulses.set(msg.b,setTimeout(()=>{
        pulses.delete(msg.b);
        const up=requestedButtons.has(msg.b)||pad.mouseButton(msg.b,false);
        ack(up);
      },60));
      return;
    }
    if(msg.t==='btn' && ['left','right','middle'].includes(msg.b)) {
      if(msg.d)requestedButtons.add(msg.b);else requestedButtons.delete(msg.b);
      ack(pad.mouseButton(msg.b,Boolean(msg.d)||pulses.has(msg.b)));return;
    }
    ack(applyControlMessage(msg, pad));
  });

  // A dead Wi-Fi link can leave TCP open for minutes. A short input lease
  // releases real buttons even when no close frame reaches the PC.
  let lastControlActivity = Date.now();
  client.on('message', () => { lastControlActivity = Date.now(); });
  const releaseInputs = () => {
    for(const timer of pulses.values())clearTimeout(timer);pulses.clear();requestedButtons.clear();
    pad.sendBatch([
      'a lx 0', 'a ly 0', 'a rx 0', 'a ry 0', 'a lt 0', 'a rt 0', 'a dx 0', 'a dy 0',
      'p a 0', 'p b 0', 'p x 0', 'p y 0', 'p lb 0', 'p rb 0', 'p lt 0', 'p rt 0',
      'p ls 0', 'p rs 0', 'p back 0', 'p start 0', 'p guide 0',
    ]);
    for (const b of ['left', 'right', 'middle']) pad.mouseButton(b, false);
  };
  const lease = setInterval(() => {
    if (Date.now() - lastControlActivity > 3500) {
      releaseInputs(); clearInterval(lease);
      client.close(1001, 'input heartbeat expired');
    }
  }, 500);
  lease.unref();
  client.on('close', (code) => {
    clearInterval(lease); releaseInputs();
    log.info('ctl: closed', { peer, code });
  });
  client.on('error', (err) => log.warn('ctl: socket error', { peer, message: err.message }));
}

function applyControlMessage(msg, pad) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'ping':
      return;

    case 'pad': {
      // One frame of controller state: { a: {lx, ly, …}, b: {a: 1, b: 0, …} }
      const commands = [];
      if (msg.a && typeof msg.a === 'object') {
        for (const [axis, value] of Object.entries(msg.a)) {
          const limit = { lx: 32767, ly: 32767, rx: 32767, ry: 32767, lt: 255, rt: 255, dx: 1, dy: 1 }[axis];
          if (limit === undefined) continue;
          const v = Math.max(axis === 'lt' || axis === 'rt' ? 0 : -limit, Math.min(limit, Math.round(Number(value) || 0)));
          commands.push(`a ${axis} ${v}`);
        }
      }
      if (msg.b && typeof msg.b === 'object') {
        const names = new Set(['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'guide', 'ls', 'rs']);
        for (const [button, down] of Object.entries(msg.b)) {
          if (!names.has(button)) continue;
          commands.push(`p ${button} ${down ? 1 : 0}`);
        }
      }
      if (commands.length) pad.sendBatch(commands);
      return;
    }

    case 'ptr':
      return pad.mouseMove(msg.dx, msg.dy);

    case 'btn':
      if (['left', 'middle', 'right', '1', '2', '3'].includes(msg.b)) {
        pad.mouseButton(msg.b, msg.d ? 1 : 0);
      }
      return;

    case 'wheel':
      return pad.wheel(msg.d);

    default:
      return;
  }
}

/* ------------------------------------------------------------------ *
 * Request handler
 * ------------------------------------------------------------------ */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'self'",
  // deliberately no frame-ancestors: the session cookie is SameSite=Strict, so
  // an embedded copy only ever shows the login screen.
].join('; ');

const warnedClients = new Set();

/**
 * Self-heal: a screen server that answers the handshake and then hangs up is of
 * no use to the phone. This usually means it wants a password, or it is some
 * other program's server that cannot serve this display.
 *
 * Rather than telling the user to debug it, put a server we control on the
 * port — and if the port is genuinely taken by something that keeps coming
 * back (a systemd service with Restart=always), move to a free port instead.
 */
let lastHealAt = 0;
const HEAL_COOLDOWN_MS = 60000;

async function healScreenServer(trigger) {
  const now = Date.now();
  if (now - lastHealAt < HEAL_COOLDOWN_MS) return false;
  lastHealAt = now;

  const before = config.load().vnc.port;
  const victim = vnc.serverCommandLine(before);
  log.warn('app: replacing the screen server', {
    trigger,
    port: before,
    replacing: victim ? `${victim.binary} (pid ${victim.pid})` : 'nothing',
    reason: 'it refuses to serve the phone (usually it asks for a password)',
  });

  let result;
  try {
    await vnc.stop();
    result = await vnc.start();
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // Did we actually end up owning a server of our own?
  let owner = vnc.portOwner(before);
  if (!result.ok || (owner && !owner.ours)) {
    const free = await vnc.findFreePort(5910);
    if (free) {
      config.save({ vnc: { port: free, password: null } });
      log.warn('app: moving the screen server to a free port', { from: before, to: free });
      try {
        result = await vnc.start();
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      owner = vnc.portOwner(free);
    }
  }

  const port = config.load().vnc.port;
  log.info('app: screen server replaced', {
    ok: result.ok, via: result.via || null, port,
    managedByApp: owner ? owner.ours : null,
    command: vnc.serverCommandLine(port)?.cmd || null,
  });
  return result.ok;
}

async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Pocket-Server', config.VERSION);

  // A phone running newer files than this process is the classic "I updated but
  // nothing changed" trap (the old process keeps serving the new static files).
  const clientVersion = req.headers['x-pocket-client'];
  if (clientVersion && clientVersion !== config.VERSION && req.url.startsWith('/api/')) {
    const key = String(clientVersion);
    if (!warnedClients.has(key)) {
      warnedClients.add(key);
      log.warn('version mismatch: the browser has newer files than this process', {
        client: clientVersion, server: config.VERSION,
        fix: 'restart the service, or press "Restart server" in the app',
      });
    }
    res.setHeader('X-Pocket-Version-Mismatch', `${clientVersion} != ${config.VERSION}`);
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=()');

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // WebSocket upgrade target should never reach here (handled in 'upgrade')
  if (pathname === '/ws') {
    return json(res, 426, { ok: false, error: 'WebSocket endpoint — connect with a WebSocket client' });
  }

  const routeKey = `${req.method} ${pathname}`;
  const handler = routes[routeKey];
  if (handler) {
    const publicRoutes = new Set([
      'GET /api/ping',
      'GET /api/auth',
      'POST /api/setup',
      'POST /api/login',
      'POST /api/logout',
      'POST /api/pair/consume',
    ]);
    if (!publicRoutes.has(routeKey) && !sessionFor(req, url)) {
      return json(res, 401, { ok: false, error: 'Not signed in', login: true });
    }
    try {
      await handler({ req, res, url, query: url.searchParams });
    } catch (err) {
      fail(res, err);
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: `Unknown endpoint: ${routeKey}` });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }
  return serveStatic(req, res, pathname);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/**
 * At startup: if the screen server on the port asks for a password, the phone
 * will never get in, so replace it before anyone has to notice.
 */
async function ensureUsableScreenServer() {
  try {
    const cfg = config.load();
    if (!(await vnc.isPortOpen(cfg.vnc.host, cfg.vnc.port))) return;
    const probe = await diagnostics.probeVnc(cfg.vnc.host, cfg.vnc.port);
    if (probe.ok && probe.requiresPassword) {
      log.warn('app: the screen server asks for a password — replacing it before the phone tries', {
        port: cfg.vnc.port, security: probe.securityTypes,
      });
      await healScreenServer('startup check: password required');
    }
  } catch (err) {
    log.warn('app: startup screen-server check failed', { message: err.message });
  }
}

function buildServer() {
  const useTls = flags.has('--tls');
  const cfg = config.load();
  const scheme = useTls ? 'https' : 'http';
  const server = useTls
    ? https.createServer(ensureCertificate(), handleRequest)
    : http.createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // Cross-site pages must not open the control sockets with the user's cookie (defence in depth
    // on top of SameSite=Strict). Same host, the platform preview, sandboxed iframes ('null') and
    // non-browser clients (no Origin) are still allowed.
    if (!originAllowed(req)) {
      log.warn('ws: rejected cross-origin upgrade', { path: url.pathname, origin: req.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws' && url.pathname !== '/wsctl') {
      log.warn('ws: upgrade to unknown path', { path: url.pathname });
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/wsctl') {
      handleControlSocket(req, socket, head);
      return;
    }
    if (!ws.isUpgradeRequest(req)) {
      log.warn('ws: not a websocket upgrade');
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      handleWebSocket(req, socket, head);
    } catch (err) {
      log.error('ws: upgrade failed', { message: err.message, stack: String(err.stack || '').split('\n')[1] });
      try {
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      } catch { /* ignore */ }
      socket.destroy();
    }
  });

  // Long-lived WebSockets + slow phones: keep-alive with generous timeouts.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;

  return { server, scheme, cfg };
}

function banner({ server, scheme, cfg }) {
  const ip = localAddresses()[0] || 'localhost';
  const url = `${scheme}://${ip}:${cfg.port}`;
  const pin = auth.hasPin() ? 'set' : 'NOT SET — open the app in a browser to set one';
  const lines = [
    '',
    `  ${config.APP_NAME} ${config.VERSION}`,
    `  ────────────────────────────────────────────────`,
    `  On this PC     ${scheme}://localhost:${cfg.port}`,
    `  On your phone  ${url}`,
    `  Access PIN     ${pin}`,
    `  Config         ${config.CONFIG_PATH}`,
    `  Session type   ${vnc.detectSession().sessionType}${vnc.detectSession().wayland ? '  ⚠  x11vnc needs an X11 session' : ''}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
  if (flags.has('--print-pair')) printPair(url);
}

function printPair(baseUrl) {
  const qrcode = require('./public/vendor/qrcode.js');
  const token = auth.sign({ t: 'pair', exp: Date.now() + PAIR_TOKEN_TTL, iat: Date.now() });
  const url = `${baseUrl}/?t=${token}`;
  process.stdout.write(`\n  Scan to pair (valid 10 minutes):\n\n`);
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const modules = qr.getModuleCount();
    const pad = 1;
    const size = modules + pad * 2;
    const useAnsi = process.stdout.isTTY;
    let out = '';
    for (let y = 0; y < size; y += 1) {
      let line = '   ';
      for (let x = 0; x < size; x += 1) {
        const mx = x - pad;
        const my = y - pad;
        const dark = mx >= 0 && my >= 0 && mx < modules && my < modules && qr.isDark(my, mx);
        if (useAnsi) line += dark ? '\u2588\u2588' : '  ';
        else line += dark ? '##' : '  ';
      }
      out += line + '\n';
    }
    process.stdout.write(out);
  } catch { /* fall back to plain URL only */ }
  process.stdout.write(`  ${url}\n\n`);
}

function start() {
  const cfg = config.load();
  const port = Number(flagValue('--port') || process.env.POCKET_DESKTOP_PORT || cfg.port);
  const bind = flagValue('--bind') || process.env.POCKET_DESKTOP_BIND || cfg.bind;
  const patch = {};
  if (port !== cfg.port) patch.port = port;
  if (bind !== cfg.bind) patch.bind = bind;
  if (Object.keys(patch).length) config.save(patch);

  const built = buildServer();
  built.cfg = config.load();

  built.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${built.cfg.port} is already in use. Try: node server.js --port 8766\n`);
    } else {
      console.error('\n  Server error:', err.message, '\n');
    }
    process.exit(1);
  });

  built.server.listen(built.cfg.port, built.cfg.bind, async () => {
    banner(built);
    if (built.cfg.vnc.autostart && !auth.hasPin()) {
      process.stdout.write('  (VNC will start automatically once you set your PIN)\n\n');
    }
    if (built.cfg.vnc.autostart && auth.hasPin()) {
      const res = await vnc.start();
      if (!res.ok) {
        process.stdout.write(`  VNC: not running — ${res.error}\n\n`);
      } else {
        process.stdout.write(`  VNC: running (${res.via})\n\n`);
      }
      // A password-protected screen server would silently reject the phone, so
      // swap it out now rather than after the first failed connection.
      ensureUsableScreenServer().catch((err) => {
        log.warn('app: startup screen-server check failed', { message: err.message });
      });
    }
  });

  const shutdown = async (signal) => {
    process.stdout.write(`\n  Received ${signal}, shutting down…\n`);
    try { await system.pttCancel(); } catch { /* ignore */ }
    built.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return built;
}

async function report() {
  const out = await diagnostics.run({ logbuf });
  process.stdout.write('\n' + diagnostics.toText(out) + '\n\n');
  // probes leave sockets around; exit rather than waiting on them
  process.exit(out.checks.websocketProxy && out.checks.vncListening ? 0 : 1);
}

async function doctor() {
  const cfg = config.load();
  const tools = await vnc.toolsStatus();
  const session = vnc.detectSession();
  const status = await vnc.status();
  const rows = [
    ['Node.js', process.version, true],
    ['Config file', config.CONFIG_PATH, fs.existsSync(config.CONFIG_PATH)],
    ['Access PIN', auth.hasPin() ? 'set' : 'not set yet', auth.hasPin()],
    ['Session type', session.sessionType + (session.wayland ? ' (Wayland — needs Xorg for x11vnc)' : ''), !session.wayland],
    ['X display', `${session.display}${session.xSockets.length ? ` (sockets: ${session.xSockets.join(', ')})` : ' (no X sockets found)'}`, session.xSockets.length > 0],
    ['x11vnc', tools.x11vnc ? 'installed' : 'MISSING → sudo apt install x11vnc', Boolean(tools.x11vnc)],
    ['VNC listening', status.running ? `yes on ${status.host}:${status.port}` : 'no', status.running],
    ['xdotool', tools.xdotool ? 'installed' : 'optional → sudo apt install xdotool', true],
    ['arecord', tools.arecord ? 'installed' : 'optional (push-to-talk) → sudo apt install alsa-utils', true],
    ['screenshot tool', tools.screenshot || 'optional → sudo apt install gnome-screenshot', true],
    ['IPv4 addresses', localAddresses().join(', ') || 'none', localAddresses().length > 0],
  ];
  process.stdout.write(`\n  ${config.APP_NAME} — system check\n\n`);
  for (const [label, value, ok] of rows) {
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${label.padEnd(16)} ${value}\n`);
  }
  process.stdout.write('\n');
}

if (flags.has('--pair')) {
  const port = Number(flagValue('--port') || config.load().port);
  printPair(primaryUrl({ scheme: flags.has('--tls') ? 'https' : 'http', port }));
  process.exit(0);
}

if (flags.has('--report')) {
  report().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (flags.has('--doctor')) {
  doctor().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  start();
}

module.exports = { start, buildServer };
