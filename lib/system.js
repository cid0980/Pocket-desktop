'use strict';
/** Machine info, power actions, screenshots and the push-to-talk bridge. */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const vnc = require('./vnc');

let prevCpu = null;
let infoCache = { at: 0, data: null };

function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function cpuPercent() {
  const now = readCpuTimes();
  if (!now) return null;
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) return null;
  const totalDelta = now.total - prev.total;
  const idleDelta = now.idle - prev.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

function memory() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')) || [])[1] || 0) * 1024;
    const total = get('MemTotal');
    const available = get('MemAvailable');
    return { total, used: total - available, available, percent: total ? Math.round(((total - available) / total) * 100) : null };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem(), percent: null };
  }
}

function battery() {
  try {
    const base = '/sys/class/power_supply';
    for (const name of fs.readdirSync(base)) {
      if (!/^BAT/.test(name)) continue;
      const dir = path.join(base, name);
      const cap = Number(fs.readFileSync(path.join(dir, 'capacity'), 'utf8').trim());
      const status = fs.readFileSync(path.join(dir, 'status'), 'utf8').trim();
      return { percent: cap, status };
    }
  } catch { /* no battery */ }
  return null;
}

async function disk() {
  const res = await vnc.run('df', ['-kP', '/'], { timeout: 4000 });
  if (!res.ok) return null;
  const lines = res.stdout.split('\n');
  if (lines.length < 2) return null;
  const cols = lines[1].split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  return { total, used, percent: total ? Math.round((used / total) * 100) : null };
}

async function info({ force = false } = {}) {
  if (!force && infoCache.data && Date.now() - infoCache.at < 2000) return infoCache.data;
  const cfg = config.load();
  const session = vnc.detectSession();
  const [diskInfo, vncStatus] = await Promise.all([disk(), vnc.status()]);
  const data = {
    hostname: os.hostname(),
    appName: cfg.name,
    user: os.userInfo().username,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpuCount: os.cpus().length,
    cpuPercent: cpuPercent(),
    cpuModel: os.cpus()[0]?.model?.trim() || null,
    memory: memory(),
    disk: diskInfo,
    battery: battery(),
    temperature: readTemperature(),
    sessionType: session.sessionType,
    display: session.display,
    wayland: session.wayland,
    vnc: vncStatus,
    version: config.VERSION,
  };
  infoCache = { at: Date.now(), data };
  return data;
}

function readTemperature() {
  try {
    const base = '/sys/class/thermal';
    for (const zone of fs.readdirSync(base)) {
      if (!zone.startsWith('thermal_zone')) continue;
      const t = Number(fs.readFileSync(path.join(base, zone, 'temp'), 'utf8').trim());
      if (t > 1000) return Math.round(t / 1000);
      if (t > 0) return Math.round(t);
    }
  } catch { /* ignore */ }
  return null;
}

/** Take a screenshot of the X display. */
async function screenshot() {
  const session = vnc.detectSession();
  const tools = await vnc.toolsStatus();
  const file = path.join(os.tmpdir(), `pocket-desktop-${Date.now()}.png`);
  const env = { ...process.env, DISPLAY: session.display };
  if (session.xauth) env.XAUTHORITY = session.xauth;

  const attempts = [];
  if (tools.screenshot?.endsWith('gnome-screenshot')) attempts.push(['gnome-screenshot', ['-f', file]]);
  if (tools.screenshot?.endsWith('scrot')) attempts.push(['scrot', ['-o', file]]);
  if (tools.screenshot?.endsWith('spectacle')) attempts.push(['spectacle', ['-b', '-n', '-o', file]]);
  if (tools.screenshot?.endsWith('xfce4-screenshooter')) attempts.push(['xfce4-screenshooter', ['-f', '-s', file]]);
  if (tools.screenshot?.endsWith('import')) attempts.push(['import', ['-window', 'root', file]]);
  // last resort: ImageMagick 7 may only ship the `magick` multiplexer
  attempts.push(['magick', ['import', '-window', 'root', file]]);
  if (!attempts.length) {
    return { ok: false, error: 'No screenshot tool found. Install one: sudo apt install gnome-screenshot (or scrot / imagemagick)' };
  }

  for (const [cmd, args] of attempts) {
    const res = await vnc.run(cmd, args, { timeout: 15000, env });
    if (res.ok && fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      fs.unlink(file, () => {});
      return { ok: true, data: buf, tool: path.basename(cmd) };
    }
  }
  return { ok: false, error: 'Screenshot failed. On Wayland only screen-casting style tools work; on X11 install scrot or imagemagick.' };
}

