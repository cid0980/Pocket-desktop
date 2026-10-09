'use strict';
/**
 * Self-test: checks the whole chain from the PC's point of view and produces a
 * copy-pasteable report. Used by `GET /api/diagnostics` and the "Copy
 * diagnostics" button in Settings, and by `node server.js --doctor --report`.
 *
 * The interesting check is `websocketProxy`: it opens a real WebSocket through
 * this very server (raw HTTP upgrade, our own frame parser) and reads the RFB
 * greeting back — i.e. exactly what the phone does, minus the phone.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const auth = require('./auth');
const config = require('./config');
const vnc = require('./vnc');
const pad = require('./pad');

const TIMEOUT = 6000;

/** TCP connect + read the first bytes of the RFB greeting. */
const SECURITY_NAMES = {
  1: 'none', 2: 'VNC password', 5: 'RA2', 6: 'RA2ne', 16: 'Tight', 18: 'TLS',
  19: 'VeNCrypt', 20: 'SASL', 30: 'Diffie-Hellman', 35: 'RSA-AES',
};

/**
 * Probe the screen server all the way through the RFB handshake.
 *
 * Reading only the greeting is not enough: a server that then demands a
 * password looks perfectly healthy but the phone's very next step fails, which
 * is exactly how "everything is [ ok ] yet the screen won't open" happens.
 */
function probeVnc(host, port, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    let stage = 'connect';
    const trace = [];
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ms: Date.now() - started, stage, ...result });
    };
    sock.setTimeout(timeout);
    sock.once('timeout', () => finish({ ok: false, error: `timed out during ${stage}` }));
    sock.once('error', (err) => finish({ ok: false, error: err.code || err.message }));

    /**
     * Read exactly n bytes. Servers routinely send several protocol fields in
     * one TCP segment, so anything left over must be kept for the next read —
     * dropping it hangs the handshake.
     */
    let pending = Buffer.alloc(0);
    const readExactly = (n, label) => new Promise((resolveRead) => {
      stage = label;
      const step = { step: label, wants: n };
      let onData = null;
      const take = () => {
        if (pending.length < n) return false;
        const out = pending.subarray(0, n);
        pending = pending.subarray(n);
        if (onData) sock.removeListener('data', onData);
        resolveRead(out);
        return true;
      };
      onData = (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        step.got = chunk.length;
        trace.push(step);
        take();
      };
      if (!take()) sock.on('data', onData);
    });

    (async () => {
      await new Promise((r) => sock.connect(port, host, r));
      const greeting = (await readExactly(12, 'greeting')).toString('latin1').trim();
      trace.push({ step: 'server greeting', detail: greeting });
      if (!greeting.startsWith('RFB ')) throw Object.assign(new Error('not an RFB server'), { handshake: { greeting } });

      sock.write(Buffer.from('RFB 003.008\n', 'latin1'));
      const countBuf = await readExactly(1, 'security types');
      const count = countBuf[0];
      let securityTypes = [];
      if (count === 0) {
        const len = (await readExactly(4, 'failure length')).readUInt32BE(0);
        const reason = len > 0 ? (await readExactly(len, 'failure reason')).toString('utf8') : '';
        throw Object.assign(new Error(`the screen server refused us: ${reason || 'no reason given'}`), {
          handshake: { greeting, refused: reason },
        });
      }
      securityTypes = [...(await readExactly(count, 'security types'))];
      const names = securityTypes.map((t) => SECURITY_NAMES[t] || `type ${t}`);
      trace.push({ step: 'server security types', detail: names.join(', ') });

      if (securityTypes.includes(1)) {
        sock.write(Buffer.from([1]));          // choose "none"
        trace.push({ step: 'we chose', detail: 'none (no password)' });
        const result = await readExactly(4, 'security result');
        if (result.readUInt32BE(0) !== 0) {
          const len = (await readExactly(4, 'failure length')).readUInt32BE(0);
          const reason = len > 0 ? (await readExactly(len, 'failure reason')).toString('utf8') : '';
          throw Object.assign(new Error(`authentication failed: ${reason || 'rejected'}`), {
            handshake: { greeting, securityTypes: names, authFailed: reason },
          });
        }
        sock.write(Buffer.from([1]));          // ClientInit: shared
        const init = await readExactly(24, 'server init');
        const width = init.readUInt16BE(0);
        const height = init.readUInt16BE(2);
        const nameLen = init.readUInt32BE(20);
        const name = nameLen > 0 ? (await readExactly(nameLen, 'desktop name')).toString('utf8') : '';
        trace.push({ step: 'desktop announced', detail: `${width}x${height} "${name}"` });
        finish({
          ok: true, greeting, securityTypes: names, requiresPassword: false,
          width, height, desktopName: name, trace,
        });
        return;
      }

      // No "none" offered — the phone cannot get in without credentials.
      trace.push({
        step: 'stopped here',
        detail: securityTypes.includes(2)
          ? 'the server wants a VNC password, so the phone gets no further'
          : `only unsupported security: ${names.join(', ')}`,
      });
      finish({
        ok: true, greeting, securityTypes: names,
        requiresPassword: securityTypes.includes(2),
        width: null, height: null, desktopName: null, trace,
      });
    })().catch((err) => {
      trace.push({ step: stage, detail: `failed: ${err.message}` });
      finish({ ok: false, error: err.message, trace, ...(err.handshake || {}) });
    });
  });
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
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
  return { opcode, masked, length: len, payload: buf.subarray(offset, offset + len) };
}

