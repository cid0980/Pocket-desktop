'use strict';
/**
 * Tiny Chrome DevTools Protocol client — enough to drive the UI in a test.
 * No npm dependencies: Node's built-in WebSocket (node --experimental-websocket
 * on Node 20, built in from Node 22) plus http.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser({
  binary = process.env.CHROME || 'chromium',
  port = 0, // 0 = let chromium pick, discovered via DevToolsActivePort
  width = 390,
  height = 844,
  userDataDir = `/tmp/pocket-desktop-chrome-${process.pid}-${Date.now()}`,
  extraArgs = [],
} = {}) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d.toString(); });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 25000;
  let realPort = port;
  let version = null;
  while (Date.now() < deadline) {
    try {
      if (!realPort) {
        const txt = fs.readFileSync(portFile, 'utf8').split('\n');
        realPort = Number(txt[0]);
      }
      if (realPort) {
        version = await httpJson(`http://127.0.0.1:${realPort}/json/version`);
        if (version) break;
      }
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  if (!version) throw new Error(`chromium did not start:\n${log.slice(-2000)}`);

  const close = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  };
  process.on('exit', close);
  return { child, version, port: realPort, userDataDir, close, log: () => log };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`));
        else resolve(msg.result);
        return;
      }
      const key = `${msg.sessionId || ''}:${msg.method}`;
      const handlers = this.listeners.get(key) || [];
      for (const h of handlers) h(msg.params);
      for (const h of this.listeners.get(`*:${msg.method}`) || []) h(msg.params, msg.sessionId);
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, handler, sessionId = '') {
    const key = `${sessionId}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  waitForEvent(method, sessionId = '', timeout = 15000) {
    return new Promise((resolve, reject) => {
      const key = `${sessionId}:${method}`;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
      const handler = (params) => {
        clearTimeout(timer);
        const list = this.listeners.get(key) || [];
        this.listeners.set(key, list.filter((h) => h !== handler));
        resolve(params);
      };
      this.on(method, handler, sessionId);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

/** Open a tab and attach to it. Returns { sessionId, targetId }. */
async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { sessionId, targetId };
}

async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(`page error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

async function waitFor(cdp, sessionId, expression, { timeout = 15000, interval = 200, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let error;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, sessionId, expression);
      if (last) return last;
      error = null;
    } catch (err) {
      error = err; // page may still be loading — keep trying
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${error ? ' — ' + error.message : ''}`);
}

async function screenshot(cdp, sessionId, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  require('fs').writeFileSync(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

/** Simulate a real finger: touchStart/touchMove/touchEnd at viewport coords. */
async function touch(cdp, sessionId, points, { duration = 60, steps = 1 } = {}) {
  const list = Array.isArray(points[0]) ? points : [points];
  const toTouchPoints = (p) => p.map((pt) => ({ x: pt.x, y: pt.y, radiusX: 12, radiusY: 12, force: 1, id: pt.id ?? 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: toTouchPoints(list[0]) }, sessionId);
  for (let s = 1; s < list.length; s += 1) {
    await sleep(duration / Math.max(1, list.length - 1));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: toTouchPoints(list[s]) }, sessionId);
  }
  await sleep(duration);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
}

async function tap(cdp, sessionId, x, y) {
  await touch(cdp, sessionId, [{ x, y }], { duration: 40 });
}

async function typeText(cdp, sessionId, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
  }
}

module.exports = {
  launchBrowser, CDP, newPage, evaluate, waitFor, screenshot, touch, tap, typeText, sleep, httpJson,
  sendTouch,
};

/** Raw touch events, so a test can hold a button down and then let go. */
async function sendTouch(cdp, sessionId, type, points = []) {
  const toTouchPoints = (p) => p.map((pt) => ({ x: pt.x, y: pt.y, radiusX: 12, radiusY: 12, force: 1, id: pt.id ?? 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: toTouchPoints(points) }, sessionId);
}
