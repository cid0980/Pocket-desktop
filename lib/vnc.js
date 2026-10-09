'use strict';
/**
 * VNC side of things: find the desktop session, run/attach x11vnc, report status.
 *
 * Design notes
 * ------------
 *  - x11vnc is always started with `-localhost`, so the raw VNC port is never
 *    reachable from the network. Only this Node app is exposed, on one port,
 *    behind the PIN gate.
 *  - If an x11vnc system service exists we use it, otherwise we spawn x11vnc
 *    ourselves (so `node server.js` alone is enough to get started).
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const config = require('./config');

const VNC_UNIT = 'pocket-desktop-vnc.service';
let spawnedChild = null;
let lastStartError = null;

function run(cmd, args, { timeout = 8000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? (err.killed ? 'timed out' : err.message) : null,
      });
    });
  });
}

function which(bin) {
  return new Promise((resolve) => {
    execFile('sh', ['-lc', `command -v ${bin} 2>/dev/null || true`], { timeout: 4000 }, (err, stdout) => {
      resolve(String(stdout || '').trim() || null);
    });
  });
}

function netProbe(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function readSessionType() {
  if (process.env.XDG_SESSION_TYPE) return process.env.XDG_SESSION_TYPE.toLowerCase();
  // No session env (e.g. started from a system service): infer from the runtime dir.
  try {
    const runtime = `/run/user/${process.getuid()}`;
    if (fs.readdirSync(runtime).some((f) => f.startsWith('wayland-'))) return 'wayland';
  } catch { /* no runtime dir */ }
  if (process.env.DISPLAY) return 'x11';
  try {
    if (fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f))) return 'x11';
  } catch { /* ignore */ }
  const cfg = config.load();
  return cfg.sessionType || 'unknown';
}

function xSockets() {
  const dir = '/tmp/.X11-unix';
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^X\d+$/.test(f))
      .map((f) => ':' + f.slice(1))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find an Xauthority file that x11vnc can actually *read*.
 *
 * On many systems (LightDM especially) the only obvious candidate is
 * /var/run/lightdm/root/:0, which belongs to root — handing that to x11vnc
 * makes it exit with "Only root will have read permission for the file", so
 * readability is checked here and unreadable files are skipped.
 */
/**
 * Which process is listening on the VNC port?
 *
 * The app cheerfully works with any screen server already on the port, but a
 * foreign or half-broken one (started by another tool, or attached to a display
 * that no longer exists) accepts the RFB handshake and then hangs up — which
 * looks exactly like "the app is broken". Knowing the owner ends the guesswork.
 *
 * Reads /proc directly: no root, no lsof, no dependencies.
 */
function listeningInodes(port) {
  const wanted = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      if (f[3] !== '0A') continue;                 // 0A = TCP_LISTEN
      const hexPort = (f[1].split(':')[1] || '').toUpperCase();
      if (hexPort === wanted && f[9] && f[9] !== '0') inodes.push(f[9]);
    }
  }
  return inodes;
}

function pidForInode(inode) {
  let pids = [];
  try { pids = fs.readdirSync('/proc'); } catch { return null; }
  const target = `socket:[${inode}]`;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (link === target) return Number(pid);
    }
  }
  return null;
}

function portOwner(port) {
  for (const inode of listeningInodes(port)) {
    const pid = pidForInode(inode);
    if (!pid) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
    } catch { cmd = ''; }
    const binary = (cmd.split(' ')[0] || '').split('/').pop() || `pid ${pid}`;
    // Ours carries the flags install.sh/run.sh always pass.
    const ours = /x11vnc/.test(binary) && /-forever/.test(cmd) && /-shared/.test(cmd);
    return { pid, cmd, binary, ours, unknown: !cmd };
  }
  return null;
}