/** Full WebSocket round-trip through our own /ws endpoint. */
function probeWebsocketProxy({ port, host = '127.0.0.1', tls = false, timeout = TIMEOUT }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const token = auth.sign({ t: 'session', exp: Date.now() + 60000, iat: Date.now(), diag: true });
    const transport = tls ? https : http;
    const req = transport.request({
      host,
      port,
      path: `/ws?t=${encodeURIComponent(token)}`,
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ms: Date.now() - started, ...result });
    };
    req.setTimeout(timeout, () => finish({ ok: false, error: 'timed out' }));
    req.on('upgrade', (res, socket, head) => {
      // an unhandled 'error' on this detached socket would crash the server
      socket.on('error', (err) => finish({ ok: false, error: err.code || err.message }));
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const frame = parseFrame(buf);
        if (frame) {
          finish({
            ok: true,
            status: res.statusCode,
            opcode: frame.opcode,
            bytes: frame.length,
            greeting: frame.payload.toString('latin1').slice(0, 12).trim(),
          });
        }
      };
      socket.on('data', onData);
      if (buf.length) onData(Buffer.alloc(0));
      setTimeout(() => finish({ ok: false, error: 'no RFB greeting through the proxy' }), timeout);
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({
        ok: false,
        httpStatus: res.statusCode,
        error: `upgrade refused with HTTP ${res.statusCode}`,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 200),
      }));
    });
    req.on('error', (err) => finish({ ok: false, error: err.code || err.message }));
    req.end();
  });
}

