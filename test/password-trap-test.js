#!/usr/bin/env node
'use strict';
/**
 * Password-trap test.
 *
 * Reproduces the exact state that locked a real phone out: a VNC password saved
 * in Settings plus a ~/.vnc/passwd on disk. The app used to start its *own*
 * screen server with -rfbauth in that case, so the phone was rejected right
 * after the greeting while every check still read "ok".
 *
 * Since the screen server only listens on 127.0.0.1 behind the PIN, a VNC
 * password protects nothing and only breaks the phone — so the app must always
 * start its server with -nopw.
 *
 *   DISPLAY=:99 node test/password-trap-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const diagnostics = require(path.join(ROOT, 'lib/diagnostics.js'));

const PORT = Number(process.env.PD_TEST_PORT || 8903);
const VNC_PORT = Number(process.env.PD_TEST_VNC || 15990);
const PIN = '2024';

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
  console.log('\nPocket Desktop password-trap test — a VNC password saved in Settings\n');

  const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pw-'));
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-'));
  const passwdFile = path.join(FAKE_HOME, 'passwd');
  fs.writeFileSync(passwdFile, Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]));

  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({
    port: PORT,
    vnc: {
      port: VNC_PORT,
      autostart: false,
      password: 'secret',          // a password the user saved in Settings
      passwordFile: passwdFile,    // and a passwd file on disk
    },
  }));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: {
      ...process.env,
      POCKET_DESKTOP_CONFIG_DIR: CONFIG_DIR,
      DISPLAY: process.env.DISPLAY || ':99',
    },
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
  check('logged in', Boolean(token));

  const start = await httpRequest('POST', '/api/vnc/start', {}, token);
  check('the app starts a screen server', start.json?.ok === true, start.json?.result?.via || '');

  let diag = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    diag = (await httpRequest('GET', '/api/diagnostics', null, token)).json?.data;
    if (diag?.checks?.vncGreeting) break;
  }

  const sec = (diag?.checks?.vncSecurity || []).join(', ');
  check('a saved VNC password does NOT password-protect the app\'s own server',
    diag?.checks?.requiresPassword !== true && !/password/i.test(sec),
    `security: ${sec || 'unknown'}`);

  const cmd = diag?.checks?.screenServerCommand || '';
  check('the screen server really runs with -nopw',
    /-nopw/.test(cmd) && !/-rfbauth/.test(cmd),
    cmd ? cmd.slice(0, 110) : '(command line unavailable)');

  check('the handshake completes and announces the desktop',
    Boolean(diag?.checks?.vncScreen),
    diag?.checks?.vncScreen || `${(diag?.checks?.vncTrace || []).map((t) => t.step).join(' → ')}`);

  check('no password warning is left in the report',
    !(diag?.warnings || []).some((w) => /demands a password/i.test(w)),
    (diag?.warnings || []).join(' | ') || 'none');

  check('the report says the phone can get in',
    /can complete the handshake/.test(diag?.checks?.phoneVerdict || ''),
    diag?.checks?.phoneVerdict || '');

  // and prove it independently, straight against the port
  const probe = await diagnostics.probeVnc('127.0.0.1', VNC_PORT);
  check('a direct RFB handshake needs no password',
    probe.ok && probe.requiresPassword === false && Boolean(probe.width),
    `${probe.greeting || '—'} · ${(probe.securityTypes || []).join(', ')} · ${probe.width || '?'}x${probe.height || '?'}`);

  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(400);
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  password-trap-test error:', err.message);
  process.exit(2);
});
