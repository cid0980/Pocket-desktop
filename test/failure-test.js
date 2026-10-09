#!/usr/bin/env node
'use strict';
/**
 * Failure-path test — the "Connection lost" scenario.
 *
 *   node --experimental-websocket test/failure-test.js --port 8765 --pin 1234
 *
 * Steps:
 *   1. kill x11vnc behind the app's back, then open the remote screen
 *   2. the app must explain what is wrong (not just "connection lost") and
 *      recover by itself once the screen server is back
 *   3. with the screen server permanently unavailable, the diagnostics report
 *      must name the failing step
 */

const { execFileSync } = require('child_process');
const path = require('path');
const cdpLib = require('./cdp.js');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', 8765));
const PIN = getArg('--pin', '1234');
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

const sh = (cmd) => {
  try {
    return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' }).trim();
  } catch (err) {
    return `(failed: ${err.message.split('\n')[0]})`;
  }
};

const net = require('net');
/** Real TCP probe — `ss`/`netstat` are not always installed. */
function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const done = (value) => { try { sock.destroy(); } catch { /* ignore */ } resolve(value); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

(async function main() {
  console.log(`\nPocket Desktop failure-path test → http://127.0.0.1:${PORT}\n`);
  const browser = await cdpLib.launchBrowser({ port: 0 });
  const cdp = await cdpLib.CDP.connect(browser.version.webSocketDebuggerUrl);
  const { sessionId } = await cdpLib.newPage(cdp);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#screen-login')?.hidden === false`, { label: 'login' });
  await cdpLib.evaluate(cdp, sessionId, `['1','2','3','4'].forEach(d => document.querySelector('#pinpad [data-key="'+d+'"]').click())`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#screen-home')?.hidden === false`, { label: 'home' });

  // ── 1. screen server killed behind the app's back ──────────────
  console.log('  · stopping x11vnc…');
  sh('pkill -f "x11vnc -display" || true');
  await cdpLib.sleep(1200);
  check('x11vnc is really stopped', !(await portOpen(5900)));

  // the app's own health poll should notice
  const pill = await cdpLib.waitFor(cdp, sessionId,
    `document.querySelector('#hero-vnc')?.textContent.includes('offline') ? 'offline' : null`,
    { timeout: 15000, label: 'home screen notices VNC is down' });
  check('home screen notices the screen server is down', pill === 'offline');

  // opening the remote screen must auto-start VNC again and connect
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-connect').click()`);
  const connected = await cdpLib.waitFor(cdp, sessionId,
    `document.querySelector('#remote-status')?.hidden === true ? 'connected' : null`,
    { timeout: 30000, label: 'auto-recovery' }).catch(() => null);
  check('opening the remote screen restarts the screen server by itself', connected === 'connected',
    connected ? '' : await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#remote-status-text').textContent`));
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '30-recovered.png'));

  // ── 2. drop the screen server *while* connected ────────────────
  console.log('  · killing the screen server mid-session…');
  sh('pkill -f "x11vnc -display" || true');
  const recovered = await cdpLib.waitFor(cdp, sessionId,
    `document.querySelector('#remote-status')?.hidden === true ? 'reconnected' : null`,
    { timeout: 30000, label: 'auto-reconnect after mid-session kill' }).catch(() => null);
  const overlayText = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#remote-status-text').textContent`);
  check('a dropped session either recovers by itself or explains why',
    recovered === 'reconnected' || /screen server|Reconnecting|cut|dropped|Wi-Fi/i.test(overlayText),
    recovered === 'reconnected' ? 'reconnected automatically' : overlayText);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '31-after-drop.png'));

  // ── 3. unrecoverable: diagnostics must point at the failing step ──
  console.log('  · running diagnostics with the screen server unavailable…');
  sh('pkill -f "x11vnc -display" || true; sleep 0.5');
  const report = await cdpLib.evaluate(cdp, sessionId,
    `window.__pd.api('/api/diagnostics').then(r => ${JSON.stringify('')} === '' ? { ws: r.data.checks.websocketProxy, listens: r.data.checks.vncListening, warnings: r.data.warnings, greeting: r.data.checks.vncGreeting } : null)`);
  check('diagnostics flags the screen server as the failing step',
    report && (report.listens === false || report.ws === false) && report.warnings.length > 0,
    report ? report.warnings[0] : 'no report');

  // recovery for the next test run
  sh('DISPLAY=:99 x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet -bg >/dev/null 2>&1 || true');
  await cdpLib.sleep(1500);

  cdp.close();
  browser.close();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}\n`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('\n  failure-test error:', err.message);
  process.exit(2);
});