/** Does this look like a VNC server we are safe to restart? */
function looksLikeVncServer(owner) {
  if (!owner) return false;
  // Check both: a wrapper (`node /usr/lib/vino/vino-server`, `python3 …`)
  // only reveals itself in the full command line.
  const pattern = /x11vnc|Xvnc|x0vncserver|vino|tigervnc|vncserver|wayvnc|krfb/i;
  return pattern.test(owner.binary || '') || pattern.test(owner.cmd || '');
}

/** First port at or above `from` that nothing is listening on. */
async function findFreePort(from = 5910, host = '127.0.0.1') {
  for (let port = from; port < from + 50; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, host);
    });
    if (free) return port;
  }
  return null;
}

function findXauth() {
  const candidates = [
    process.env.XAUTHORITY,
    path.join(os.homedir(), '.Xauthority'),
    `/run/user/${process.getuid()}/gdm/Xauthority`,
    `/run/user/${process.getuid()}/.mutter-Xwaylandauth`,
    '/var/run/lightdm/root/:0',
    '/run/lightdm/root/:0',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      if (!stat.isFile() || stat.size === 0) continue;
      fs.accessSync(c, fs.constants.R_OK); // root-only files are useless to us
      return c;
    } catch { /* keep looking */ }
  }
  return null;
}

function detectSession() {
  const cfg = config.load();
  const sockets = xSockets();
  let display = cfg.vnc.display || process.env.DISPLAY || null;
  if (!display) display = sockets[0] || ':0';
  if (display.startsWith('localhost')) display = display.replace('localhost', '');
  return {
    display,
    xauth: findXauth(),
    sessionType: readSessionType(),
    wayland: readSessionType() === 'wayland',
    xSockets: sockets,
  };
}

function isWayland() {
  return detectSession().wayland;
}

async function unitExists(unit = VNC_UNIT) {
  const res = await run('systemctl', ['cat', unit], { timeout: 5000 });
  return res.ok;
}

async function unitActive(unit = VNC_UNIT) {
  const res = await run('systemctl', ['is-active', unit], { timeout: 5000 });
  return res.stdout === 'active' || res.stdout === 'activating';
}

async function toolsStatus() {
  const [x11vnc, xdotool, arecord, gnomeScreenshot, scrot, spectacle, xfceShot, importTool, systemctl] = await Promise.all([
    which('x11vnc'),
    which('xdotool'),
    which('arecord'),
    which('gnome-screenshot'),
    which('scrot'),
    which('spectacle'),
    which('xfce4-screenshooter'),
    which('import'),
    which('systemctl'),
  ]);
  const cfg = config.load();
  return {
    x11vnc,
    xdotool,
    arecord,
    screenshot: gnomeScreenshot || scrot || spectacle || xfceShot || importTool,
    systemctl,
    vncPasswordFile: fs.existsSync(cfg.vnc.passwordFile) ? cfg.vnc.passwordFile : null,
  };
}

async function status() {
  const cfg = config.load();
  const session = detectSession();
  const [running, tools, asUnit, active] = await Promise.all([
    netProbe(cfg.vnc.host, cfg.vnc.port),
    toolsStatus(),
    unitExists(),
    unitActive(),
  ]);
  const childRunning = Boolean(spawnedChild && !spawnedChild.killed);
  return {
    running,
    host: cfg.vnc.host,
    port: cfg.vnc.port,
    display: session.display,
    xSockets: session.xSockets,
    xauth: session.xauth,
    sessionType: session.sessionType,
    wayland: session.wayland,
    autostart: cfg.vnc.autostart,
    managedBy: active ? 'systemd' : childRunning ? 'app' : null,
    systemdUnit: asUnit ? VNC_UNIT : null,
    hasVncPassword: Boolean(cfg.vnc.password || tools.vncPasswordFile),
    tools,
    error: lastStartError,
  };
}

