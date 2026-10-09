'use strict';
/**
 * Bridge to the virtual gamepad/mouse daemon (tools/pad-uinput.py).
 *
 * Games want a real controller, so we create one with uinput rather than
 * faking key presses: an Xbox 360 pad with analog sticks and triggers, plus a
 * relative mouse for phone-motion pointing.
 *
 * /dev/uinput usually needs root, so we try direct access first and fall back
 * to passwordless sudo; install.sh installs a udev rule that makes the direct
 * path work.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DAEMON = path.join(ROOT, 'tools', 'pad-uinput.py');

const AXES = new Set(['lx', 'ly', 'rx', 'ry', 'lt', 'rt', 'dx', 'dy']);
const BUTTONS = new Set(['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'guide', 'ls', 'rs']);
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right', '1', '2', '3']);
const AXIS_RANGE = { lx: 32767, ly: 32767, rx: 32767, ry: 32767, lt: 255, rt: 255, dx: 1, dy: 1 };

class PadBridge {
  constructor() {
    this.child = null;
    this.mode = null;          // 'direct' | 'sudo' | null
    this.error = null;
    this.hint = null;
    this.starting = null;
    this.ready = false;
    this.lastActivity = 0;
    this.sent = 0;
  }

  get available() {
    return Boolean(this.child && this.ready && !this.child.killed);
  }

  /** Start the daemon if it is not running yet. */
  async start() {
    if (this.available) return { ok: true, mode: this.mode };
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!fs.existsSync(DAEMON)) {
        this.error = 'the virtual gamepad helper is missing';
        return { ok: false, error: this.error };
      }
      // Direct first (works once install.sh has added the udev rule).
      let attempt = await this.spawn(false);
      if (!attempt.ok && /permission|denied|ioctl/i.test(attempt.error || '')) {
        attempt = await this.spawn(true); // fall back to passwordless sudo
      }
      this.starting = null;
      return attempt;
    })();

    return this.starting;
  }

  spawn(useSudo) {
    return new Promise((resolve) => {
      const args = useSudo ? ['-n', 'python3', DAEMON] : [DAEMON];
      const bin = useSudo ? 'sudo' : 'python3';
      let child;
      try {
        child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
      } catch (err) {
        this.error = err.message;
        return resolve({ ok: false, error: err.message });
      }

      let out = '';
      let errText = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.error = 'the virtual gamepad helper did not start';
        this.hint = useSudo ? null : 'run install.sh to allow access to /dev/uinput';
        finish({ ok: false, error: this.error, hint: this.hint });
      }, 8000);

      child.stdout.on('data', (d) => {
        out += d.toString();
        const readyLine = out.split('\n').find((l) => l.startsWith('READY '));
        const errorLine = out.split('\n').find((l) => l.startsWith('ERROR '));
        if (readyLine) {
          this.child = child;
          this.mode = useSudo ? 'sudo' : 'direct';
          this.ready = true;
          this.error = null;
          child.stderr.removeAllListeners('data');
          finish({ ok: true, mode: this.mode });
        } else if (errorLine) {
          let detail = {};
          try { detail = JSON.parse(errorLine.slice(6)); } catch { /* ignore */ }
          child.kill('SIGKILL');
          this.error = detail.error || 'unknown error';
          this.hint = detail.hint || null;
          finish({ ok: false, error: this.error, hint: this.hint, needsSetup: /permission-denied/.test(this.error) });
        }
      });

      child.stderr.on('data', (d) => { errText += d.toString(); });

      child.on('error', (err) => {
        if (/ENOENT/.test(err.code || '')) {
          this.error = useSudo ? 'sudo is not available' : 'python3 is not available';
        } else {
          this.error = err.message;
        }
        finish({ ok: false, error: this.error });
      });

      child.on('exit', (code) => {
        this.child = null;
        this.ready = false;
        if (!settled) {
          this.error = errText.trim().split('\n').slice(-1)[0] || `helper exited (${code})`;
          finish({ ok: false, error: this.error });
        }
      });
    });
  }

  /** Write a raw command line to the daemon. */
  send(line) {
    if (!this.available) return false;
    try {
      this.child.stdin.write(line + '\n');
      this.sent += 1;
      this.lastActivity = Date.now();
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  /** Send several commands under one sync (one frame of input). */
  sendBatch(commands) {
    if (!commands.length) return false;
    return this.send('* ' + commands.join('; '));
  }

  stop() {
    if (this.child) {
      try { this.child.stdin.write('q\n'); } catch { /* ignore */ }
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = null;
    this.ready = false;
    this.mode = null;
    return { ok: true };
  }

  /* ---------------- typed helpers ---------------- */

  axis(name, value) {
    if (!AXES.has(name)) return false;
    const limit = AXIS_RANGE[name];
    const v = Math.max(-limit, Math.min(limit, Math.round(Number(value) || 0)));
    return this.send(`a ${name} ${v}`);
  }

  button(name, down) {
    if (!BUTTONS.has(name)) return false;
    return this.send(`p ${name} ${down ? 1 : 0}`);
  }

  mouseMove(dx, dy) {
    const x = Math.max(-2000, Math.min(2000, Math.round(Number(dx) || 0)));
    const y = Math.max(-2000, Math.min(2000, Math.round(Number(dy) || 0)));
    if (!x && !y) return false;
    return this.send(`m ${x} ${y}`);
  }

  mouseButton(name, down) {
    if (!MOUSE_BUTTONS.has(name)) return false;
    return this.send(`c ${name} ${down ? 1 : 0}`);
  }

  wheel(delta) {
    const d = Math.max(-50, Math.min(50, Math.round(Number(delta) || 0)));
    if (!d) return false;
    return this.send(`w ${d}`);
  }

  status() {
    return {
      available: this.available,
      mode: this.mode,
      error: this.error,
      hint: this.hint,
      uinput: fs.existsSync('/dev/uinput'),
      helper: fs.existsSync(DAEMON),
      commandsSent: this.sent,
      lastActivity: this.lastActivity || null,
    };
  }
}

module.exports = new PadBridge();
module.exports.AXES = AXES;
module.exports.BUTTONS = BUTTONS;
module.exports.MOUSE_BUTTONS = MOUSE_BUTTONS;
