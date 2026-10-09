#!/usr/bin/env node
'use strict';
/**
 * End-to-end API smoke test — talks to a running Pocket Desktop server.
 *
 *   node server.js --port 8765 &          # with a PIN already set
 *   node test/api-smoke.js [--pin 1234] [--port 8765]
 *
 * Checks: auth, session cookies, rate limiting, sysinfo, VNC lifecycle,
 * screenshots, pairing tokens, QR rendering, static assets and the
 * WebSocket proxy (which must return a real RFB greeting).
 */

const http = require('http');
const net = require('net');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', process.env.PORT || 8765));
const PIN = getArg('--pin', process.env.PIN || '1234');
const HOST = getArg('--host', '127.0.0.1');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function request(method, urlPath, { body, cookie, raw = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      method,
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        let json = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(res) {
  const header = res.headers['set-cookie'];
  if (!header) return null;
  return header.map((c) => c.split(';')[0]).join('; ');
}

// eslint-disable-next-line no-unused-vars
function waitForPort(port, host, timeout = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const fin = (buf[0] & 0x80) !== 0;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + len) return null;
  return { opcode, fin, masked, length: len, payload: buf.subarray(offset, offset + len) };
}

/** Raw WebSocket handshake + first frame from the VNC server. */
function probeWebSocket(cookie, query = '') {
  return new Promise((resolve) => {
    const key = Buffer.from('pocket-desktop-test-key').toString('base64');
    const req = http.request({
      host: HOST,
      port: PORT,
      path: '/ws' + query,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    req.on('upgrade', (res, socket, head) => {
      // Frames arrive whole or split across segments: parse the RFC 6455 frame
      // header (server frames are unmasked) before looking at the payload.
      let buf = Buffer.alloc(0);
      const finish = () => {
        socket.destroy();
        const parsed = parseFrame(buf);
        done({ status: res.statusCode, greeting: parsed?.payload?.toString('latin1').slice(0, 16) || null, frame: parsed });
      };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const parsed = parseFrame(buf);
        if (parsed) finish();
      };
      if (head && head.length) onData(head);
      socket.on('data', onData);
      const first = socket.read();
      if (first) onData(first);
      setTimeout(finish, 2500);
    });
    req.on('response', (res) => {
      res.resume();
      done({ status: res.statusCode, greeting: null, rejected: true });
    });
    req.on('error', (err) => done({ error: err.message }));
    req.end();
  });
}

(async function main() {
  console.log(`\nPocket Desktop API smoke test → http://${HOST}:${PORT}\n`);

  // ── static shell ───────────────────────────────────────────────
  const index = await request('GET', '/', { raw: true });
  check('serves the app shell', index.status === 200 && /Pocket Desktop/.test(index.body.toString()));
  check('sets a content security policy', Boolean(index.headers['content-security-policy']));

  const manifest = await request('GET', '/manifest.webmanifest', { raw: true });
  check('serves the web app manifest', manifest.status === 200 && /Pocket Desktop/.test(manifest.body.toString()));

  const appJs = await request('GET', '/assets/app.js', { raw: true });
  check('serves app.js', appJs.status === 200 && appJs.body.length > 1000);

  const rfb = await request('GET', '/vendor/novnc/core/rfb.js', { raw: true });
  check('serves vendored noVNC', rfb.status === 200 && /RFB/.test(rfb.body.toString()));

  const icon = await request('GET', '/icons/icon-192.png', { raw: true });
  check('serves icons', icon.status === 200 && icon.body.slice(1, 4).toString() === 'PNG');

  // ── auth ───────────────────────────────────────────────────────
  const auth0 = await request('GET', '/api/auth');
  check('reports configuration state', auth0.json?.configured === true);
  check('starts unauthenticated', auth0.json?.authed === false);

  const blocked = await request('GET', '/api/sysinfo');
  check('blocks private endpoints without a session', blocked.status === 401);

  const badLogin = await request('POST', '/api/login', { body: { pin: '0000' } });
  check('rejects a wrong PIN', badLogin.status === 401);

  const login = await request('POST', '/api/login', { body: { pin: PIN } });
  const cookie = cookieFrom(login);
  check('accepts the correct PIN', login.status === 200 && Boolean(cookie));
  check('session cookie is HttpOnly + SameSite=Strict',
    /HttpOnly/.test(login.headers['set-cookie']?.[0] || '') && /SameSite=Strict/.test(login.headers['set-cookie']?.[0] || ''));

  const auth1 = await request('GET', '/api/auth', { cookie });
  check('session authenticates later requests', auth1.json?.authed === true);

  // ── cookie-less access (embedded views, cookies disabled) ──────
  const bearer = login.json?.token;
  check('login returns a bearer token', typeof bearer === 'string' && bearer.includes('.'));
  const viaHeader = await request('GET', '/api/sysinfo', { headers: { Authorization: `Bearer ${bearer}` } });
  check('bearer header authenticates without a cookie', viaHeader.status === 200 && Boolean(viaHeader.json?.data?.hostname));

  const badBearer = await request('GET', '/api/sysinfo', { headers: { Authorization: 'Bearer nope.nope' } });
  check('forged bearer token is rejected', badBearer.status === 401);

  const preflight = await request('OPTIONS', '/api/sysinfo', { headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  check('CORS preflight is answered for sandboxed iframes',
    preflight.status === 204 && preflight.headers['access-control-allow-origin'] === 'null',
    `status ${preflight.status}, allow-origin ${preflight.headers['access-control-allow-origin']}`);

  const foreignOrigin = await request('OPTIONS', '/api/sysinfo', { headers: { Origin: 'https://evil.example' } });
  check('CORS stays closed for unknown origins', !foreignOrigin.headers['access-control-allow-origin']);

  const wsViaToken = await probeWebSocket(null, `?t=${encodeURIComponent(bearer)}`);
  check('websocket accepts the bearer token in the URL', /^RFB \d{3}\.\d{3}/.test(wsViaToken.greeting || ''), wsViaToken.greeting?.trim() || String(wsViaToken.error || ''));

  // ── pairing ────────────────────────────────────────────────────
  const pair = await request('POST', '/api/pair', { cookie, body: {} });
  check('mints a pairing link', pair.json?.ok === true && /^http/.test(pair.json?.url || ''));
  check('renders a QR svg', /<svg/.test(pair.json?.svg || ''));

  const pairQr = await request('GET', `/api/qr.svg?t=${encodeURIComponent(pair.json.token)}`, { raw: true, cookie });
  check('serves the QR as an image', pairQr.status === 200 && pairQr.body.toString().startsWith('<svg'));

  const consume = await request('POST', '/api/pair/consume', { body: { token: pair.json.token } });
  check('pairing link signs a device in', consume.status === 200 && Boolean(cookieFrom(consume)));

  const staleToken = await request('POST', '/api/pair/consume', { body: { token: 'nope.nope' } });
  check('rejects a forged pairing token', staleToken.status === 401);

  // ── diagnostics + logs ─────────────────────────────────────────
  const diag = await request('GET', '/api/diagnostics', { cookie });
  const d = diag.json?.data;
  check('diagnostics endpoint reports checks', diag.status === 200 && Boolean(d?.checks));
  check('diagnostics confirms the WebSocket proxy end to end', d?.checks?.websocketProxy === true,
    d?.vnc?.websocketProxy?.ok ? `${d.vnc.websocketProxy.greeting} in ${d.vnc.websocketProxy.ms} ms` : String(d?.vnc?.websocketProxy?.error));
  check('diagnostics names the session and tools', Boolean(d?.machine?.session) && Boolean(d?.vnc?.tools));
  check('diagnostics excludes secrets', !JSON.stringify(d).includes('pinHash') && !JSON.stringify(d).includes('tokenSecret'));

  const logs = await request('GET', '/api/logs?limit=50', { cookie });
  check('log endpoint serves recent events', logs.status === 200 && Array.isArray(logs.json?.data));

  const diagNoAuth = await request('GET', '/api/diagnostics');
  check('diagnostics needs a session', diagNoAuth.status === 401);

  // ── system info ────────────────────────────────────────────────
  const sysinfo = await request('GET', '/api/sysinfo', { cookie });
  const info = sysinfo.json?.data;
  check('returns system info', sysinfo.status === 200 && Boolean(info?.hostname));
  check('reports CPU + memory', typeof info?.cpuCount === 'number' && typeof info?.memory?.total === 'number');
  check('reports disk usage', typeof info?.disk?.percent === 'number');

  // ── VNC lifecycle ──────────────────────────────────────────────
  const vncStart = await request('POST', '/api/vnc/start', { cookie, body: {} });
  const vncUp = vncStart.json?.ok === true;
  check('starts x11vnc', vncUp, vncStart.json?.result?.result?.error || vncStart.json?.result?.via || '');
  check('VNC listens on localhost:5900 only', await waitForPort(5900, '127.0.0.1'));

  const status = await request('GET', '/api/vnc/status', { cookie });
  check('reports VNC status', status.json?.data?.running === true && status.json?.data?.host === '127.0.0.1');

  // ── websocket proxy ────────────────────────────────────────────
  const wsNoAuth = await probeWebSocket(null);
  check('websocket rejects unauthenticated clients', wsNoAuth.status === 401 || wsNoAuth.rejected === true);

  const wsAuth = await probeWebSocket(cookie);
  check('websocket frames the VNC greeting as binary', wsAuth.frame?.opcode === 2 && wsAuth.frame?.masked === false,
    wsAuth.frame ? `opcode 0x${wsAuth.frame.opcode.toString(16)}, ${wsAuth.frame.length} bytes` : String(wsAuth.error || ''));
  check('websocket proxies the VNC handshake', /^RFB \d{3}\.\d{3}/.test(wsAuth.greeting || ''), wsAuth.greeting?.trim() || String(wsAuth.error || ''));

  // ── screenshot ─────────────────────────────────────────────────
  const shot = await request('GET', '/api/screenshot', { cookie, raw: true });
  check('captures a screenshot', shot.status === 200 && shot.body.slice(1, 4).toString() === 'PNG', `${(shot.body.length / 1024).toFixed(0)} KB`);
  if (shot.status !== 200) {
    const msg = await request('GET', '/api/screenshot', { cookie });
    console.log('      screenshot said:', msg.json?.error);
  }

  // ── config ─────────────────────────────────────────────────────
  const cfgGet = await request('GET', '/api/config', { cookie });
  check('exposes settings', typeof cfgGet.json?.data?.name === 'string');

  const cfgSet = await request('POST', '/api/config', { cookie, body: { name: 'Smoke Test PC', quality: 'fast' } });
  check('saves settings', cfgSet.json?.ok === true && cfgSet.json?.data?.name === 'Smoke Test PC');
  await request('POST', '/api/config', { cookie, body: { name: info.hostname, quality: 'balanced' } });

  // ── power (must fail loudly, not silently succeed, in a sandbox) ──
  const power = await request('POST', '/api/power', { cookie, body: { action: 'lock' } });
  check('power endpoint answers', power.status === 200 || power.status === 500, power.json?.ok ? 'succeeded' : 'reported: ' + String(power.json?.error || '').slice(0, 60));

  // ── rate limiting ──────────────────────────────────────────────
  let sawRateLimit = false;
  for (let i = 0; i < 10; i += 1) {
    const r = await request('POST', '/api/login', { body: { pin: '9999' } });
    if (r.status === 429) {
      sawRateLimit = true;
      break;
    }
  }
  check('locks out brute-force attempts', sawRateLimit);
  if (sawRateLimit) {
    console.log('      note: this IP is now rate-limited for ~30s (progressive lockout)');
  }

  // ── logout ─────────────────────────────────────────────────────
  const logout = await request('POST', '/api/logout', { cookie, body: {} });
  check('clears the session cookie', /Max-Age=0/.test(logout.headers['set-cookie']?.[0] || ''));

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  console.log('  all good\n');
})().catch((err) => {
  console.error('\n  test harness error:', err);
  process.exit(2);
});
