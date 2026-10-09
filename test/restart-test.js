#!/usr/bin/env node
'use strict';
/**
 * Update/restart test — the "I updated the files but the old process is still
 * serving them" trap, plus the restart button that fixes it.
 *
 *   node test/restart-test.js --port 8790 --pin 3131
 *
 * Starts its own server instance (like systemd would), then:
 *   1. checks a newer client version is detected over the API
 *   2. checks /api/restart exits the process (systemd's Restart=always brings
 *      it back — here the test plays the role of systemd)
 *   3. checks a fresh process serves the new version
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', 8790));
const PIN = getArg('--pin', '3131');
const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-restart-'));

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, urlPath, { body, cookie, headers = {}, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
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
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, body: buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function portOpen(port = PORT) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: {
      ...process.env,
      POCKET_DESKTOP_CONFIG_DIR: CONFIG_DIR,
      POCKET_DESKTOP_SUPERVISED: '1',
      DISPLAY: process.env.DISPLAY || ':99',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitForPort(port = PORT, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  return false;
}

(async function main() {
  console.log(`\nPocket Desktop update/restart test → port ${PORT}\n`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let child = startServer();
  check('a server instance starts (playing the role of systemd)', await waitForPort());

  const login = await request('POST', '/api/login', { body: { pin: PIN } }).catch(() => ({ status: 0, json: {} }));
  let cookie;
  if (login.status !== 200) {
    // fresh config: set the PIN through the API first
    await request('POST', '/api/setup', { body: { pin: PIN, name: 'Restart Test' } }).catch(() => null);
    const second = await request('POST', '/api/login', { body: { pin: PIN } }).catch(() => ({ headers: {} }));
    cookie = second.headers?.['set-cookie']?.map((c) => c.split(';')[0]).join('; ');
  } else {
    cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  }
  check('authenticated for the test', Boolean(cookie));

  const serverVersion = (await request('GET', '/api/auth')).json?.version;
  const clientVersion = /CLIENT_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'public/assets/app.js'), 'utf8'))?.[1];
  const configVersion = /const VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf8'))?.[1];
  check('client and server versions match in the source', clientVersion === configVersion, `app.js ${clientVersion} vs config.js ${configVersion}`);
  check('running server reports its version', serverVersion === configVersion, `API says ${serverVersion}`);

  // a phone with newer files must be detected (header based)
  const mismatch = await request('GET', '/api/auth', {
    headers: { 'X-Pocket-Client': '99.0.0' },
  });
  check('server flags a newer client as a mismatch',
    (mismatch.headers['x-pocket-version-mismatch'] || '').includes('99.0.0'),
    String(mismatch.headers['x-pocket-version-mismatch'] || '(no header)'));
  check('every response advertises the running server version',
    mismatch.headers['x-pocket-server'] === serverVersion);

  // diagnostics answer quickly and include step timings
  const diag = await request('GET', '/api/diagnostics', { cookie });
  const steps = diag.json?.data?.steps || [];
  check('diagnostics answers and reports step timings',
    diag.status === 200 && steps.length >= 3 && diag.json?.data?.timedOut === false,
    steps.map((s) => `${s.name} ${s.ms}ms`).join(' · '));
  check('no diagnostics step is stuck', steps.every((s) => s.ms < 12000), `slowest ${Math.max(...steps.map((s) => s.ms))}ms`);

  // restart: the process must exit (systemd would bring it back)
  const restart = await request('POST', '/api/restart', { cookie, body: {} });
  check('restart endpoint accepts the request', restart.status === 200 && restart.json?.restarting === true);
  let wentDown = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    if (!(await portOpen())) { wentDown = true; break; }
  }
  check('the old process exits (so a fresh one picks up new files)', wentDown);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }

  // "systemd" restarts it
  child = startServer();
  check('the service comes back up', await waitForPort());
  const after = await request('GET', '/api/auth');
  check('the restarted process reports the same version', after.json?.version === serverVersion, String(after.json?.version));
  const afterLogin = await request('POST', '/api/login', { body: { pin: PIN } });
  check('the PIN still works after a restart', afterLogin.status === 200);

  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\n  restart-test error:', err.message);
  process.exit(2);
});