async function run({ req, logbuf, deadline = 12000 } = {}) {
  const cfg = config.load();
  const session = vnc.detectSession();
  const steps = [];
  const timed = async (name, fn) => {
    const t = Date.now();
    try {
      const value = await fn();
      steps.push({ name, ms: Date.now() - t, ok: true });
      return value;
    } catch (err) {
      steps.push({ name, ms: Date.now() - t, ok: false, error: err.message });
      throw err;
    }
  };

  // A self-test must always answer, even if a probe wedges: one hard deadline
  // for the whole report.
  let timedOut = false;
  const collect = () => Promise.all([
    timed('tools', () => vnc.toolsStatus()),
    timed('vncStatus', () => vnc.status()),
    timed('vncProbe', () => probeVnc(cfg.vnc.host, cfg.vnc.port)),
    timed('proxyProbe', () => probeWebsocketProxy({
      port: cfg.port,
      host: '127.0.0.1',
      tls: Boolean(req?.socket?.encrypted) || false,
    })),
  ]);

  const collected = await Promise.race([
    collect(),
    new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve([
          { x11vnc: null },
          { running: null, error: 'timed out' },
          { ok: false, error: 'timed out' },
          { ok: false, error: 'timed out' },
        ]);
      }, deadline).unref?.();
    }),
  ]);
  const [tools, vncStatus, direct, throughProxy] = collected;
  const owner = vnc.portOwner(cfg.vnc.port);

  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  const warnings = [];
  if (!tools.x11vnc) warnings.push('x11vnc is not installed (sudo apt install x11vnc)');
  if (session.wayland) warnings.push('this is a Wayland session — x11vnc needs X11 ("Ubuntu on Xorg" at the login screen)');
  if (!tools.xdotool) warnings.push('xdotool missing — key chips and push-to-talk keys will not work (sudo apt install xdotool)');
  if (!vncStatus.running) warnings.push('the screen server is not running — press "Start VNC" on the Home screen');
  if (owner && !owner.ours) {
    warnings.push(`port ${cfg.vnc.port} is held by ${owner.binary} (pid ${owner.pid}), not by this app — `
      + 'press "Restart screen server" so the app can run its own');
  }
  const padStatus = pad.status();
  if (!padStatus.uinput) {
    warnings.push('no /dev/uinput — the Gamepad screen cannot create a controller (run install.sh)');
  } else if (!padStatus.available && padStatus.error) {
    warnings.push(`the virtual gamepad is not running: ${padStatus.error}`);
  }
  if (owner && owner.unknown) {
    warnings.push(`port ${cfg.vnc.port} is held by a process this app cannot inspect (pid ${owner.pid})`);
  }
  if (direct.ok && !throughProxy.ok) warnings.push('the PC can reach VNC but the WebSocket proxy cannot — send this report');
  if (!direct.ok && direct.error === 'ECONNREFUSED') warnings.push('nothing is listening on the VNC port');
  if (direct.ok && direct.requiresPassword) {
    warnings.push('the screen server demands a password, so the phone is rejected right after the greeting. '
      + 'The app replaces such a server automatically; if it persists, run:  pkill -f x11vnc; '
      + 'systemctl --user restart pocket-desktop-vnc');
  }
  if (direct.ok && !direct.width) warnings.push('the handshake stopped before the desktop size was announced');

  return {
    generatedAt: new Date().toISOString(),
    timedOut,
    steps,
    app: {
      name: cfg.name,
      version: config.VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      pid: process.pid,
      manager: process.env.INVOCATION_ID ? 'systemd' : 'foreground',
    },
    machine: {
      hostname: os.hostname(),
      user: os.userInfo().username,
      session: session.sessionType,
      display: session.display,
      xSockets: session.xSockets,
      xauthority: session.xauth || null,
      loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memoryUsedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    },
    server: {
      port: cfg.port,
      bind: cfg.bind,
      tls: Boolean(req?.socket?.encrypted),
      hostHeader: req?.headers?.host || null,
      clientAddress: req?.socket?.remoteAddress || null,
      addresses,
      pinSet: auth.hasPin(),
    },
    vnc: {
      ...vncStatus,
      tools,
      directProbe: direct,
      websocketProxy: throughProxy,
    },
    checks: {
      x11Session: !session.wayland,
      x11vncInstalled: Boolean(tools.x11vnc),
      vncListening: vncStatus.running,
      screenServer: owner ? { pid: owner.pid, binary: owner.binary, ours: owner.ours } : null,
      screenServerCommand: owner?.cmd || null,
      gamepad: padStatus,
      appHasPassword: Boolean(cfg.vnc.password),
      vncTrace: direct.trace || null,
      phoneVerdict: (direct.ok && direct.requiresPassword)
        ? 'the phone will be rejected: the screen server asks for a password'
        : (direct.ok ? 'the phone can complete the handshake' : 'the phone cannot reach the screen server'),
      vncGreeting: direct.ok ? direct.greeting : null,
      vncSecurity: direct.securityTypes || null,
      vncScreen: direct.width ? `${direct.width}x${direct.height}` : null,
      websocketProxy: throughProxy.ok,
    },
    warnings,
    recentLog: logbuf ? logbuf.recent({ limit: 60 }) : [],
  };
}

