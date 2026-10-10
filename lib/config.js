'use strict';
/** Config + tiny helpers shared by the rest of the server. */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Pocket Desktop';
const VERSION = "1.3.3";

const CONFIG_DIR = process.env.POCKET_DESKTOP_CONFIG_DIR
  ? path.resolve(process.env.POCKET_DESKTOP_CONFIG_DIR)
  : path.join(os.homedir(), '.config', 'pocket-desktop');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'pocket-desktop');

const DEFAULTS = {
  name: os.hostname(),
  port: 8765,
  bind: '0.0.0.0',
  pinHash: null,
  pinSalt: null,
  tokenSecret: null,
  vnc: {
    host: '127.0.0.1',
    port: 5900,
    display: null, // detected at runtime when null
    password: null, // VNC password handed to the browser after login
    autostart: true, // try to launch x11vnc when it is not running
    passwordFile: path.join(os.homedir(), '.vnc', 'passwd'),
  },
  quality: 'balanced',
  ptt: { key: 'space', device: 'default' },
  createdAt: null,
};

let cache = null;

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    fileCfg = {};
  }
  cache = deepMerge(DEFAULTS, fileCfg);
  cache.tokenSecret = cache.tokenSecret || crypto.randomBytes(32).toString('hex');
  return cache;
}

function save(patch) {
  const cfg = load();
  cache = deepMerge(cfg, patch || {});
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch { /* ignore */ }
  return cache;
}

async function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

module.exports = { APP_NAME, VERSION, CONFIG_DIR, CONFIG_PATH, DATA_DIR, DEFAULTS, load, save, expandHome };
