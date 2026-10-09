#!/usr/bin/env node
'use strict';
/**
 * Screen-server ownership test.
 *
 * Covers the failure where a *foreign* screen server (another VNC tool, or a
 * leftover x11vnc attached to a display that no longer exists) accepts the RFB
 * handshake and then hangs up. The app must (a) say so clearly and (b) be able
 * to take the port back.
 *
 *   node test/screen-server-test.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, () => resolve({ ok: true })));

const ROOT = path.join(__dirname, '..');
const vnc = require(path.join(ROOT, 'lib/vnc.js'));
const { log } = require(path.join(ROOT, 'lib/logbuf.js'));

const PORT = Number(process.env.PD_TEST_PORT || 8901);
const VNC_PORT = Number(process.env.PD_TEST_VNC || 15930);
const PIN = '5150';

let passed = 0; let failed = 0; const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const sock = net.connect(port, host);
  const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
  sock.setTimeout(800);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});

/* ------------------------------------------------------------------ *
 * Minimal WebSocket client that keeps the close reason.
 * ------------------------------------------------------------------ */
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
    header[0] = 0x82;
    header[1] = 0x80 | payload.length;
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

function httpRequest(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = require('http').request({
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
  console.log('\nPocket Desktop screen-server ownership test\n');

  // Leftovers from a previous run would make the port busy before we start.
  const stale = vnc.portOwner(VNC_PORT);
  if (stale) { try { process.kill(stale.pid, 'SIGKILL'); } catch { /* ignore */ } await sleep(400); }

  /* ── 1. portOwner finds whoever holds the port ─────────────────── */
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-foreign-'));
  const foreignBin = path.join(foreignDir, 'Xvnc');
  fs.writeFileSync(foreignBin, `require('net').createServer(()=>{}).listen(${VNC_PORT},'127.0.0.1',()=>setInterval(()=>{},1000));\n`);
  let foreign = spawn(process.execPath, [foreignBin], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 30 && !(await portOpen(VNC_PORT)); i += 1) await sleep(150);

  const owner = vnc.portOwner(VNC_PORT);
  check('the app can tell which process holds the screen port',
    Boolean(owner && owner.pid), owner ? `${owner.binary} (pid ${owner.pid})` : 'not found');
  check('a foreign screen server is reported as not managed by the app',
    Boolean(owner) && owner.ours === false);
  check('a VNC-named process is recognised as a screen server',
    vnc.looksLikeVncServer(owner) === true, owner ? owner.binary : '');
  if (await portOpen(5900)) {
    const real = vnc.portOwner(5900);
    if (real) check('this app recognises its own screen server', real.ours === true, `${real.binary} pid ${real.pid}`);
  }
  try { process.kill(-foreign.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(400);

  const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-'));
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({
    port: PORT, vnc: { port: VNC_PORT, autostart: false },
  }));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, POCKET_DESKTOP_CONFIG_DIR: CONFIG_DIR, DISPLAY: process.env.DISPLAY || ':99' },
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

  /* ── 2. "Restart screen server" takes the port back ─────────────── */
  foreign = spawn(process.execPath, [foreignBin], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 30 && !(await portOpen(VNC_PORT)); i += 1) await sleep(150);
  check('a foreign screen server is squatting on the port', await portOpen(VNC_PORT));

  const restart = await httpRequest('POST', '/api/vnc/restart', {}, token);
  const displaced = restart.json?.displaced;
  await sleep(1500);
  check('"Restart screen server" frees the port from the foreign server',
    Boolean(displaced), displaced ? `displaced ${displaced}` : 'nothing displaced');
  const afterOwner = vnc.portOwner(VNC_PORT);
  check('the port now belongs to a server this app manages',
    Boolean(afterOwner && afterOwner.ours),
    afterOwner ? `${afterOwner.binary} pid ${afterOwner.pid}` : 'nobody listening');

  /* ── 3. a hand-shake hang-up is reported clearly, then healed ───── */
  // Clear the port so the misbehaving server can take it.
  await run('pkill', ['-f', `x11vnc -display`]);
  await sleep(600);

  // Spawned as its own process (and named like a VNC server) so the app is
  // allowed to displace it — exactly like a real stray screen server.
  const hangupBin = path.join(foreignDir, 'Xvnc-hangup');
  fs.writeFileSync(hangupBin, `
const net = require('net');
net.createServer((s) => {
  s.write('RFB 003.008\\n');
  s.once('data', () => { s.write(Buffer.alloc(48, 0x41)); setTimeout(() => s.destroy(), 150); });
  s.on('error', () => {});
}).listen(${VNC_PORT}, '127.0.0.1', () => setInterval(() => {}, 1000));
`);
  const hangup = spawn(process.execPath, [hangupBin], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 30 && !(await portOpen(VNC_PORT)); i += 1) await sleep(150);

  const client = new WsClient();
  await client.connect(PORT, `/ws?t=${encodeURIComponent(token)}`);
  await sleep(150);
  client.send('RFB 003.008\n');
  for (let i = 0; i < 30 && !client.closed; i += 1) await sleep(100);

  check('a handshake hang-up is explained instead of a bare "closed"',
    /hung up|handshake|fixing it/i.test(client.closeReason || ''),
    `close ${client.closeCode} "${client.closeReason}"`);
  client.close();

  // The app should now put a server it controls back on that port.
  let healed = null;
  for (let i = 0; i < 25; i += 1) {
    await sleep(1000);
    healed = vnc.portOwner(VNC_PORT);
    if (healed && healed.ours) break;
  }
  check('the app puts a server it manages back on the port',
    Boolean(healed && healed.ours),
    healed ? `${healed.binary} pid ${healed.pid}` : 'still foreign');

  try { process.kill(-hangup.pid, 'SIGKILL'); } catch { hangup.kill('SIGKILL'); }
  try { process.kill(-foreign.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(300);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  screen-server-test error:', err.message);
  process.exit(2);
});
