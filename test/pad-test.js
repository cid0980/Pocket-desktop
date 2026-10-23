#!/usr/bin/env node
'use strict';
/**
 * Gamepad UI test — drives the real controller in a browser and checks that
 * genuine uinput events come out the other side.
 *
 * Needs /dev/uinput (root here, or after install.sh on a real PC). When it is
 * unavailable the UI checks are skipped, so this never fails a machine that
 * simply cannot do virtual input.
 *
 *   sudo node --experimental-websocket test/pad-test.js --port 8765 --pin 1234
 */

const fs = require('fs');
const path = require('path');
const cdpLib = require('./cdp');

const ROOT = path.join(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(ARTIFACTS, {recursive:true});

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(getArg('--port', 8765));
const PIN = getArg('--pin', '1234');
const BASE = `http://127.0.0.1:${PORT}`;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let passed = 0; let failed = 0; const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

/**
 * Newest matching event node. A daemon killed by SIGKILL leaves its device
 * behind, so several nodes can share a name — the highest number is the live
 * one.
 */
function findEventNode(name) {
  const dir = '/sys/class/input';
  if (!fs.existsSync(dir)) return null;
  let best = -1;
  for (const entry of fs.readdirSync(dir)) {
    const m = /^event(\d+)$/.exec(entry);
    if (!m) continue;
    try {
      if (fs.readFileSync(path.join(dir, entry, 'device', 'name'), 'utf8').trim() === name) {
        best = Math.max(best, Number(m[1]));
      }
    } catch { /* ignore */ }
  }
  return best >= 0 ? `/dev/input/event${best}` : null;
}

function decodeEvents(buf) {
  const events = [];
  for (let off = 0; off + 24 <= buf.length; off += 24) {
    events.push({ type: buf.readUInt16LE(off + 16), code: buf.readUInt16LE(off + 18), value: buf.readInt32LE(off + 20) });
  }
  return events;
}

(async function main() {
  console.log('\nPocket Desktop gamepad UI test\n');

  const uinputOk = fs.existsSync('/dev/uinput') && IS_ROOT;
  if (!uinputOk) console.log('  · /dev/uinput not writable here — UI-only run\n');

  const browser = await cdpLib.launchBrowser({ port: 9344 });
  const cdp = await cdpLib.CDP.connect(browser.version.webSocketDebuggerUrl);
  const { sessionId } = await cdpLib.newPage(cdp);

  // landscape phone, touch enabled — how you would actually hold it to play
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
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

  try {
    await cdp.send('Page.navigate', { url: BASE }, sessionId);
    await cdpLib.waitFor(cdp, sessionId, "document.querySelector('#screen-login') && !document.querySelector('#screen-login').hidden", { timeout: 15000, label: 'login' });

    // sign in
    const tapKey = (digit) => cdpLib.evaluate(cdp, sessionId,
      `document.querySelector('#pinpad [data-key="' + ${JSON.stringify(digit)} + '"]').click()`);
    for (const d of PIN.split('')) { await tapKey(d); await cdpLib.sleep(90); }
    await cdpLib.waitFor(cdp, sessionId, "!document.querySelector('#screen-home').hidden", { timeout: 15000, label: 'home' });
    check('signed in and reached the home screen', true);

    check('the home screen offers a Gamepad tile',
      await cdpLib.evaluate(cdp, sessionId, "Boolean(document.querySelector('#tile-pad'))"));

    // open the gamepad
    await cdpLib.evaluate(cdp, sessionId, "document.querySelector('#tile-pad').click()");
    await cdpLib.waitFor(cdp, sessionId, "!document.querySelector('#screen-pad').hidden", { timeout: 10000, label: 'gamepad screen' });
    check('the gamepad screen opens full screen', true);

    const layout = await cdpLib.evaluate(cdp, sessionId, `(() => {
      const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
      return {
        move: q('#pad-move'), look: q('#pad-look'), a: q('.pad-btn.a'), face: q('.pad-face'),
        dpad: q('#pad-dpad'), lt: q('#pad-lt'), leftClick: q('#pad-click-left'), rightClick: q('#pad-click-right'),
        viewport: { w: innerWidth, h: innerHeight },
        buttons: document.querySelectorAll('[data-pad-btn]').length,
      };
    })()`);

    check('two analog stick zones are laid out side by side',
      layout.move && layout.look && layout.move.x < layout.look.x && layout.move.w > 100,
      `move ${layout.move?.w}px at x=${layout.move?.x}, look at x=${layout.look?.x}`);
    check('all four face buttons are present', layout.buttons >= 4, `${layout.buttons} pad buttons`);
    check('left and right click are reachable',
      Boolean(layout.leftClick?.w) && Boolean(layout.rightClick?.w),
      `L ${layout.leftClick?.w}px, R ${layout.rightClick?.w}px`);
    check('the layout fits the screen without scrolling',
      (layout.face?.y || 0) + (layout.face?.h || 0) <= layout.viewport.h + 1,
      `face ends at ${(layout.face?.y || 0) + (layout.face?.h || 0)} of ${layout.viewport.h}`);

    await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '40-gamepad.png'));

    /* ── does real hardware see the input? ─────────────────────────── */
    const padNode = uinputOk ? findEventNode('Microsoft X-Box 360 pad') : null;
    const mouseNode = uinputOk ? findEventNode('Pocket Desktop virtual mouse') : null;

    if (!uinputOk) {
      console.log('  · skipping hardware checks (no uinput access)');
    } else {
      const status = await cdpLib.evaluate(cdp, sessionId, `
        fetch('/api/pad/status', { headers: { Authorization: 'Bearer ' + localStorage.getItem('pd_token') } })
          .then((r) => r.json()).then((j) => j.data)
      `);
      check('the PC created the virtual controller', status?.available === true,
        status ? `mode ${status.mode}` : 'no status');

      const padFd = padNode ? fs.openSync(padNode, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) : null;
      const mouseFd = mouseNode ? fs.openSync(mouseNode, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) : null;

      const drain = (fd) => {
        if (fd === null) return Buffer.alloc(0);
        const chunks = [];
        const buf = Buffer.alloc(24 * 128);
        try {
          for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (!n) break;
            chunks.push(Buffer.from(buf.subarray(0, n)));
          }
        } catch { /* EAGAIN */ }
        return Buffer.concat(chunks);
      };

      // Press the A button with a real touch.
      const box = await cdpLib.evaluate(cdp, sessionId, `(() => {
        const r = document.querySelector('.pad-btn.a').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await cdpLib.sendTouch(cdp, sessionId, 'touchStart', [{ x: box.x, y: box.y }]);
      await cdpLib.sleep(350);
      let evs = decodeEvents(drain(padFd));
      const btnA = evs.find((e) => e.type === 1 && e.code === 0x130);
      check('touching A sends a real A press to the PC', Boolean(btnA) && btnA.value === 1,
        btnA ? `BTN_A=${btnA.value}` : `saw ${evs.length} events`);

      await cdpLib.sendTouch(cdp, sessionId, 'touchEnd', []);
      await cdpLib.sleep(300);
      evs = decodeEvents(drain(padFd));
      const btnAUp = evs.find((e) => e.type === 1 && e.code === 0x130);
      check('releasing A releases it on the PC', Boolean(btnAUp) && btnAUp.value === 0,
        btnAUp ? `BTN_A=${btnAUp.value}` : 'no release');

      for (const [axis,code] of [['lt',2],['rt',5]]) {
        const pt=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#pad-${axis}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        drain(padFd);
        await cdpLib.sendTouch(cdp,sessionId,'touchStart',[pt]); await cdpLib.sleep(100);
        check(axis+' reaches full analog range',decodeEvents(drain(padFd)).some(e=>e.type===3&&e.code===code&&e.value===255));
        await cdpLib.sendTouch(cdp,sessionId,'touchMove',[{x:pt.x,y:pt.y-50}]); await cdpLib.sleep(100);
        check(axis+' supports partial travel',decodeEvents(drain(padFd)).some(e=>e.type===3&&e.code===code&&e.value>90&&e.value<170));
        await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]); await cdpLib.sleep(100);
        check(axis+' releases to zero',decodeEvents(drain(padFd)).some(e=>e.type===3&&e.code===code&&e.value===0));
      }

      for (const [name,code] of Object.entries({b:0x131,x:0x134,y:0x133,lb:0x136,rb:0x137,back:0x13a,start:0x13b,guide:0x13c,ls:0x13d,rs:0x13e})) {
        const pt=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('[data-pad-btn="${name}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        drain(padFd); await cdpLib.sendTouch(cdp,sessionId,'touchStart',[pt]); await cdpLib.sleep(60);
        check(name+' press reaches kernel',decodeEvents(drain(padFd)).some(e=>e.type===1&&e.code===code&&e.value===1));
        await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]); await cdpLib.sleep(60);
        check(name+' release reaches kernel',decodeEvents(drain(padFd)).some(e=>e.type===1&&e.code===code&&e.value===0));
      }

      // Drag the left stick.
      const stick = await cdpLib.evaluate(cdp, sessionId, `(() => {
        const r = document.querySelector('#pad-move').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await cdpLib.sendTouch(cdp, sessionId, 'touchStart', [{ x: stick.x, y: stick.y }]);
      await cdpLib.sendTouch(cdp, sessionId, 'touchMove', [{ x: stick.x + 60, y: stick.y }]);
      await cdpLib.sleep(350);
      evs = decodeEvents(drain(padFd));
      const stickX = evs.filter((e) => e.type === 3 && e.code === 0x00).pop();
      check('dragging the stick sends analog movement', Boolean(stickX) && stickX.value > 8000,
        stickX ? `ABS_X=${stickX.value}` : `saw ${evs.length} events`);

      await cdpLib.sendTouch(cdp, sessionId, 'touchEnd', []);
      await cdpLib.sleep(300);
      evs = decodeEvents(drain(padFd));
      const centred = evs.filter((e) => e.type === 3 && e.code === 0x00).pop();
      check('letting go centres the stick', Boolean(centred) && centred.value === 0,
        centred ? `ABS_X=${centred.value}` : 'no centre event');

      for(const [direction,ox,oy,axis,value] of [['up',0,-32,17,-1],['down',0,32,17,1],['left',-32,0,16,-1],['right',32,0,16,1]]) {
        const pt=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#pad-dpad').getBoundingClientRect();return {x:r.x+r.width/2+${ox},y:r.y+r.height/2+${oy}};})()`);
        drain(padFd);await cdpLib.sendTouch(cdp,sessionId,'touchStart',[pt]);await cdpLib.sleep(70);
        check('D-pad '+direction+' reaches kernel',decodeEvents(drain(padFd)).some(e=>e.type===3&&e.code===axis&&e.value===value));
        await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]);await cdpLib.sleep(70);
        check('D-pad '+direction+' centres',decodeEvents(drain(padFd)).some(e=>e.type===3&&e.code===axis&&e.value===0));
      }
      const look=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#pad-look').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      drain(padFd);await cdpLib.sendTouch(cdp,sessionId,'touchStart',[look]);await cdpLib.sendTouch(cdp,sessionId,'touchMove',[{x:look.x+45,y:look.y+20}]);await cdpLib.sleep(70);
      const lookEvents=decodeEvents(drain(padFd));check('right stick sends both axes',lookEvents.some(e=>e.type===3&&e.code===3&&e.value>0)&&lookEvents.some(e=>e.type===3&&e.code===4&&e.value>0));
      await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]);await cdpLib.sleep(70);
      const lookReleased=decodeEvents(drain(padFd));check('right stick centres both axes',lookReleased.some(e=>e.type===3&&e.code===3&&e.value===0)&&lookReleased.some(e=>e.type===3&&e.code===4&&e.value===0));

      // Right click.
      const rc = await cdpLib.evaluate(cdp, sessionId, `(() => {
        const r = document.querySelector('#pad-click-right').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await cdpLib.sendTouch(cdp, sessionId, 'touchStart', [{ x: rc.x, y: rc.y }]);
      await cdpLib.sleep(350);
      const mouseEvs = decodeEvents(drain(mouseFd));
      const rightDown = mouseEvs.find((e) => e.type === 1 && e.code === 0x111);
      check('the right-click button presses the real right button',
        Boolean(rightDown) && rightDown.value === 1,
        rightDown ? `BTN_RIGHT=${rightDown.value}` : `saw ${mouseEvs.length} events`);
      await cdpLib.sendTouch(cdp, sessionId, 'touchEnd', []);

      await cdpLib.screenshot(cdp, sessionId, path.join(ARTIFACTS, '41-gamepad-active.png'));
      // Dedicated touchpad → the same real virtual mouse device.
      await cdpLib.evaluate(cdp,sessionId,"document.querySelector('#pad-to-mouse').click()");
      await cdpLib.sleep(400);
      drain(mouseFd);
      const surface=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#mouse-surface').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdpLib.sendTouch(cdp,sessionId,'touchStart',[surface]);
      await cdpLib.sendTouch(cdp,sessionId,'touchMove',[{x:surface.x+30,y:surface.y+15}]);
      await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]); await cdpLib.sleep(100);
      const movement=decodeEvents(drain(mouseFd));
      check('touchpad emits real REL_X without accidental clicks',movement.some(e=>e.type===2&&e.code===0&&e.value>0)&&!movement.some(e=>e.type===1&&e.value===1));
      for(const [side,code] of [['left',0x110],['right',0x111]]) {
        const pt=await cdpLib.evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#mouse-${side}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await cdpLib.sendTouch(cdp,sessionId,'touchStart',[pt]); await cdpLib.sleep(80);
        check('touchpad '+side+' real press',decodeEvents(drain(mouseFd)).some(e=>e.type===1&&e.code===code&&e.value===1));
        await cdpLib.sendTouch(cdp,sessionId,'touchEnd',[]); await cdpLib.sleep(80);
        check('touchpad '+side+' real release',decodeEvents(drain(mouseFd)).some(e=>e.type===1&&e.code===code&&e.value===0));
      }
      await cdpLib.evaluate(cdp,sessionId,"document.querySelector('#mouse-back').click()"); await cdpLib.sleep(400);
      if (padFd !== null) fs.closeSync(padFd);
      if (mouseFd !== null) fs.closeSync(mouseFd);
    }

    // Leaving must not leave a key stuck down.
    await cdpLib.evaluate(cdp, sessionId, "document.querySelector('#pad-exit').click()");
    await cdpLib.sleep(500);
    check('exiting returns to the home screen',
      await cdpLib.evaluate(cdp, sessionId, "!document.querySelector('#screen-home').hidden"));

    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none');
  } finally {
    try { await cdp.send('Browser.close', {}, sessionId); } catch { /* ignore */ }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  pad-test error:', err.message);
  process.exit(2);
});
