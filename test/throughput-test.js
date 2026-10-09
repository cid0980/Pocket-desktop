#!/usr/bin/env node
'use strict';
/**
 * Throughput test — the "big screen update over slow Wi-Fi" case.
 *
 * A real desktop sends several megabytes for the first frame; a phone reads
 * that far slower than the PC can produce it. This test points the app at a
 * fake screen server that blasts 16 MB, connects a deliberately slow reader,
 * and checks that the stream *keeps flowing* instead of stalling forever.
 *
 *   node test/throughput-test.js --port 8899 --vnc-port 15900
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(getArg('--port', 8899));
const VNC_PORT = Number(getArg('--vnc-port', 15900));
const PIN = getArg('--pin', '4242');
const TOTAL = 16 * 1024 * 1024; // what one full desktop update can easily be

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-throughput-'));

let passed = 0; let failed = 0; const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A fake screen server that behaves like VNC: greet, then blast bytes.
 * ------------------------------------------------------------------ */
function startFakeVnc() {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.write('RFB 003.008\n');
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const pump = () => {
      while (sent < TOTAL) {
        if (!sock.write(chunk)) { sock.once('drain', pump); return; }
        sent += chunk.length;
      }
    };
    sock.once('data', pump); // wait for the client's RFB version string
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(VNC_PORT, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ *
 * A raw WebSocket client we can throttle, to behave like a slow phone.
 * ------------------------------------------------------------------ */
class SlowClient {
  constructor() {
    this.received = 0;
    this.messages = 0;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.closeCode = null;
  }

  connect(port, pathAndQuery) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(port, '127.0.0.1', () => {
        this.sock.write(
          `GET ${pathAndQuery} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.sock.setNoDelay(true);
      let handshake = false;
      this.sock.on('data', (chunk) => {
        if (!handshake) {
          const text = chunk.toString('latin1');
          const idx = text.indexOf('\r\n\r\n');
          if (idx < 0) return;
          handshake = true;
          if (!/101/.test(text.split('\r\n')[0])) {
            reject(new Error('upgrade refused: ' + text.split('\r\n')[0]));
            return;
          }
          this.buf = chunk.subarray(Buffer.byteLength(text.slice(0, idx + 4), 'latin1'));
          resolve(this);
        } else {
          this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
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
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (opcode === 0x2 || opcode === 0x0) { this.received += payload.length; this.messages += 1; }
      if (opcode === 0x8) { this.closed = true; this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; }
    }
  }

  /** Send a masked client→server frame, like a real browser does. */
  send(data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x82; // FIN + binary
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  /** Stop reading for a while — the server must cope, not lock up. */
  stall(ms) { this.sock.pause(); setTimeout(() => this.sock.resume(), ms); }

  /**
   * Read at most `bytes` more, then stop. Returns false if that never arrives,
   * which is exactly what a wedged proxy looks like from the phone.
   */
  async readAtLeast(bytes, timeoutMs) {
    const target = this.received + bytes;
    const deadline = Date.now() + timeoutMs;
    this.sock.resume();
    while (this.received < target && !this.closed && Date.now() < deadline) {
      await sleep(2);
    }
    try { this.sock.pause(); } catch { /* ignore */ }
    return this.received >= target || this.closed;
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
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  console.log('\nPocket Desktop throughput test — a big screen update over a slow link\n');

  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({
    port: PORT,
    vnc: { port: VNC_PORT, autostart: false },
  }));

  const fakeVnc = await startFakeVnc();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, POCKET_DESKTOP_CONFIG_DIR: CONFIG_DIR, DISPLAY: ':99' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  for (let i = 0; i < 40; i += 1) {
    try { await httpRequest('GET', '/api/ping'); break; } catch { await sleep(250); }
  }

  await httpRequest('POST', '/api/setup', { pin: PIN }).catch(() => null);
  const login = await httpRequest('POST', '/api/login', { pin: PIN });
  const token = login.json?.data?.token || login.json?.token;
  check('logged in to the test server', Boolean(token));

  const client = new SlowClient();
  await client.connect(PORT, `/ws?t=${encodeURIComponent(token)}`);
  await sleep(200);
  check('the greeting reaches the phone', client.received >= 12, `${client.received} bytes`);
  client.send('RFB 003.008\n'); // ask for the framebuffer, like noVNC does

  // Behave like a phone on Wi-Fi: take one bite, spend 120 ms painting it,
  // repeat. The PC is producing far faster than this, so the app HAS to apply
  // backpressure — and, crucially, release it again.
  client.sock.pause();
  let wedged = false;
  const t0 = Date.now();
  while (client.received < TOTAL && !client.closed && Date.now() - t0 < 60000) {
    const got = await client.readAtLeast(256 * 1024, 6000);
    if (!got) { wedged = true; break; }
    await sleep(250);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  check('a slow phone still receives the whole update (no deadlock)',
    !wedged && client.received >= TOTAL,
    `${(client.received / 1048576).toFixed(1)} MB of ${(TOTAL / 1048576).toFixed(1)} MB in ${secs}s`
    + (wedged ? ' — STALLED: the server stopped feeding the phone' : ''));
  check('the connection stayed open', !client.closed, client.closeCode ? `close code ${client.closeCode}` : 'open');
  check('the phone got a sane throughput, not a trickle', client.received / ((Date.now() - t0) / 1000) > 256 * 1024,
    `${(client.received / 1048576 / ((Date.now() - t0) / 1000)).toFixed(2)} MB/s`);

  // Make sure the test really exercised backpressure instead of passing by luck.
  client.close();
  let entries = [];
  let entry = {};
  for (let i = 0; i < 25; i += 1) {          // the close is logged asynchronously
    await sleep(200);
    const logs = await httpRequest('GET', '/api/logs?contains=ws:', null, token);
    entries = Array.isArray(logs.json?.data) ? logs.json.data : (logs.json?.data?.entries || []);
    entry = entries.filter((e) => /ws: closed/.test(e.message || '')).slice(-1)[0] || {};
    if (entry.meta) break;
  }
  const detail = entry.meta || {};
  check('a phone that disconnects is cleaned up on the PC (no zombie session)',
    Boolean(entry.meta) && Number(detail.toClient || 0) > 0,
    entry.meta ? `closed after ${detail.ms} ms, ${Math.round((detail.toClient || 0) / 1048576)} MB sent` : 'the server never noticed the phone left');

  check('backpressure actually engaged (the PC was throttled, then released)',
    Number(detail.stalls || 0) > 0,
    `${detail.stalls || 0} pauses, peak buffer ${detail.maxBufferedKB || 0} KB, sent ${Math.round((detail.toClient || 0) / 1048576)} MB`
    + (Number(detail.stalls || 0) > 0 ? '' : ` — log entries seen: ${entries.length} [${entries.map((e) => e.message).join(' | ')}]`));

  client.close();
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
  fakeVnc.close();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  throughput-test error:', err.message);
  process.exit(2);
});
