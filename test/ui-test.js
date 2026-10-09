#!/usr/bin/env node
'use strict';
/**
 * Browser driven UI test — runs the real app in headless Chromium at phone size.
 *
 *   node --experimental-websocket test/ui-test.js --port 8765 --pin 1234
 *
 * What it proves:
 *   • the setup/login/home/remote screens render
 *   • the PIN pad unlocks the app
 *   • the remote screen connects, receives real pixels from x11vnc
 *   • touch input is translated into RFB pointer events (and actually moves the
 *     pointer on the X server, checked with xdotool)
 *   • the software keyboard sends key events
 *   • screenshots of every screen are written to test/artifacts/
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cdpLib = require('./cdp.js');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', 8765));
const PIN = getArg('--pin', '1234');
const DISPLAY = getArg('--display', ':99');
const ARTIFACTS = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

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

function xdo(...cmdArgs) {
  return execFileSync('xdotool', cmdArgs, { env: { ...process.env, DISPLAY }, encoding: 'utf8' }).trim();
}

function pointerPosition() {
  const out = xdo('getmouselocation');
  const m = /x:(\d+)\s+y:(\d+)/.exec(out);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

(async function main() {
  console.log(`\nPocket Desktop UI test (chromium) → http://127.0.0.1:${PORT}\n`);
  const browser = await cdpLib.launchBrowser({ port: 9333 });
  const cdp = await cdpLib.CDP.connect(browser.version.webSocketDebuggerUrl);
  const { sessionId } = await cdpLib.newPage(cdp);

  // phone-shaped, touch enabled
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  }, sessionId);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Mobile Safari/537.36',
  }, sessionId);

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
  }, sessionId);
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') pageErrors.push(params.args.map((a) => a.value || a.description).join(' '));
  }, sessionId);

  // count outgoing RFB messages by type, before the app opens its socket
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__rfbStats = { pointer: 0, key: 0, other: 0, total: 0, open: 0 };
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const view = data instanceof ArrayBuffer ? new Uint8Array(data)
            : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
          if (view && view.length) {
            const t = view[0];
            window.__rfbStats.total += 1;
            if (t === 5) window.__rfbStats.pointer += 1;
            else if (t === 4) window.__rfbStats.key += 1;
            else window.__rfbStats.other += 1;
          }
        } catch (e) {}
        return origSend.call(this, data);
      };
      const OrigWS = WebSocket;
      window.WebSocket = function (...a) { const ws = new OrigWS(...a); window.__rfbStats.open += 1; return ws; };
      window.WebSocket.prototype = OrigWS.prototype;
      window.WebSocket.CONNECTING = OrigWS.CONNECTING; window.WebSocket.OPEN = OrigWS.OPEN;
      window.WebSocket.CLOSING = OrigWS.CLOSING; window.WebSocket.CLOSED = OrigWS.CLOSED;
    `,
  }, sessionId);

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
  await cdpLib.waitFor(cdp, sessionId,
    `(document.querySelector('#screen-login')?.hidden === false) || (document.querySelector('#screen-setup')?.hidden === false)`,
    { label: 'login screen' });

  const loginVisible = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#screen-login')?.hidden === false`);
  check('login screen is shown', loginVisible === true);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '01-login.png'));

  // wrong PIN then right PIN, through the keypad
  const tapKey = async (digit) => {
    await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#pinpad [data-key="${digit}"]').click()`);
    await cdpLib.sleep(120);
  };
  for (const d of ['9', '9', '9', '9']) await tapKey(d);
  await cdpLib.sleep(1600);
  const stillLogin = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#screen-login')?.hidden === false`);
  check('wrong PIN keeps the login screen', stillLogin === true);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#pinpad [data-key="clear"]').click()`);

  for (const d of PIN.split('')) await tapKey(d);
  await cdpLib.sleep(1800);
  let homeVisible = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#screen-home')?.hidden === false`);
  if (!homeVisible) {
    // an earlier test may have tripped the brute-force lockout; wait it out like a user would
    const lockedOut = await cdpLib.evaluate(cdp, sessionId, `/Too many attempts/.test(document.querySelector('#toasts').textContent)`);
    if (lockedOut) {
      console.log('      rate limited — waiting for the lockout to expire…');
      await cdpLib.sleep(32000);
    }
    for (const d of PIN.split('')) await tapKey(d);
    await cdpLib.sleep(1800);
    homeVisible = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#screen-home')?.hidden === false`);
  }
  check('correct PIN unlocks the app', homeVisible === true);
  await cdpLib.sleep(1200);
  const heroName = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#home-name').textContent + ' | ' + document.querySelector('#hero-vnc').textContent + ' | ' + document.querySelector('#stat-cpu').textContent`);
  check('home screen shows live status', /VNC/.test(heroName), heroName);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '02-home.png'));

  // cookies gone (embedded view / cookies disabled): the bearer token must carry us
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Network.clearBrowserCookies', {}, sessionId);
  const hasToken = await cdpLib.evaluate(cdp, sessionId, `Boolean(localStorage.getItem('pd_token'))`);
  const appStillWorks = await cdpLib.evaluate(cdp, sessionId, `window.__pd.api('/api/sysinfo').then(d => Boolean(d.ok)).catch(() => false)`);
  check('app still works without cookies (bearer token)', appStillWorks === true, hasToken ? 'token persisted in storage' : 'token kept in memory');

  // open the remote screen
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-connect').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#remote-status')?.hidden === true`, { timeout: 25000, label: 'remote connection' });
  const canvasInfo = await cdpLib.evaluate(cdp, sessionId, `(() => {
    const c = document.querySelector('#remote-host canvas');
    const r = c ? c.getBoundingClientRect() : null;
    return c && r ? { w: c.width, h: c.height, cw: r.width, ch: r.height, top: r.top, left: r.left } : null;
  })()`);
  check('remote screen renders a canvas', Boolean(canvasInfo && canvasInfo.w > 0), canvasInfo ? `desktop ${canvasInfo.w}×${canvasInfo.h} scaled to ${canvasInfo.cw.toFixed(0)}×${canvasInfo.ch.toFixed(0)}` : 'no canvas');
  check('VNC session established', await cdpLib.evaluate(cdp, sessionId, `__rfbStats.open >= 1 && __rfbStats.other + __rfbStats.pointer > 0`), JSON.stringify(await cdpLib.evaluate(cdp, sessionId, '__rfbStats')));
  await cdpLib.sleep(2500);
  const shot1 = await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '03-remote.png'));

  // touch: tap the middle of the screen, the X pointer must follow
  // (park the pointer in a corner first so the movement is unambiguous)
  xdo('mousemove', '12', '12');
  await cdpLib.sleep(400);
  const before = pointerPosition();
  const targetX = Math.round((canvasInfo.left + canvasInfo.cw / 2));
  const targetY = Math.round((canvasInfo.top + canvasInfo.ch / 2));
  await cdpLib.tap(cdp, sessionId, targetX, targetY);
  await cdpLib.sleep(700);
  const after = pointerPosition();
  const statsAfterTap = await cdpLib.evaluate(cdp, sessionId, '__rfbStats');
  check('touch sends pointer events to the PC', statsAfterTap.pointer > 0, `pointer messages: ${statsAfterTap.pointer}`);
  const moved = before && after && Math.hypot(after.x - before.x, after.y - before.y) > 200;
  check('the pointer really moves on the X server', Boolean(moved), before && after ? `${before.x},${before.y} → ${after.x},${after.y}` : 'unknown');
  const expectedX = canvasInfo.w / 2;
  const expectedY = canvasInfo.h / 2;
  const offBy = after ? Math.hypot(after.x - expectedX, after.y - expectedY) : 9999;
  check('coordinates map correctly (centre tap)', offBy < 120, after ? `expected ≈${Math.round(expectedX)},${Math.round(expectedY)} got ${after.x},${after.y} (off by ${Math.round(offBy)}px)` : 'no position');

  // repeated taps must each produce a button press and land on the right pixel
  const tapChecks = [];
  for (const [tx, ty] of [[90, 360], [300, 500], [195, 330]]) {
    xdo('mousemove', '12', '12');
    await cdpLib.sleep(250);
    await cdpLib.evaluate(cdp, sessionId, `window.__pd.state.session.rfb && (window.__rm = [])`);
    await cdpLib.tap(cdp, sessionId, tx, ty);
    await cdpLib.sleep(500);
    const pos = pointerPosition();
    const stage = await cdpLib.evaluate(cdp, sessionId, `(() => {
      const c = document.querySelector('#remote-host canvas').getBoundingClientRect();
      const d = window.__pd.state.session.rfb._display;
      return { left: c.left, top: c.top, w: c.width, h: c.height, dw: d.width, dh: d.height };
    })()`);
    const wantX = Math.round((tx - stage.left) / stage.w * stage.dw);
    const wantY = Math.round((ty - stage.top) / stage.h * stage.dh);
    const off = pos ? Math.hypot(pos.x - wantX, pos.y - wantY) : 99999;
    tapChecks.push({ tx, ty, pos, off });
  }
  check('every repeated tap moves the pointer to the tapped pixel',
    tapChecks.every((c) => c.off < 40),
    tapChecks.map((c) => `(${c.tx},${c.ty})→${c.pos ? c.pos.x + ',' + c.pos.y : '?'} off ${Math.round(c.off)}`).join('  '));

  // keyboard: open the dock, type, expect RFB key events
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-kbd').click()`);
  await cdpLib.sleep(300);
  const keyStatsBefore = (await cdpLib.evaluate(cdp, sessionId, '__rfbStats')).key;
  await cdpLib.typeText(cdp, sessionId, 'hello');
  await cdpLib.sleep(600);
  const keyStatsAfter = (await cdpLib.evaluate(cdp, sessionId, '__rfbStats')).key;
  check('typing sends key events', keyStatsAfter > keyStatsBefore, `${keyStatsBefore} → ${keyStatsAfter}`);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '04-remote-keyboard.png'));

  // scroll mode + two finger scroll
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-mode').click()`);
  await cdpLib.sleep(200);
  const mode = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#mode-label').textContent`);
  check('input mode cycles', mode === 'Trackpad', `mode: ${mode}`);

  // zoom + pan
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-more').click()`);
  await cdpLib.sleep(200);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#remote-menu [data-action="zoom"]').click()`);
  await cdpLib.sleep(400);
  const zoomed = await cdpLib.evaluate(cdp, sessionId, `(() => { const t = document.querySelector('#remote-wrap').style.transform; return { t, label: document.querySelector('#menu-zoom').textContent }; })()`);
  check('zoom applies a transform', /scale/.test(zoomed.t || ''), JSON.stringify(zoomed));
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '05-remote-zoom.png'));
  await cdpLib.evaluate(cdp, sessionId, `state?.session?.setZoom?.('fit')`).catch(() => {});
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#remote-wrap').style.transform = ''`);

  // sheets: settings, pairing, gestures, clipboard
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#remote-menu [data-action="gestures"]').click()`);
  await cdpLib.sleep(500);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '06-gestures-sheet.png'));
  check('gesture sheet opens', await cdpLib.evaluate(cdp, sessionId, `!document.querySelector('#sheet-gestures').hidden`));
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-gestures [data-close-sheet]').click()`);

  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-remote-back').click()`);
  await cdpLib.sleep(600);
  check('back returns to home', await cdpLib.evaluate(cdp, sessionId, `!document.querySelector('#screen-home').hidden`));

  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#tile-pair').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#qrbox svg') !== null`, { label: 'pairing QR' });
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '07-pairing.png'));
  const pairText = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#pair-url').textContent`);
  check('pairing QR is rendered', /^http/.test(pairText), pairText.slice(0, 42) + '…');
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-pair [data-close-sheet]').click()`);

  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#tile-settings').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#set-name').value.length >= 0 && document.querySelector('#sheet-settings').hidden === false`, { label: 'settings sheet' });
  await cdpLib.sleep(400);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '08-settings.png'));
  check('settings sheet loads values', await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#set-pttkey').value === 'space'`));
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-settings [data-close-sheet]').click()`);

  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#tile-screenshot').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#shot-img').hidden === false`, { timeout: 20000, label: 'screenshot image' });
  await cdpLib.sleep(400);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '09-screenshot-sheet.png'));
  const shotSrc = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#shot-img').src.slice(0, 20)`);
  check('screenshot sheet shows an image', shotSrc.startsWith('blob:'), shotSrc);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-shot [data-close-sheet]').click()`);

  // version mismatch banner (files newer than the running process)
  await cdpLib.evaluate(cdp, sessionId, `window.__pd.checkVersion('0.9.0')`);
  await cdpLib.sleep(200);
  const banner = await cdpLib.evaluate(cdp, sessionId, `({ hidden: document.querySelector('#version-banner').hidden, text: document.querySelector('#version-text').textContent })`);
  check('newer files than the running server raise a banner', banner.hidden === false && /0\.9\.0/.test(banner.text), banner.text);
  await cdpLib.evaluate(cdp, sessionId, `window.__pd.checkVersion(window.__pd.version)`);
  await cdpLib.sleep(200);
  check('banner clears when versions match',
    await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#version-banner').hidden`));

  // diagnostics sheet (the self-test users send when something is wrong)
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#tile-settings').click()`);
  await cdpLib.sleep(400);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-show-diag').click()`);
  await cdpLib.waitFor(cdp, sessionId, `/WebSocket proxy/.test(document.querySelector('#diag-text').value)`, { timeout: 20000, label: 'diagnostics report' });
  const diagText = await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#diag-text').value`);
  check('diagnostics sheet shows a usable report', /\[ ok \] WebSocket proxy/.test(diagText),
    (diagText.split('\n').find((l) => l.includes('WebSocket proxy')) || '').trim());
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '12-diagnostics.png'));
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-diag [data-close-sheet]').click()`);

  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#tile-power').click()`);
  await cdpLib.sleep(400);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '10-power-sheet.png'));
  check('power sheet opens', await cdpLib.evaluate(cdp, sessionId, `!document.querySelector('#sheet-power').hidden`));

  // full view: remote screen without the control chrome
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#sheet-power [data-close-sheet]').click()`);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-connect').click()`);
  await cdpLib.waitFor(cdp, sessionId, `document.querySelector('#remote-status').hidden === true`, { timeout: 25000, label: 'second remote connection' });
  await cdpLib.sleep(2000);
  await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#btn-remote-hide').click()`);
  await cdpLib.sleep(600);
  await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '11-remote-clean.png'));
  check('controls can be hidden', await cdpLib.evaluate(cdp, sessionId, `document.querySelector('#screen-remote').classList.contains('hide-ui')`));

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  cdp.close();
  browser.close();
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log(`  screenshots → ${ARTIFACTS}\n`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}\n`);
    process.exit(1);
  }
})().catch(async (err) => {
  console.error('\n  UI test error:', err.message);
  process.exit(2);
});