/** Human-readable version of the report (used by --report and the UI copy button). */
function toText(report) {
  const lines = [];
  const mark = (ok) => (ok ? '[ ok ]' : '[FAIL]');
  lines.push(`${report.app.name} diagnostics — ${report.generatedAt}`);
  lines.push(`app      ${report.app.version} on Node ${report.app.node} (${report.app.manager})`);
  lines.push(`machine  ${report.machine.hostname} · ${report.machine.user} · ${report.app.platform}`);
  lines.push(`session  ${report.machine.session} on ${report.machine.display} · auth ${report.machine.xauthority || 'none'}`);
  lines.push(`server   port ${report.server.port} bind ${report.server.bind} · ${report.server.tls ? 'https' : 'http'} · addresses ${report.server.addresses.join(', ') || 'none'}`);
  lines.push(`network  client ${report.server.clientAddress || 'n/a'} asked for host "${report.server.hostHeader || 'n/a'}"`);
  lines.push('');
  lines.push(`${mark(report.checks.x11Session)} X11 session (Wayland cannot be captured by x11vnc)`);
  lines.push(`${mark(report.checks.x11vncInstalled)} x11vnc installed`);
  lines.push(`${mark(report.checks.vncListening)} VNC listening on ${report.vnc.host}:${report.vnc.port}${report.vnc.managedBy ? ` (${report.vnc.managedBy})` : ''}`);
  const owner = report.checks.screenServer;
  if (owner) {
    lines.push(`${mark(owner.ours)} Screen server on port ${report.vnc.port}: ${owner.binary} (pid ${owner.pid}, `
      + `${owner.ours ? 'managed by this app' : 'NOT managed by this app'})`);
  }
  if (report.checks.screenServerCommand) {
    lines.push(`        running as: ${report.checks.screenServerCommand.slice(0, 160)}`);
  }
  if (report.checks.phoneVerdict) {
    lines.push(`        phone: ${report.checks.phoneVerdict}`);
  }
  const gp = report.checks.gamepad;
  if (gp) {
    const state = gp.available ? `ready (${gp.mode})` : (gp.uinput ? 'available on demand' : 'unavailable');
    lines.push(`${mark(gp.available || gp.uinput)} Virtual gamepad: ${state}`
      + (gp.error ? ` — ${gp.error}` : ''));
  }
  const probe = report.vnc.directProbe;
  const greet = report.checks.vncGreeting ? `${report.checks.vncGreeting}` : (probe.error || 'none');
  const shape = report.checks.vncScreen ? ` · ${report.checks.vncScreen}` : '';
  const sec = report.checks.vncSecurity ? ` · security: ${report.checks.vncSecurity.join(', ')}` : '';
  lines.push(`${mark(report.checks.vncGreeting)} Full screen handshake: ${greet}${shape}${sec} (${probe.ms} ms)`);
  lines.push(`${mark(report.checks.websocketProxy)} WebSocket proxy: ${report.vnc.websocketProxy.ok ? `${report.vnc.websocketProxy.greeting} in ${report.vnc.websocketProxy.ms} ms` : report.vnc.websocketProxy.error}`);
  const t = report.vnc.tools || {};
  lines.push('');
  lines.push(`tools    x11vnc ${t.x11vnc ? 'yes' : 'no'} · xdotool ${t.xdotool ? 'yes' : 'no'} · arecord ${t.arecord ? 'yes' : 'no'} · screenshot ${t.screenshot || 'no'}`);
  if (report.warnings.length) {
    lines.push('');
    lines.push('warnings');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  const trace = report.checks.vncTrace;
  if (trace && trace.length) {
    lines.push('', 'screen handshake, step by step');
    for (const t of trace) {
      const bytes = t.got !== undefined ? `${t.got}/${t.wants} bytes` : '';
      lines.push(`  ${t.step}${bytes ? ` (${bytes})` : ''}${t.detail ? `: ${t.detail}` : ''}`);
    }
  }

  lines.push('', 'recent log');
  if (!report.recentLog.length) lines.push('  (nothing logged yet)');
  for (const entry of report.recentLog.slice(-25)) {
    lines.push(`  ${entry.t.slice(11, 19)} ${entry.level} ${entry.message}${describe(entry.meta)}`);
  }
  return lines.join('\n');
}

/**
 * Render the structured half of a log line. These details (byte counts, close
 * codes, how often the phone fell behind) are exactly what tells us *where* a
 * session broke, so they must survive into the report.
 */
function describe(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const interesting = ['peer', 'code', 'reason', 'toClient', 'toPc', 'ms', 'stalls',
    'maxBufferedKB', 'origin', 'attempt', 'via', 'error', 'message'];
  const parts = [];
  for (const key of interesting) {
    const value = meta[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'message' && Object.keys(meta).length > 1) continue; // noisy duplicates
    let text = String(value);
    if ((key === 'toClient' || key === 'toPc') && Number(value) > 4096) {
      text = `${(Number(value) / 1048576).toFixed(2)} MB`;
    }
    parts.push(`${key} ${text}`);
  }
  return parts.length ? `  {${parts.join(', ')}}` : '';
}

module.exports = { run, toText, probeVnc, probeWebsocketProxy, parseFrame, describe };