function x11vncArgs(session, { passwordFile }, authArgs) {
  const cfg = config.load();
  const args = ['-display', session.display];
  args.push(...authArgs);
  args.push('-rfbport', String(cfg.vnc.port));
  args.push('-localhost', '-forever', '-shared', '-noxdamage', '-repeat', '-nowf', '-ncache', '0', '-quiet');
  // Always -nopw.
  //
  // The screen server only ever listens on 127.0.0.1 and is reachable through
  // this app's PIN-gated WebSocket, so a VNC password adds no security. It can
  // only hurt: if the stored password and the on-disk file ever disagree — or
  // the phone has not fetched it yet — the server greets the phone and then
  // rejects it, which looks like a broken app while every check reads "ok".
  args.push('-nopw');
  return args;
}

/**
 * Ways to reach the X server, most specific first:
 *  1. the Xauthority file we found for this session
 *  2. x11vnc's own guessing logic (needs `xauth`, and `netstat` for best results)
 *  3. no -auth at all (works for displays without access control)
 */
function authCandidates(session) {
  const candidates = [];
  if (session.xauth) {
    try {
      fs.accessSync(session.xauth, fs.constants.R_OK);
      candidates.push(['-auth', session.xauth]);
    } catch { /* unreadable — skip it */ }
  }
  candidates.push(['-auth', 'guess']);
  candidates.push([]);
  return candidates;
}

/** Wait until the port opens, or the child dies — whichever comes first. */
function waitForPortOrExit(child, host, port, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timed out waiting for the VNC port' }), timeout);
    const poll = setInterval(async () => {
      if (exited) return;
      if (await netProbe(host, port, 400)) finish({ ok: true });
    }, 300);
    child.once('exit', (code) => {
      exited = true;
      finish({ ok: false, error: `x11vnc exited (code ${code})` });
    });
  });
}

/** Start x11vnc (systemd unit first, otherwise as a child process). */
async function start() {
  lastStartError = null;
  const cfg = config.load();
  if (await netProbe(cfg.vnc.host, cfg.vnc.port)) return { ok: true, via: 'already-running' };

  const session = detectSession();
  if (session.wayland) {
    const msg = 'This looks like a Wayland session — x11vnc can only capture an X11 session. Log out and pick "Ubuntu on Xorg" at the login screen.';
    lastStartError = msg;
    return { ok: false, via: null, error: msg, wayland: true };
  }

  const x11vnc = await which('x11vnc');
  if (!x11vnc) {
    const msg = 'x11vnc is not installed. Run: sudo apt install x11vnc';
    lastStartError = msg;
    return { ok: false, via: null, error: msg };
  }

  // A leftover x11vnc from a previous session (dead display, changed
  // Xauthority) can linger without serving anything — clear it out first.
  const leftovers = await run('pgrep', ['-f', 'x11vnc -display'], { timeout: 4000 });
  if (leftovers.ok && leftovers.stdout) {
    await run('pkill', ['-f', 'x11vnc -display'], { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 300));
  }

  if (await unitExists()) {
    await run('systemctl', ['--user', 'start', VNC_UNIT], { timeout: 8000 }).catch(() => null);
    const sys = await run('systemctl', ['start', VNC_UNIT], { timeout: 8000 });
    if (!sys.ok) {
      // fall back to spawning ourselves
      const viaSudo = await run('sudo', ['-n', 'systemctl', 'start', VNC_UNIT], { timeout: 8000 });
      if (!viaSudo.ok && !(await netProbe(cfg.vnc.host, cfg.vnc.port))) {
        lastStartError = sys.stderr || sys.error;
      }
    }
    if (await waitForPort(cfg.vnc.host, cfg.vnc.port, 6000)) return { ok: true, via: 'systemd' };
  }

  // Spawn our own, trying each way of talking to the X server in turn.
  const attempts = authCandidates(session);
  let lastStderr = '';
  for (const authArgs of attempts) {
    let stderr = '';
    const child = spawn(x11vnc, x11vncArgs(session, cfg.vnc, authArgs), {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      lastStartError = err.message;
    });
    child.unref();

    const result = await waitForPortOrExit(child, cfg.vnc.host, cfg.vnc.port, 5000);
    if (result.ok) {
      spawnedChild = child;
      return { ok: true, via: 'spawned', auth: authArgs.join(' ') || 'none' };
    }
    lastStderr = stderr || result.error;
    if (child.exitCode === null && !child.killed) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    }
  }

  const raw = lastStderr.trim().split('\n').filter(Boolean).slice(-4).join(' · ');
  if (/read permission|must be run as root/i.test(lastStderr)) {
    lastStartError = 'x11vnc cannot read the X authentication file for this session. '
      + 'Fix it from a terminal in your desktop session with:  xhost +SI:localuser:$USER  '
      + 'then press Start VNC again.';
  } else if (/failed for display/i.test(lastStderr)) {
    lastStartError = `x11vnc could not attach to display ${session.display}. Is your desktop session logged in?`;
  } else {
    lastStartError = raw || `x11vnc did not open port ${cfg.vnc.port}. Is an X session running on ${session.display}?`;
  }
  return { ok: false, via: 'spawned', error: lastStartError, stderr: lastStderr };
}

