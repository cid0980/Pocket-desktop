#!/usr/bin/env node
'use strict';
/**
 * Virtual gamepad test — proves the PC really sees an Xbox pad and a mouse.
 *
 * Starts tools/pad-uinput.py, finds the devices it created under
 * /sys/class/input, injects events and reads them straight back off the event
 * node, so we know games will see them too.
 *
 * Needs access to /dev/uinput: run it as root (`sudo node test/uinput-test.js`)
 * or after install.sh has added the udev rule. Skips (exit 0) when uinput is
 * unavailable, so it never fails a machine that simply cannot do this.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DAEMON = path.join(ROOT, 'tools', 'pad-uinput.py');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let passed = 0; let failed = 0; const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Name → /dev/input/eventN, read from sysfs. */
function findEventNodes() {
  const found = {};
  const dir = '/sys/class/input';
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir)) {
    if (!/^event\d+$/.test(entry)) continue;
    const namePath = path.join(dir, entry, 'device', 'name');
    try {
      const name = fs.readFileSync(namePath, 'utf8').trim();
      found[name] = `/dev/input/${entry}`;
    } catch { /* ignore */ }
  }
  return found;
}

const PAD_NAME = 'Microsoft X-Box 360 pad';
const MOUSE_NAME = 'Pocket Desktop virtual mouse';

function decodeEvents(buf) {
  const events = [];
  for (let off = 0; off + 24 <= buf.length; off += 24) {
    events.push({
      type: buf.readUInt16LE(off + 16),
      code: buf.readUInt16LE(off + 18),
      value: buf.readInt32LE(off + 20),
    });
  }
  return events;
}

(async function main() {
  console.log('\nPocket Desktop virtual gamepad test\n');

  if (!fs.existsSync('/dev/uinput')) {
    console.log('  · /dev/uinput not present — skipping (not a desktop system)');
    process.exit(0);
  }
  if (!IS_ROOT) {
    let canSudo = false;
    try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' }); canSudo = true; } catch { /* ignore */ }
    if (!canSudo) {
      console.log('  · no permission on /dev/uinput — skipping (run install.sh, or run this as root)');
      process.exit(0);
    }
  }

  const args = IS_ROOT ? [DAEMON] : ['-n', 'python3', DAEMON];
  const bin = IS_ROOT ? 'python3' : 'sudo';
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let errText = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { errText += d.toString(); });

  const ready = await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const tick = () => {
      if (/READY|ERROR/.test(out) || Date.now() > deadline) resolve(out);
      else setTimeout(tick, 100);
    };
    tick();
  });

  check('the virtual input daemon starts', /READY/.test(ready),
    /ERROR/.test(ready) ? (ready.split('\n')[0] || '') : 'devices created');

  if (!/READY/.test(ready)) {
    console.log(`\n  daemon said: ${ready.trim() || errText.trim()}\n`);
    child.kill('SIGKILL');
    process.exit(1);
  }

  /* ── the PC must see both devices ───────────────────────────────── */
  await sleep(400);
  const nodes = findEventNodes();
  check('the PC sees an Xbox 360 pad', Boolean(nodes[PAD_NAME]), nodes[PAD_NAME] || 'not found');
  check('the PC sees the virtual mouse', Boolean(nodes[MOUSE_NAME]), nodes[MOUSE_NAME] || 'not found');

  /* ── keepalive ──────────────────────────────────────────────────── */
  out = '';
  child.stdin.write('ping\n');
  await sleep(300);
  check('the daemon answers keepalives', /PONG/.test(out));

  /* ── inject events and read them back ───────────────────────────── */
  const padNode = nodes[PAD_NAME];
  const mouseNode = nodes[MOUSE_NAME];
  let padFd = null;
  let mouseFd = null;
  try {
    // Must be non-blocking: a blocking readSync on an event node never returns.
    const flags = (fs.constants.O_RDONLY || 0) | (fs.constants.O_NONBLOCK || 0);
    if (padNode) padFd = fs.openSync(padNode, flags);
    if (mouseNode) mouseFd = fs.openSync(mouseNode, flags);
  } catch { /* reading may need privileges we do not have */ }

  const drain = (fd) => {
    if (fd === null) return Buffer.alloc(0);
    const chunks = [];
    const buf = Buffer.alloc(24 * 64);
    try {
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
    } catch { /* EAGAIN: nothing more */ }
    return Buffer.concat(chunks);
  };

  if (padFd !== null) {
    // press A, push the left stick right, then release
    child.stdin.write('* p a 1; a lx 16000; a lt 200\n');
    await sleep(400);
    const padEvents = decodeEvents(drain(padFd));
    const btnA = padEvents.find((e) => e.type === 1 && e.code === 0x130);
    const stick = padEvents.find((e) => e.type === 3 && e.code === 0x00);
    const trigger = padEvents.find((e) => e.type === 3 && e.code === 0x02);
    check('the pad reports the A button', Boolean(btnA) && btnA.value === 1,
      btnA ? `BTN_A=${btnA.value}` : 'no button event');
    check('the pad reports analog stick movement', Boolean(stick) && stick.value === 16000,
      stick ? `ABS_X=${stick.value}` : 'no axis event');
    check('the pad reports an analog trigger', Boolean(trigger) && trigger.value === 200,
      trigger ? `ABS_Z=${trigger.value}` : 'no trigger event');

    child.stdin.write('p a 0\n');
    await sleep(300);
    const released = decodeEvents(drain(padFd)).find((e) => e.type === 1 && e.code === 0x130);
    check('the pad reports the button release', Boolean(released) && released.value === 0,
      released ? `BTN_A=${released.value}` : 'no release event');
  } else {
    console.log('  · cannot read the pad event node here — skipping event read-back');
  }

  if (mouseFd !== null) {
    child.stdin.write('* m 12 -7; c 3 1\n');
    await sleep(400);
    const mouseEvents = decodeEvents(drain(mouseFd));
    const relX = mouseEvents.find((e) => e.type === 2 && e.code === 0x00);
    const relY = mouseEvents.find((e) => e.type === 2 && e.code === 0x01);
    const right = mouseEvents.find((e) => e.type === 1 && e.code === 0x111);
    check('the mouse moves the pointer', Boolean(relX) && relX.value === 12 && Boolean(relY) && relY.value === -7,
      relX ? `dx=${relX.value} dy=${relY ? relY.value : '?'}` : 'no motion event');
    check('the mouse reports a right-click', Boolean(right) && right.value === 1,
      right ? `BTN_RIGHT=${right.value}` : 'no click event');
  } else {
    console.log('  · cannot read the mouse event node here — skipping event read-back');
  }

  /* ── bad input must not kill it ─────────────────────────────────── */
  child.stdin.write('nonsense line\n');
  child.stdin.write('a madeupaxis 5\n');
  await sleep(200);
  out = '';
  child.stdin.write('ping\n');
  await sleep(300);
  check('a malformed command does not kill the daemon', /PONG/.test(out) && child.exitCode === null);

  child.stdin.write('q\n');
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000); });
  check('the daemon shuts down cleanly', child.exitCode === 0 || child.exitCode === null,
    `exit ${child.exitCode}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) { console.log(`  failures: ${failures.join(', ')}\n`); process.exit(1); }
  process.exit(0);
})().catch((err) => {
  console.error('\n  uinput-test error:', err.message);
  process.exit(2);
});
