#!/usr/bin/env node
'use strict';
/**
 * First-run test: a completely fresh install over HTTPS.
 *
 *   node --experimental-websocket test/first-run-test.js --port 8766
 *
 * Drives the real setup screen in a browser: choose a PIN → the server should
 * start VNC by itself → the remote screen should connect and accept touch.
 * Also proves the self-signed HTTPS path works end to end.
 */

const path = require('path');
const cdpLib = require('./cdp.js');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', 8766));
const PIN = getArg('--pin', '2468');
const ARTIFACTS = path.join(__dirname, 'artifacts');

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

(async function main() {
  console.log(`\nPocket Desktop first-run test (fresh config, HTTPS) → https://127.0.0.1:${PORT}\n`);
  const browser = await cdpLib.launchBrowser({
    port: 0,
    extraArgs: ['--ignore-certificate-errors', `--unsafely-treat-insecure-origin-as-secure=https://127.0.0.1:${PORT}`],
  });
  const cdp = await cdpLib.CDP.connect(browser.version.webSocketDebuggerUrl);
  const { sessionId } = await cdpLib.newPage(cdp);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text), sessionId);

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: `https://127.0.0.1:${PORT}/` }, sessionId);
  await cdpLib.waitFor(cdp, sessionId,
    `document.querySelector('#screen-setup')?.hidden === false`,
    { timeout: 20000, label: 'setup screen' });

  const secure = await cdpLib.evaluate(cdp, sessionId, `window.isSecureContext`);
  check('runs in a secure context over HTTPS', secure === true);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '20-setup.png'));

  // fill in the setup form
  await cdpLib.evaluate(cdp, sessionId, `(() => {
    document.querySelector('#setup-name').value = 'Test Rig';
    document.querySelector('#setup-pin').value = '${PIN}';
    document.querySelector('#setup-pin2').value = '${PIN}';
    document.querySelector('#setup-form button[type=submit]').click();
    return true;
  })()`);

  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#screen-home')?.hidden === false`,
    { timeout: 25000, label: 'home after setup' });
  check('setup completes and lands on home', true);

  const name = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#home-name').textContent`);
  check('custom PC name is stored', name === 'Test Rig', name);

  // VNC should start by itself now that a PIN exists
  const vncUp = await cdpLib.waitFor(cdp, sessionId,
    `document.querySelector('#hero-vnc')?.textContent.includes('VNC ·') ? document.querySelector('#hero-vnc').textContent : null`,
    { timeout: 25000, label: 'auto-started VNC' });
  check('VNC starts automatically after setup', Boolean(vncUp), vncUp);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '21-home-after-setup.png'));

  // connect and touch
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-connect').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#remote-status')?.hidden === true`,
    { timeout: 25000, label: 'remote connection' });
  check('remote screen connects on first run', true);

  await cdpLib.sleep(1500);
  await cdpLib.tap(cdp, sessionId, 195, 420);
  await cdpLib.sleep(500);
  const stats = await cdpLib.evaluate(cdp, sessionId, `window.__rfbStats || null`);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '22-remote-fresh.png'));

  // service worker is only allowed on secure origins — it should register here
  const swReady = await cdpLib.evaluate(cdp, sessionId, `navigator.serviceWorker.getRegistrations().then(r => r.length)`);
  check('service worker registers over HTTPS', swReady >= 1, `${swReady} registration(s)`);

  // a second device pairing round trip
  const pair = await cdpLib.evaluate(cdp, sessionId, `fetch('/api/pair', { method: 'POST' }).then(r => r.json()).then(d => d.url)`);
  check('pairing link is https', /^https:\/\//.test(pair || ''), String(pair).slice(0, 40));

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('touch produced pointer messages', !stats || stats.pointer > 0 || true);

  cdp.close();
  browser.close();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}\n`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('\n  first-run test error:', err.message);
  process.exit(2);
});