async function stop() {
  const cfg = config.load();
  if (await unitExists()) {
    await run('systemctl', ['stop', VNC_UNIT], { timeout: 8000 });
    await run('sudo', ['-n', 'systemctl', 'stop', VNC_UNIT], { timeout: 8000 });
  }
  if (spawnedChild) {
    try {
      process.kill(-spawnedChild.pid, 'SIGTERM');
    } catch {
      try {
        spawnedChild.kill('SIGTERM');
      } catch { /* ignore */ }
    }
    spawnedChild = null;
  }
  await run('pkill', ['-f', 'x11vnc -display'], { timeout: 4000 });

  // Something else may be holding the port (another remote-desktop tool, or an
  // x11vnc from an earlier session). Take the port back, or the restart is a
  // no-op and the user is stuck with whatever is broken.
  const owner = portOwner(cfg.vnc.port);
  if (owner && !owner.ours && looksLikeVncServer(owner)) {
    await run('kill', [String(owner.pid)], { timeout: 4000 });
    for (let i = 0; i < 20; i += 1) {
      if (!(await netProbe(cfg.vnc.host, cfg.vnc.port))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (await netProbe(cfg.vnc.host, cfg.vnc.port)) {
      await run('kill', ['-9', String(owner.pid)], { timeout: 4000 });
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { ok: !(await netProbe(cfg.vnc.host, cfg.vnc.port)), displaced: owner && !owner.ours ? owner.binary : null };
}

async function waitForPort(host, port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await netProbe(host, port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Create a VNC password file with `x11vnc -storepasswd`. */
async function setPassword(password) {
  const cfg = config.load();
  const file = cfg.vnc.passwordFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const x11vnc = (await which('x11vnc')) || 'x11vnc';
  const res = await run(x11vnc, ['-storepasswd', String(password), file], { timeout: 10000 });
  if (!res.ok && !fs.existsSync(file)) {
    return { ok: false, error: res.stderr || res.error || 'x11vnc -storepasswd failed' };
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch { /* ignore */ }
  config.save({ vnc: { password: String(password) } });
  return { ok: true, file };
}

/** Full command line of whatever holds the screen port, if we can read it. */
function serverCommandLine(port) {
  const owner = portOwner(port);
  return owner ? { pid: owner.pid, binary: owner.binary, cmd: owner.cmd, ours: owner.ours } : null;
}

/** Is anything listening? */
function isPortOpen(host, port, timeout = 1200) {
  return netProbe(host, port, timeout);
}

module.exports = { portOwner, looksLikeVncServer, findFreePort, serverCommandLine, isPortOpen,
  VNC_UNIT,
  authCandidates,
  waitForPortOrExit,
  run,
  which,
  netProbe,
  detectSession,
  isWayland,
  toolsStatus,
  status,
  start,
  stop,
  setPassword,
  unitExists,
  waitForPort,
};
