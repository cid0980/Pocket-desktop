#!/usr/bin/env node
'use strict';
/**
 * Self-healing test — the failure the app could previously only describe.
 *
 * A password-protected screen server is installed on the port (it greets, then
 * hangs up). The phone fails. The app must replace that server with one it
 * controls, so the very next attempt works — with no user intervention.
 *
 *   DISPLAY=:99 node test/selfheal-test.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PD_TEST_PORT || 8902);
const VNC_PORT = Number(process.env.PD_TEST_VNC || 15960);
const PIN = '6041';

let passed = 0; let failed = 0; const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1');
  const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
  sock.setTimeout(800);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});

class WsClient {
  constructor() { this.received = 0; this.buf = Buffer.alloc(0); this.closed = false; this.closeCode = null; this.closeReason = ''; }
  connect(port, target) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(port, '127.0.0.1', () => {
        this.sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let handshake = false;
      this.sock.on('data', (chunk) => {
        if (!handshake) {
          const text = chunk.toString('latin1');
          const idx = text.indexOf('\r\n\r\n');
          if (idx < 0) return;
          handshake = true;
          if (!/101/.test(text.split('\r\n')[0])) { reject(new Error('upgrade refused')); return; }
          this.buf = chunk.subarray(Buffer.byteLength(text.slice(0, idx + 4), 'latin1'));
          resolve(this);
        } else {
          this.buf = Buffer.concat([this.buf, chunk]);
        }
        this.parse();
      });
      this.sock.on('error', () => { this.closed = true; });
      this.sock.on('close', () => { this.closed = true; });
    });
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      let len = b[1] & 0x7f; let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (opcode === 0x2 || opcode === 0x0) this.received += payload.length;
      if (opcode === 0x8) {
        this.closed = true;
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      }
    }
  }
  send(data) {
    const payload = Buffer.from(data, 'latin1');
    const mask = crypto.randomBytes(4);
    const header = Buffer.alloc(2);
    header[0] = 0x82; header[1] = 0x80 | payload.length;
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

function httpRequest(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: p,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  console.log('\nPocket Desktop self-healing test — a password-protected screen server\n');

  const display = process.env.DISPLAY || ':99';
  const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-heal-'));
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({
    port: PORT, vnc: { port: VNC_PORT, autostart: false },
  }));

  // A screen server that offers only "VNC password" auth and then gives up —
  // the behaviour seen on machines where another program owns the port.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fake-'));
  const fakeBin = path.join(fakeDir, 'Xvnc');
  fs.writeFileSync(fakeBin, `
const net = require('net');
net.createServer((s) => {
  s.write('RFB 003.008\\n');
  s.once('data', () => { s.write(Buffer.from([1, 2])); setTimeout(() => s.destroy(), 120); });
  s.on('error', () => {});
}).listen(${VNC_PORT}, '127.0.0.1', () => setInterval(() => {}, 1000));
`);
  const fake = spawn(process.execPath, [fakeBin], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 30 && !(await portOpen(VNC_PORT)); i += 1) await sleep(150);
  check('a password-protected screen server is holding the port', await portOpen(VNC_PORT));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, POCKET_DESKTOP_CONFIG_DIR: CONFIG_DIR, DISPLAY: display },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 40; i += 1) {
    try { await httpRequest('GET', '/api/ping'); break; } catch { await sleep(250); }
  }

  await httpRequest('POST', '/api/setup', { pin: PIN }).catch(() => null);
  const login = await httpRequest('POST', '/api/login', { pin: PIN });
  const token = login.json?.data?.token || login.json?.token;
  check('logged in', Boolean(token));

  /* ── 1. the phone is rejected ────────────────────────────────────── */
  const victim = new WsClient();
  await victim.connect(PORT, `/ws?t=${encodeURIComponent(token)}`);
  await sleep(150);
  victim.send('RFB 003.008\n');
  for (let i = 0; i < 40 && !victim.closed; i += 1) await sleep(100);
  check('the phone is rejected by the password-protected server',
    victim.closed && /hung up|handshake|fixing it/i.test(victim.closeReason),
    `close ${victim.closeCode} "${victim.closeReason}"`);
  victim.close();

  /* ── 2. the app replaces it, by itself ───────────────────────────── */
  let diag = null;
  let ownerOurs = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(1000);
    diag = (await httpRequest('GET', '/api/diagnostics', null, token)).json?.data;
    ownerOurs = Boolean(diag?.checks?.screenServer?.ours);
    if (ownerOurs && diag?.checks?.vncScreen) break;
  }

  check('the app replaced the screen server on its own',
    ownerOurs,
    diag?.checks?.screenServer
      ? `${diag.checks.screenServer.binary} pid ${diag.checks.screenServer.pid} on port ${diag?.vnc?.port}`
      : 'still not ours');

  const stillPassword = (diag?.warnings || []).some((w) => /demands a password/i.test(w));
  check('the new screen server no longer demands a password', !stillPassword,
    stillPassword ? (diag.warnings.find((w) => /password/i.test(w)) || '') : `security: ${(diag?.checks?.vncSecurity || []).join(', ')}`);

  check('the handshake now completes and reports a screen size',
    Boolean(diag?.checks?.vncScreen),
    diag?.checks?.vncScreen ? `${diag.checks.vncScreen} · ${(diag.checks.vncSecurity || []).join(', ')}` : 'no size announced');

  /* ── 3. and the phone can connect again ──────────────────────────── */
  const healed = new WsClient();
  await healed.connect(PORT, `/ws?t=${encodeURIComponent(token)}`);
  await sleep(300);
  healed.send('RFB 003.008\n');
  await sleep(1200);
  healed.send(Buffer.from([1, 1]).toString('latin1')); // security type "none", then ClientInit
  await sleep(1500);
  check('a phone connecting after the heal gets the screen handshake',
    !healed.closed && healed.received > 40,
    `${healed.received} bytes, ${healed.closed ? `closed (${healed.closeReason})` : 'still open'}`);
  healed.close();

  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { process.kill(-fake.pid, 'SIGKILL'); } catch { fake.kill('SIGKILL'); }
  await sleep(300);
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(fakeDir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  selfheal-test error:', err.message);
  process.exit(2);
});