function dbusEnv() {
  const uid = process.getuid();
  const bus = `/run/user/${uid}/bus`;
  return { ...process.env, DBUS_SESSION_BUS_ADDRESS: fs.existsSync(bus) ? `unix:path=${bus}` : process.env.DBUS_SESSION_BUS_ADDRESS };
}

/** Lock / suspend / reboot / power off. */
async function power(action) {
  const env = dbusEnv();
  const steps = {
    lock: [
      ['loginctl', ['lock-sessions'], env],
      ['dbus-send', ['--session', '--dest=org.gnome.ScreenSaver', '--type=method_call', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.Lock'], env],
      ['xdg-screensaver', ['lock'], env],
      ['gnome-screensaver-command', ['-l'], env],
    ],
    suspend: [['systemctl', ['suspend'], env]],
    reboot: [['systemctl', ['reboot'], env]],
    poweroff: [['systemctl', ['poweroff'], env]],
  };
  if (!steps[action]) return { ok: false, error: `Unknown action "${action}"` };
  const errors = [];
  for (const [cmd, args, e] of steps[action]) {
    const res = await vnc.run(cmd, args, { timeout: 12000, env: e });
    if (res.ok) return { ok: true, action, via: cmd };
    errors.push(`${cmd}: ${res.stderr || res.error || 'failed'}`);
  }
  return {
    ok: false,
    action,
    error: errors.join(' · '),
    hint: 'If this needs privileges, re-run install.sh --with-sudo to allow exactly these commands.',
  };
}

/* ------------------------------------------------------------------ *
 * Push to talk: hold the button on your phone → the PC mic records and
 * plays through the speakers, while (optionally) holding a talk key.
 * ------------------------------------------------------------------ */

const ptt = { recording: null, file: null, keyDown: false };

async function pttStart() {
  const cfg = config.load();
  const tools = await vnc.toolsStatus();
  if (ptt.recording) return { ok: true, already: true };
  if (!tools.arecord) {
    return { ok: false, error: 'arecord not found. Install: sudo apt install alsa-utils' };
  }
  const file = path.join(os.tmpdir(), `pocket-desktop-ptt-${Date.now()}.wav`);
  ptt.file = file;
  const args = ['-q', '-f', 'S16_LE', '-r', '44100', '-c', '1', '-t', 'wav', file];
  const device = cfg.ptt.device && cfg.ptt.device !== 'default' ? ['-D', cfg.ptt.device] : [];
  ptt.recording = spawn('arecord', [...device, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  ptt.recording.on('error', () => {
    ptt.recording = null;
  });
  if (tools.xdotool && cfg.ptt.key) {
    await vnc.run('xdotool', ['keydown', cfg.ptt.key], { timeout: 4000, env: dbusEnv() });
    ptt.keyDown = true;
  }
  return { ok: true, file };
}

async function pttStop({ play = true } = {}) {
  const cfg = config.load();
  if (!ptt.recording) return { ok: true, already: true };
  const proc = ptt.recording;
  ptt.recording = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGINT'); // SIGINT makes arecord finalise the wav header
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 1500);
  });
  if (ptt.keyDown) {
    await vnc.run('xdotool', ['keyup', cfg.ptt.key], { timeout: 4000, env: dbusEnv() });
    ptt.keyDown = false;
  }
  const file = ptt.file;
  ptt.file = null;
  const tools = await vnc.toolsStatus();
  if (play && file && fs.existsSync(file) && tools.arecord) {
    // aplay ships with alsa-utils; only play if the user asked for it
    const aplay = file.replace(/.*/, 'aplay');
    const res = await vnc.run(aplay, ['-q', file], { timeout: 20000 });
    if (!res.ok) {
      await vnc.run('paplay', [file], { timeout: 20000 });
    }
    setTimeout(() => fs.unlink(file, () => {}), 60000);
  }
  return { ok: true, file, played: play };
}

async function pttCancel() {
  if (ptt.recording) {
    const proc = ptt.recording;
    ptt.recording = null;
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
  if (ptt.keyDown) {
    await vnc.run('xdotool', ['keyup', config.load().ptt.key], { timeout: 4000, env: dbusEnv() });
    ptt.keyDown = false;
  }
  if (ptt.file) {
    const f = ptt.file;
    ptt.file = null;
    fs.unlink(f, () => {});
  }
  return { ok: true };
}

function pttState() {
  return { active: Boolean(ptt.recording) };
}

module.exports = { info, screenshot, power, pttStart, pttStop, pttCancel, pttState, dbusEnv };
