/** Pocket Desktop — app shell: screens, sheets, settings, session wiring. */

import { RemoteSession } from './remote.js';
import './pad.js';
import {screenshotViewer} from './screenshot-viewer.js';
import {settingsNavigation, keyboardWorkspace} from './workspaces.js';
import { LayoutEditor, fullscreen, toggleImmersive, MotionPointer, bindMouseButton, bindTouchpad, bindScrollStrip } from './controls.js';

/* ── tiny helpers ──────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** Keep in sync with VERSION in lib/config.js — a test asserts they match. */
const CLIENT_VERSION = '1.4.1';

/**
 * Session token store. Normally the session lives in an HttpOnly cookie, but
 * embedded/sandboxed views (and browsers with cookies disabled) cannot use one,
 * so we also keep the signed token and send it as a bearer header.
 * localStorage may throw in an opaque origin — then we fall back to memory.
 */
const sessionToken = (() => {
  let memory = null;
  let storage = null;
  try {
    storage = window.localStorage;
    storage.setItem('pd_probe', '1');
    storage.removeItem('pd_probe');
  } catch {
    storage = null;
  }
  return {
    get: () => (storage ? storage.getItem('pd_token') : memory),
    set: (token) => {
      memory = token;
      try { storage?.setItem('pd_token', token); } catch { /* memory only */ }
    },
    clear: () => {
      memory = null;
      try { storage?.removeItem('pd_token'); } catch { /* ignore */ }
    },
  };
})();

function toast(message, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path, { method = 'GET', body } = {}) {
  const token = sessionToken.get();
  const headers = { 'X-Pocket-Client': CLIENT_VERSION };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let data = {};
  try {
    data = await res.json();
  } catch { /* non-json (e.g. screenshot) */ }
  if (res.status === 401 && data.login) {
    sessionToken.clear();
    show('login');
    throw Object.assign(new Error(data.error || 'Not signed in'), { handled: true });
  }
  if (!res.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  }
  return data;
}

const fmtBytes = (n) => {
  if (!n && n !== 0) return '—';
  const units = ['B', 'MB', 'GB', 'TB'];
  let v = n / (1024 * 1024);
  let i = 1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

const fmtUptime = (s) => {
  if (!s && s !== 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

/** Gamepad stick sensitivity (0.3–2.5), saved per browser. Defaults to 1. */
function readStickSens(key) {
  try { const v = Number(localStorage.getItem(key)); return v >= 0.3 && v <= 2.5 ? v : 1; } catch { return 1; }
}

/* ── state ─────────────────────────────────────────────────────── */

const state = {
  auth: null,
  cfg: null,
  info: null,
  session: null,
  vncReady: false,
  pollTimer: null,
};

/* ── screens ───────────────────────────────────────────────────── */

const SCREENS = ['setup', 'login', 'home', 'remote', 'pad', 'mouse', 'keyboard'];

function show(name) {
  for (const s of SCREENS) {
    const el = $(`#screen-${s}`);
    if (el) el.hidden = s !== name;
  }
  requestAnimationFrame(() => window.pocketLayouts?.apply());
  document.body.classList.toggle('remote-active', name === 'remote');
  if (name === 'home') startPolling();
  else stopPolling();
  // Do not summon the phone keyboard until the user explicitly requests it.
}

/**
 * The files on disk can be newer than the running process (the process keeps
 * serving whatever is on disk). Detect it and offer to restart the server.
 */
function checkVersion(serverVersion) {
  const banner = $('#version-banner');
  if (!banner) return;
  if (!serverVersion || serverVersion === CLIENT_VERSION) {
    banner.hidden = true;
    return;
  }
  $('#version-text').textContent =
    `Your PC is running v${serverVersion}, these app files are v${CLIENT_VERSION}. Restart to finish the update.`;
  banner.hidden = false;
}

async function restartServer() {
  toast('Restarting the app on your PC…');
  let supervised = true;
  try {
    const res = await api('/api/restart', { method: 'POST' });
    supervised = res.supervised !== false;
  } catch (err) {
    // The server may drop the connection as it exits — that is expected.
    if (!/fetch|network|Failed/i.test(err.message)) toast(err.message, 'err');
  }
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch { /* still down */ }
  }
  toast(supervised
    ? 'The server did not come back — check: systemctl --user status pocket-desktop'
    : 'Start it again on your PC with ./run.sh --tls? no: ./run.sh', 'err', 9000);
}

$('#btn-version-restart').addEventListener('click', restartServer);

/** JSON control channel (/wsctl) for gamepad, motion mouse and clicks. */
class ControlSocket {
  constructor({ onClose } = {}) {
    this.ws = null;
    this.queue = [];
    this.onClose = onClose || (() => {});
    this.retries = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const token = sessionToken.get();
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(`${scheme}//${location.host}/wsctl${token ? `?t=${encodeURIComponent(token)}` : ''}`);
      } catch (err) {
        reject(err);
        return;
      }
      ws.onopen = () => {
        this.ws = ws;
        window.dispatchEvent(new Event('pd:control-ready'));
        this.retries = 0;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.raw({t:'ping'}), 750);
        for (const msg of this.queue.splice(0)) this.raw(msg);
        resolve(this);
      };
      ws.onmessage = e => { try { const message=JSON.parse(e.data); if(message.t==='ack')window.dispatchEvent(new CustomEvent('pd:control-ack',{detail:message})); } catch {} };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        clearInterval(this.heartbeat);
        window.dispatchEvent(new Event('pd:control-lost'));
        this.ws = null;
        if (this.retries < 3) {
          this.retries += 1;
          setTimeout(() => this.connect().catch(() => this.onClose()), 400 * this.retries);
        } else {
          this.onClose();
        }
      };
      // First failure rejects so the caller can tell the user.
      const timeout = setTimeout(() => reject(new Error('the control channel did not open')), 6000);
      ws.addEventListener('open', () => clearTimeout(timeout), { once: true });
    });
  }

  raw(obj) {
    if (this.ws && this.ws.readyState === 1) {try {this.ws.send(JSON.stringify(obj));return true;}catch{}}
    // Never replay stale input after reconnecting. Report a failed send.
    return false;
  }

  send(obj) { return this.raw(obj); }

  close() {
    clearInterval(this.heartbeat);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

let padScreen = null;
let controlSocket = null;

/** Open the full-screen gamepad. */
async function openPad() {
  const dot = $('#pad-dot');
  const title = $('#pad-title');
  if (dot) dot.className = 'dot';
  show('pad');

  // Make sure the PC has created the virtual controller.
  try {
    const { data } = await api('/api/pad/start', { method: 'POST' });
    if (!data?.available) {
      const why = data?.error || 'the virtual controller could not start';
      toast(`Gamepad unavailable — ${why}`, 'err', 7000);
      if (title) title.textContent = 'No gamepad';
      if (dot) dot.className = 'dot err';
      return;
    }
    if (title) title.textContent = data.mode === 'sudo' ? 'Gamepad (sudo)' : 'Gamepad';
  } catch (err) {
    toast(err.message, 'err');
  }

  if (!controlSocket || !controlSocket.ws) {
    controlSocket = new ControlSocket({
      onClose: () => {
        if (!$('#screen-pad')?.hidden) toast('Gamepad connection lost', 'err');
      },
    });
    try {
      await controlSocket.connect();
    } catch (err) {
      toast(`Gamepad: ${err.message}`, 'err', 6000);
      return;
    }
  }

  if (dot) dot.className = 'dot on';
  if (padScreen) { padScreen.onExit = () => {}; padScreen.exit(); }
  padScreen = new window.PocketPad.GamepadScreen({
    socket: controlSocket,
    settings: {motionSensitivity:Number($('#pad-sens').value)||1, moveSensitivity:readStickSens('pd-pad-move-sensitivity'), lookSensitivity:readStickSens('pd-pad-look-sensitivity')},
    onToast: toast,
    onExit: () => {
      padScreen = null;
      show('home');
      if (dot) dot.className = 'dot';
    },
  });
}

$('#tile-pad').addEventListener('click', openPad);

let mouseAbort = null, mouseMotion = null, mouseInput = null, mouseScroll = null, mouseReturn = 'home';
const mousePrefKey='pd-mouse-preferences-v1';
let mousePrefs={version:1,speed:.6,tapMs:300};
try {const saved=JSON.parse(localStorage.getItem(mousePrefKey));if(saved?.version===1) {
  if(Number.isFinite(saved.speed)&&saved.speed>=.2&&saved.speed<=2)mousePrefs.speed=saved.speed;
  if(Number.isFinite(saved.tapMs)&&saved.tapMs>=250&&saved.tapMs<=350)mousePrefs.tapMs=saved.tapMs;
}}catch{}
function renderMousePrefs() {
  $('#mouse-speed').value=mousePrefs.speed;$('#mouse-speed-value').textContent=mousePrefs.speed.toFixed(2)+'×';
  $('#mouse-tap-interval').value=mousePrefs.tapMs;$('#mouse-tap-value').textContent=mousePrefs.tapMs+' ms';
}
renderMousePrefs();
for(const [selector,key]of [['#mouse-speed','speed'],['#mouse-tap-interval','tapMs']])$(selector).addEventListener('input',e=>{
  mousePrefs[key]=Number(e.target.value);renderMousePrefs();
  try {localStorage.setItem(mousePrefKey,JSON.stringify(mousePrefs));$('#mouse-preference-status').textContent='Applied now · saved on this browser';}
  catch {$('#mouse-preference-status').textContent='Applied now · browser storage unavailable';}
  $('#mouse-input-status').textContent=(key==='speed'?'Speed '+mousePrefs.speed.toFixed(2)+'×':'Tap window '+mousePrefs.tapMs+' ms')+' · '+$('#mouse-preference-status').textContent;
});
function mouseReady(ready) {$('#screen-mouse').dataset.ready=String(ready);$('#mouse-surface').setAttribute('aria-disabled',String(!ready));}
let inputSequence=0;const awaitingInput=new Set();
function sendMouseInput(message) {
  message={...message,id:++inputSequence};
  if(!controlSocket?.send(message)){mouseReady(false);$('#mouse-input-status').textContent='Not connected — input was not sent';return false;}
  awaitingInput.add(message.id);if(awaitingInput.size>128)awaitingInput.delete(awaitingInput.values().next().value);
  if(message.t==='click')$('#mouse-input-status').textContent='Sending '+message.b+' tap…';
  if(message.t==='click'||message.t==='btn')setTimeout(()=>{
    if(!awaitingInput.has(message.id))return;
    awaitingInput.clear();mouseInput?.reset();mouseReady(false);
    $('#mouse-input-status').textContent='PC did not confirm input. Reopen Mouse pad; check the PC server version and connection.';
  },3000);
  return true;
}
window.addEventListener('pd:control-ack',e=>{
  const m=e.detail;if(!awaitingInput.delete(m.id))return;
  if(!m.ok){$('#mouse-input-status').textContent='PC could not accept input — reopen Mouse pad';mouseReady(false);return;}
  if(m.event==='click'||m.event==='btn')$('#mouse-input-status').textContent='PC accepted '+m.button+(m.event==='click'?' click':' button event');
  if(m.event==='wheel')$('#mouse-input-status').textContent='PC accepted scroll';
});
window.addEventListener('pd:control-ready',()=>{if(mouseInput&&!$('#screen-mouse').hidden){mouseReady(true);$('#mouse-input-status').textContent='Connected — input ready';}});

async function openMouse(from = 'home') {
  mouseReturn = from;
  if (padScreen) { padScreen.onExit = () => {}; padScreen.exit(); padScreen = null; }
  mouseAbort?.abort(); mouseMotion?.stop();mouseInput=null;awaitingInput.clear();
  mouseReady(false);$('#mouse-input-status').textContent='Connecting to PC…';
  show('mouse');
  try {
    if(state.auth?.version && state.auth.version!==CLIENT_VERSION)throw Error('PC server and phone files have different versions. Restart the PC app, then reload this page before using Mouse pad.');
    const {data} = await api('/api/pad/start', {method:'POST'});
    if(!data?.available) throw Error(data?.error || 'Virtual mouse is unavailable; run install.sh on the PC.');
    if(!controlSocket?.ws) { controlSocket = new ControlSocket({onClose:()=>toast('Pointer disconnected. Reopen Mouse pad to reconnect.','err')}); await controlSocket.connect(); }
    mouseAbort = new AbortController(); const signal = mouseAbort.signal;
    const send = sendMouseInput;
    mouseInput = bindTouchpad($('#mouse-surface'),send,signal,{speed:()=>mousePrefs.speed,tapMs:()=>mousePrefs.tapMs});
    mouseScroll=bindScrollStrip($('#mouse-scroll'),send,signal,()=>mouseInput.cancelPending());
    mouseInput.bindButton($('#mouse-left'),'left'); mouseInput.bindButton($('#mouse-right'),'right');
    mouseReady(true);$('#mouse-input-status').textContent='Connected — input ready';
    mouseMotion = new MotionPointer(msg=>controlSocket.send(msg),(text,on)=> { $('#mouse-status').textContent=text; $('#mouse-motion').textContent=on?'Disable motion':'Enable motion'; },()=>Number($('#mouse-sens').value));
  } catch(e) { $('#mouse-input-status').textContent=e.message; $('#mouse-status').textContent=e.message; toast(e.message,'err'); }
}
$('#tile-mouse').addEventListener('click',()=>openMouse());
$('#pad-exit').addEventListener('click',()=>{ if(!padScreen)show('home'); });
$('#pad-to-mouse').addEventListener('click',()=>openMouse('pad'));
$('#mouse-back').addEventListener('click',()=> {mouseAbort?.abort();mouseMotion?.stop();mouseMotion=null;if(mouseReturn==='pad')openPad();else show('home');});
$('#mouse-motion').addEventListener('click',()=>mouseMotion?.toggle());
window.addEventListener('pd:control-lost',()=>{mouseReady(false);awaitingInput.clear();$('#mouse-input-status').textContent='Connection lost — reconnecting';mouseInput?.reset();mouseMotion?.stop();padScreen?.releaseAll();});
$('#mouse-center').addEventListener('click',()=>mouseMotion?.recenter());
$$('[data-fullscreen]').forEach(el=>el.addEventListener('click',()=>fullscreen(toast)));

// Click through the existing RFB session, at its last pointer position.
for (const side of ['left','right']) $('#remote-'+side).addEventListener('click',()=> {
  const session=state.session;
  if(!session?.connected) return toast('Remote screen is not connected','err');
  if(session.viewOnly) return toast('Turn off View only to send clicks');
  const rect=session.canvas?.getBoundingClientRect();
  const point=session.lastPointer || {x:rect?.left+(rect?.width||0)/2,y:rect?.top+(rect?.height||0)/2};
  session.click(side,point.x,point.y);
});
// Stable per-page IDs, independent of order or translated labels.
const pageRoots={remote:$('#screen-remote'),pad:$('#screen-pad'),mouse:$('#screen-mouse')};
const layoutSelectors={remote:['#remote-left','#remote-right','#remote-bar button','#remote-dock .pill-btn'],pad:['#pad-move','#pad-look','#pad-dpad','.pad-face [data-pad-btn]','.pad-system [data-pad-btn]','#pad-click-left','#pad-click-right','#pad-motion-toggle','#pad-center','.pad-top button','#pad-lt','#pad-rt','[data-pad-btn="lb"]','[data-pad-btn="rb"]'],mouse:['.control-top button']};
const layoutClaimed=new Set();
for(const [page,selectors] of Object.entries(layoutSelectors)) for(const selector of selectors) {
  // Each button is its own layout item. Keys are stable: element id, data-pad-btn, or selector + index.
  pageRoots[page].querySelectorAll(selector).forEach((el,i)=>{
    if(layoutClaimed.has(el)) return; layoutClaimed.add(el);
    el.dataset.layout=el.id || el.dataset.padBtn || `${selector.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')}-${i}`;
  });
}
const layouts = new LayoutEditor(pageRoots,toast); window.pocketLayouts=layouts;
// After Save or Cancel, return to fullscreen if the editor was opened from it.
const finishLayouts=layouts.finish.bind(layouts);
layouts.finish=()=>{ finishLayouts(); if(resumeImmersive){ resumeImmersive=false; toggleImmersive(); } };
/** Start layout editing for a page. Leaves fullscreen so the top bar and every control are visible. */
let resumeImmersive=false;
function beginLayout(page){
  padScreen?.releaseAll(); padScreen?.motionController.stop(); mouseMotion?.stop();
  state.session?.input?.reset();
  for(const b of ['left','right']) controlSocket?.send({t:'btn',b,d:0});
  mouseInput?.reset();mouseScroll?.reset();
  $('#pad-panel')?.classList.remove('open');
  layouts.begin(page);
}
$$('[data-edit]').forEach(el=>el.addEventListener('click',()=> beginLayout(el.dataset.edit)));
/** Fullscreen menu: switch between Gamepad, Mouse pad and Keyboard without leaving fullscreen. */
document.addEventListener('pd:open',e=>{
  const target=e.detail;
  if(currentWorkspace()===target) return;
  releaseWorkspaceInputs();
  mouseAbort?.abort();mouseMotion?.stop();mouseMotion=null;
  if(target==='pad') openPad();
  else if(target==='mouse') openMouse('home');
  else if(target==='keyboard') openKeyboard('home');
});
document.addEventListener('pd:customize',()=>{
  const screen=SCREENS.find(s=>!$('#screen-'+s)?.hidden);
  const page={remote:'remote',pad:'pad',mouse:'mouse'}[screen];
  if(!page) return toast('Layout editing is not available on this screen','err');
  if(document.body.classList.contains('pd-immersive')){ resumeImmersive=true; toggleImmersive(); }
  beginLayout(page);
});



let keyboardReturn='home', keyboardMouseReturn='home';
function currentWorkspace(){return SCREENS.find(s=>!$('#screen-'+s)?.hidden)||'home';}
function releaseWorkspaceInputs(){padScreen?.releaseAll();padScreen?.stopMotion();mouseInput?.reset();mouseScroll?.reset();mouseMotion?.stop();state.session?.input?.reset();state.session?._releaseEverything();$$('[data-mod].active').forEach(el=>el.classList.remove('active'));}
async function sendKeyboard(body){
  if((currentWorkspace()==='remote'||(currentWorkspace()==='keyboard'&&keyboardReturn==='remote'))&&state.session?.viewOnly)throw Error('Remote screen is in View only mode. Turn it off before sending keys.');
  return api('/api/keyboard',{method:'POST',body});
}
function openKeyboard(from=currentWorkspace()){
  keyboardReturn=from;keyboardMouseReturn=mouseReturn;releaseWorkspaceInputs();
  if(padScreen){padScreen.onExit=()=>{};padScreen.exit();padScreen=null;}
  if(from==='mouse'){mouseAbort?.abort();mouseMotion?.stop();}
  closeSheets();show('keyboard');
}
function closeKeyboard(){
  $('#keyboard-draft').blur();
  if(keyboardReturn==='mouse')openMouse(keyboardMouseReturn);
  else if(keyboardReturn==='pad')openPad();
  else if(keyboardReturn==='remote'&&state.session)show('remote');
  else show('home');
}
keyboardWorkspace({send:sendKeyboard,onBack:closeKeyboard,onSettings:()=>openSettings('keyboard')});
$('#tile-keyboard').addEventListener('click',()=>openKeyboard('home'));
$('#mouse-keyboard').addEventListener('click',()=>openKeyboard('mouse'));
$('#mouse-enter').addEventListener('click',async()=>{
  const button=$('#mouse-enter');button.disabled=true;mouseInput?.reset();
  try{await sendKeyboard({key:'Enter'});$('#mouse-input-status').textContent='Enter sent to PC';}
  catch(e){$('#mouse-input-status').textContent=e.message;}
  finally{button.disabled=false;}
});
const settingsNav=settingsNavigation({onClose:closeSheets,onAction:async action=>{
  const from=currentWorkspace();closeSheets();
  if(action==='keyboard'){openKeyboard(from);return;}
  if(action==='layout-pad'){if(from!=='pad'||!padScreen)await openPad();$('#screen-pad [data-edit="pad"]').click();}
  if(action==='layout-mouse'){if(from!=='mouse')await openMouse();mouseInput?.reset();layouts.begin('mouse');}
}});
let settingsFocus=null;
async function openSettings(category=null){
  settingsFocus=document.activeElement;releaseWorkspaceInputs();
  openSheet('sheet-settings');settingsNav.select(category);$('#btn-save-settings').disabled=true;
  $('#mouse-motion').disabled=!mouseMotion||!mouseInput||$('#screen-mouse').dataset.ready!=='true'||$('#screen-mouse').hidden;$('#mouse-center').disabled=$('#mouse-motion').disabled;
  try{await loadSettings();$('#btn-save-settings').disabled=false;}catch(e){toast('Could not load PC settings: '+e.message,'err');}
}
$('#mouse-settings').addEventListener('click',()=>openSettings('mouse'));
$('#pad-settings').addEventListener('click',()=>openSettings('gamepad'));
$('#settings-gestures').addEventListener('click',()=>openSheet('sheet-gestures'));
$('#settings-connect-motion').addEventListener('click',async()=>{closeSheets();await openMouse();await openSettings('motion');});
try{const saved=Number(localStorage.getItem('pd-pad-motion-sensitivity'));if(saved>=.3&&saved<=2.5)$('#pad-sens').value=saved;}catch{}
for (const [id, key, prop] of [['#pad-move-sens','pd-pad-move-sensitivity','moveSensitivity'],['#pad-look-sens','pd-pad-look-sensitivity','lookSensitivity']]) {
  const input = $(id); input.value = readStickSens(key);
  input.addEventListener('input', e => {
    const value = Number(e.target.value);
    if (padScreen) padScreen.settings[prop] = value;
    try { localStorage.setItem(key, String(value)); } catch { /* storage may be blocked */ }
  });
}
$('#pad-sens').addEventListener('input',e=>{const value=Number(e.target.value);if(padScreen)padScreen.settings.motionSensitivity=value;try{localStorage.setItem('pd-pad-motion-sensitivity',String(value));}catch{}});
// Reserve actual dock height so controls never cover the remote picture by default.
new ResizeObserver(()=>{
  if($('#screen-remote').hidden)return;
  const dock=$('#remote-dock').getBoundingClientRect();
  $('#screen-remote').style.setProperty('--remote-dock-h',dock.height+'px');
  $('#remote-stage').style.bottom=(dock.height+Math.max(8,innerHeight-dock.bottom)+4)+'px';
}).observe($('#remote-dock'));

/** Offer a real install button when the browser supports it. */
(function installPrompt() {
  let deferred = null;
  const btn = document.querySelector('#btn-install');
  const hint = document.querySelector('#install-hint');
  if (!btn) return;

  const alreadyInstalled = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (alreadyInstalled) return;
  if (hint) { hint.hidden=false; hint.textContent=window.isSecureContext ? 'Use your browser Install app menu, or on iOS Share → Add to Home Screen.' : 'Full PWA installation and motion require trusted HTTPS. See README → Motion / HTTPS. A plain HTTP shortcut does not enable sensors.'; }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
    if (hint) hint.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    if (hint) hint.hidden = true;
    toast('Installed — open it from your home screen', 'ok');
  });

  btn.addEventListener('click', async () => {
    if (!deferred) {
      toast('Use your browser menu → “Install app” / “Add to Home screen”', '', 6000);
      return;
    }
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') toast('Installing…', 'ok');
    deferred = null;
    btn.hidden = true;
  });
})();

// PWA shortcuts: /?go=pad opens straight into the controller, etc.
(function handleShortcut() {
  const go = new URLSearchParams(location.search).get('go');
  if (!go) return;
  const run = async () => {
    if (go === 'pad') await openPad();
    else if (go === 'remote') await openRemote();
    else if (go === 'shot') {openSheet('sheet-shot');loadScreenshot();}
  };
  // wait until we are signed in and sitting on the home screen
  const deadline = Date.now() + 60000;
  const tick = async () => {
    const home = document.querySelector('#screen-home');
    if (home && !home.hidden) { await run(); return; }
    if (Date.now() > deadline) return;
    setTimeout(tick, 400);
  };
  tick();
})();

function startPolling() {
  stopPolling();
  refreshInfo();
  state.pollTimer = setInterval(refreshInfo, 5000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ── setup & login ─────────────────────────────────────────────── */

let pinBuffer = '';

function renderPinDots() {
  const dots = $('#pin-dots');
  dots.innerHTML = '';
  const count = Math.max(4, pinBuffer.length);
  for (let i = 0; i < count; i += 1) {
    const dot = document.createElement('i');
    if (i < pinBuffer.length) dot.className = 'on';
    dots.appendChild(dot);
  }
}

function shakePin() {
  const dots = $('#pin-dots');
  dots.classList.add('shake');
  setTimeout(() => dots.classList.remove('shake'), 380);
  pinBuffer = '';
  renderPinDots();
}

async function submitPin() {
  if (pinBuffer.length < 4) return;
  try {
    const res = await api('/api/login', { method: 'POST', body: { pin: pinBuffer } });
    if (res.token) sessionToken.set(res.token);
    pinBuffer = '';
    renderPinDots();
    toast('Welcome back', 'ok');
    boot();
  } catch (err) {
    if (err.handled) return;
    shakePin();
    toast(err.message || 'Wrong PIN', 'err');
  }
}

$('#pinpad').addEventListener('click', (ev) => {
  const key = ev.target.closest('.key')?.dataset.key;
  if (!key) return;
  if (key === 'clear') pinBuffer = '';
  else if (key === 'back') pinBuffer = pinBuffer.slice(0, -1);
  else if (pinBuffer.length < 10) pinBuffer += key;
  renderPinDots();
  if (key !== 'back' && key !== 'clear' && pinBuffer.length >= 4) {
    // auto-submit on 6+ digits, or when the user stops typing
    clearTimeout(submitPin._t);
    submitPin._t = setTimeout(submitPin, pinBuffer.length >= 6 ? 250 : 900);
  }
});

$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pin = $('#setup-pin').value.trim();
  const pin2 = $('#setup-pin2').value.trim();
  const name = $('#setup-name').value.trim();
  if (!/^[0-9]{4,10}$/.test(pin)) return toast('PIN must be 4–10 digits', 'err');
  if (pin !== pin2) return toast('PINs do not match', 'err');
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await api('/api/setup', { method: 'POST', body: { pin, name } });
    if (res.token) sessionToken.set(res.token);
    toast('PIN saved — starting VNC…', 'ok');
    await boot();
    await ensureVnc();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ── home screen ───────────────────────────────────────────────── */

async function refreshInfo() {
  try {
    const { data } = await api('/api/sysinfo');
    state.info = data;
    renderHome(data);
  } catch (err) {
    if (!err.handled) console.warn(err);
  }
}

function renderHome(info) {
  const vnc = info.vnc || {};
  $('#home-name').textContent = info.appName || info.hostname;
  $('#home-sub').textContent = `${info.hostname} · ${info.user} · ${info.platform.split(' ')[0]}`;
  $('#dot' in {} ? '' : '#home-dot').className = `dot ${vnc.running ? 'on' : vnc.error ? 'err' : 'warn'}`;

  const sessionLabel = `${info.sessionType === 'wayland' ? 'Wayland' : info.sessionType === 'x11' ? 'X11' : 'X'} · ${info.display}`;
  $('#hero-session').textContent = sessionLabel;
  const pill = $('#hero-vnc');
  pill.textContent = vnc.running ? (vnc.managedBy === 'systemd' ? 'VNC · service' : 'VNC · app') : 'VNC offline';
  pill.className = `pill ${vnc.running ? 'on' : vnc.error ? 'err' : ''}`;

  $('#stat-cpu').textContent = info.cpuPercent === null ? '—' : `${info.cpuPercent}%`;
  $('#stat-ram').textContent = info.memory?.percent === null ? fmtBytes(info.memory?.used) : `${info.memory.percent}%`;
  $('#stat-disk').textContent = info.disk?.percent === null || !info.disk ? '—' : `${info.disk.percent}%`;
  $('#stat-uptime').textContent = fmtUptime(info.uptime);

  const needsVnc = !vnc.running;
  $('#vnc-card').hidden = !needsVnc;
  $('#vnc-msg').textContent = vnc.error
    ? vnc.error
    : needsVnc
      ? 'The remote screen needs x11vnc running on this PC. Start it automatically, or set it up as a service for always-on access.'
      : '';
  $('#wayland-card').hidden = !vnc.wayland;
  $('#btn-connect').disabled = false;
}

async function ensureVnc({ silent = false } = {}) {
  const status = state.info?.vnc;
  if (status?.running) return true;
  if (!silent) toast('Starting the screen server…');
  try {
    const res = await api('/api/vnc/start', { method: 'POST' });
    state.vncReady = res.ok;
    if (res.ok) {
      toast('Screen server ready', 'ok');
      refreshInfo();
      return true;
    }
    toast(res.result?.result?.error || res.result?.error || 'Could not start x11vnc', 'err', 6000);
    refreshInfo();
    return false;
  } catch (err) {
    if (!err.handled) toast(err.message, 'err', 6000);
    return false;
  }
}

/* ── remote screen ─────────────────────────────────────────────── */

let rfbAttempt = 0;
const MAX_ATTEMPTS = 3;

/** Turn a disconnect into something the user can act on. */
function explainFailure(detail = {}) {
  const { code, reason, httpStatus, clean, livedMs } = detail;
  if (httpStatus === 401 || httpStatus === 403) {
    return { text: 'Your session expired. Sign in again.', hint: 'login' };
  }
  if (code === 1011) {
    return { text: 'The screen server on your PC is not answering.', hint: 'vnc' };
  }
  if (code === 1006 || code === 1005) {
    if (livedMs !== null && livedMs < 4000) {
      return { text: 'The connection was cut right away — typically the screen server stopped, or Wi-Fi dropped.', hint: 'retry' };
    }
    return { text: 'The connection dropped — the PC may have gone to sleep, or Wi-Fi dropped.', hint: 'retry' };
  }
  if (code === 1000) {
    if (reason && /hung up|handshake|fixing it/i.test(reason)) {
      return {
        text: 'The screen server on your PC rejected the connection (usually it asks for a password). '
          + 'The app replaces it automatically — if this repeats, use Restart screen server.',
        hint: 'restart-vnc',
      };
    }
    return { text: reason || 'The screen server closed the connection.', hint: 'retry' };
  }
  if (!clean) return { text: 'Connection lost — is the PC awake?', hint: 'retry' };
  return { text: reason || 'Disconnected', hint: 'retry' };
}

async function openRemote({ attempt = 1 } = {}) {
  show('remote');
  rfbAttempt = attempt;
  setRemoteStatus('connecting', attempt > 1 ? `Reconnecting… (attempt ${attempt} of ${MAX_ATTEMPTS})` : 'Connecting to your PC…');
  $('#remote-menu').hidden = true;

  let password = state.cfg?.vnc?.password ?? null;
  if (password === undefined) password = null;

  state.session = new RemoteSession({
    stage: $('#remote-stage'),
    wrap: $('#remote-wrap'),
    host: $('#remote-host'),
    token: sessionToken.get(),
    credentials: password ? { password } : {},
    onNeedPassword: async () => {
      try {
        const { data } = await api('/api/config');
        return data.vnc.password || null;
      } catch {
        return null;
      }
    },
    onState: async (status, detail) => {
      if (status === 'connected') {
        setRemoteStatus('hidden');
        const host = state.info?.hostname || 'PC';
        $('#remote-title').textContent = host;
        $('#remote-dot').className = 'dot on';
        applyMode(state.session?.input?.mode || 'touch');
        applyViewOnly();
        return;
      }
      if (status === 'connecting') {
        setRemoteStatus('connecting', 'Connecting…');
        return;
      }
      if (status !== 'disconnected') return;

      $('#remote-dot').className = 'dot err';
      const failure = explainFailure(detail || {});

      // A hang-up mid-handshake is fixable: the PC replaces the screen server
      // as soon as it sees this, so wait long enough for that to land.
      const fixable = !detail?.clean || /hung up|handshake|password/i.test(detail?.reason || '');
      if (fixable && rfbAttempt < MAX_ATTEMPTS) {
        setRemoteStatus('connecting', `Reconnecting… (${rfbAttempt + 1} of ${MAX_ATTEMPTS})`);
        if (!detail?.clean) await ensureVnc({ silent: true });
        await new Promise((r) => setTimeout(r, detail?.clean ? 4000 : 700 * rfbAttempt));
        if (state.session) {
          state.session.disconnect();
          state.session = null;
        }
        return openRemote({ attempt: rfbAttempt + 1 });
      }

      setRemoteStatus('error', failure.text, failure.hint);
    },
    onError: (kind, message) => {
      const text = kind === 'authentication'
        ? 'This PC requires a VNC password. Add it in Settings → VNC password.'
        : kind === 'security'
          ? `Authentication failed: ${message}`
          : String(message || kind);
      setRemoteStatus('error', text);
    },
    onDesktopName: (name) => {
      if (name) $('#remote-title').textContent = name;
    },
    onClipboard: (text) => {
      $('#clip-in').value = text;
      toast('Clipboard received from PC');
    },
    onBell: () => toast('🔔 PC bell'),
    onViewChange: ({ zoom }) => {
      $('#menu-zoom').textContent = zoom === 'fit' ? 'Fit' : zoom === '1' ? '1:1' : zoom === '2' ? '2×' : 'Custom';
    },
  });

  try {
    await state.session.connect();
  } catch (err) {
    setRemoteStatus('error', err.message || 'Could not connect');
  }
}

function setRemoteStatus(kind, text = '', hint = '') {
  const overlay = $('#remote-status');
  const retry = $('#btn-retry');
  const back = $('#btn-back-from-error');
  const diag = $('#btn-remote-diag');
  if (kind === 'hidden') {
    overlay.hidden = true;
    retry.hidden = true;
    back.hidden = true;
    diag.hidden = true;
    return;
  }
  overlay.hidden = false;
  overlay.querySelector('.spinner').hidden = kind !== 'connecting';
  $('#remote-status-text').textContent = text;
  retry.hidden = kind !== 'error';
  back.hidden = kind !== 'error';
  diag.hidden = kind !== 'error';
  if (kind === 'error') {
    if (hint === 'login') retry.textContent = 'Sign in again';
    else if (hint === 'restart-vnc') retry.textContent = 'Restart screen server';
    else retry.textContent = 'Try again';
    retry.dataset.action = hint || 'retry';
  }
}

/** The retry button doubles as the one-tap fix when we know what is wrong. */
$('#btn-retry').addEventListener('click', () => {
  const action = $('#btn-retry').dataset.action;
  if (action === 'login') {
    sessionToken.clear();
    location.reload();
    return;
  }
  if (action === 'restart-vnc') {
    restartScreenServer({ then: 'reconnect' });
    return;
  }
  openRemote();
});

/** Ask the PC to take back the screen port and start its own screen server. */
async function restartScreenServer({ then = null } = {}) {
  setRemoteStatus('connecting', 'Restarting the screen server on your PC…');
  try {
    const { data } = await api('/api/vnc/restart', { method: 'POST' });
    toast(data?.displaced ? `Replaced ${data.displaced} — using this app's screen server` : 'Screen server restarted', 'ok');
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
  if (then === 'reconnect') openRemote();
  else refreshStatus();
}

/** Show the self-test report so it can be copied or screenshotted. */
async function showDiagnostics() {
  closeSheets();
  openSheet('sheet-diag');
  const box = $('#diag-text');
  const started = Date.now();
  const ticker = setInterval(() => {
    if (box.value.startsWith('Running self-test')) {
      box.value = `Running self-test… ${Math.round((Date.now() - started) / 1000)}s`;
    }
  }, 500);
  box.value = 'Running self-test…';
  try {
    // If the running server is older than these files the endpoint never
    // answers, so never wait forever.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(
      'the self-test did not answer within 20 s. Most likely your PC is still running an older version of the app — press "Restart server" below, then run it again.'
    )), 20000));
    const { data } = await Promise.race([api('/api/diagnostics'), timeout]);
    const report = formatReport(data);
    box.value = report;
    if (data.timedOut) {
      toast('The self-test timed out on the PC — the report is partial', 'err', 5000);
      return;
    }
    try {
      await navigator.clipboard.writeText(report);
      toast('Report copied — paste it to your computer', 'ok', 3200);
    } catch {
      toast('Select the text below and copy it', '', 3200);
    }
  } catch (err) {
    box.value = `Could not run the self-test:\n\n${err.message}\n\n`
      + 'If this keeps happening, press "Restart server" below.';
  } finally {
    clearInterval(ticker);
  }
}

/** Compact, paste-friendly version of /api/diagnostics. */
/** Compact rendering of a log line's structured details — see lib/diagnostics.js. */
function describeLog(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const keys = ['peer', 'code', 'reason', 'toClient', 'toPc', 'ms', 'stalls', 'maxBufferedKB', 'origin', 'attempt', 'via', 'error'];
  const parts = [];
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null || v === '') continue;
    let text = String(v);
    if ((k === 'toClient' || k === 'toPc') && Number(v) > 4096) text = `${(Number(v) / 1048576).toFixed(2)} MB`;
    parts.push(`${k} ${text}`);
  }
  return parts.length ? `  {${parts.join(', ')}}` : '';
}

function formatReport(d) {
  const y = (ok) => (ok ? '[ ok ]' : '[FAIL]');
  const lines = [
    `${d.app.name} ${d.app.version} — diagnostics ${d.generatedAt}`,
    `app      node ${d.app.node} · ${d.app.platform} · ${d.app.manager} · pid ${d.app.pid}`,
    `machine  ${d.machine.hostname} · ${d.machine.user} · session ${d.machine.session} on ${d.machine.display}`,
    `server   port ${d.server.port} · ${d.server.tls ? 'https' : 'http'} · pin ${d.server.pinSet ? 'set' : 'MISSING'}`,
    `network  addresses ${d.server.addresses.join(', ') || 'none'}`,
    `client   ${d.server.clientAddress || 'n/a'} → host header "${d.server.hostHeader || 'n/a'}"`,
    '',
    `${y(d.checks.x11Session)} X11 session`,
    `${y(d.checks.x11vncInstalled)} x11vnc installed (${d.vnc.tools?.x11vnc || 'missing'})`,
    `${y(d.checks.vncListening)} VNC listening ${d.vnc.host}:${d.vnc.port}${d.vnc.managedBy ? ` (${d.vnc.managedBy})` : ''}`,
    `${y(Boolean(d.checks.vncGreeting))} RFB greeting ${d.checks.vncGreeting || d.vnc.directProbe?.error || '—'} (${d.vnc.directProbe?.ms ?? '—'} ms)`,
    `${y(d.checks.websocketProxy)} WebSocket proxy ${d.vnc.websocketProxy?.ok ? `${d.vnc.websocketProxy.greeting} in ${d.vnc.websocketProxy.ms} ms` : (d.vnc.websocketProxy?.error || '—')}`,
    '',
    `tools    x11vnc ${d.vnc.tools?.x11vnc ? 'y' : 'n'} · xdotool ${d.vnc.tools?.xdotool ? 'y' : 'n'} · arecord ${d.vnc.tools?.arecord ? 'y' : 'n'} · screenshot ${d.vnc.tools?.screenshot || 'n'}`,
  ];
  if (d.warnings?.length) {
    lines.push('', 'warnings');
    for (const w of d.warnings) lines.push(`  - ${w}`);
  }
  const sv = d.checks?.screenServer;
  if (sv) {
    lines.push(`${y(sv.ours)} Screen server on port ${d.vnc?.port ?? 5900}: ${sv.binary} (pid ${sv.pid}, ${sv.ours ? 'managed by this app' : 'NOT managed by this app'})`);
  }
  if (d.checks?.screenServerCommand) {
    lines.push(`        running as: ${d.checks.screenServerCommand.slice(0, 160)}`);
  }
  if (d.checks?.phoneVerdict) lines.push(`        phone: ${d.checks.phoneVerdict}`);
  if (d.checks?.vncGreeting) {
    const shape = d.checks.vncScreen ? ` · ${d.checks.vncScreen}` : '';
    const sec = d.checks.vncSecurity ? ` · security: ${d.checks.vncSecurity.join(', ')}` : '';
    lines.push(`${y(Boolean(d.checks.vncScreen))} Full screen handshake: ${d.checks.vncGreeting}${shape}${sec}`);
  }
  if (d.checks?.vncTrace?.length) {
    lines.push('', 'screen handshake, step by step');
    for (const t of d.checks.vncTrace) {
      const bytes = t.got !== undefined ? ` (${t.got}/${t.wants} bytes)` : '';
      lines.push(`  ${t.step}${bytes}${t.detail ? `: ${t.detail}` : ''}`);
    }
  }
  lines.push('', 'log');
  if (!(d.recentLog || []).length) lines.push('  (nothing logged yet)');
  for (const e of (d.recentLog || []).slice(-20)) {
    lines.push(`  ${e.t.slice(11, 19)} ${e.level} ${e.message}${describeLog(e.meta)}`);
  }
  return lines.join('\n');
}

async function closeRemote() {
  if (state.session) {
    state.session.disconnect();
    state.session = null;
  }
  document.body.classList.remove('remote-active');
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  show('home');
}

function applyMode(mode) {
  const labels = { touch: 'Touch', trackpad: 'Trackpad', scroll: 'Scroll' };
  $('#mode-label').textContent = labels[mode] || mode;
  const icon = $('#ico-mode-touch');
  icon.innerHTML = mode === 'touch'
    ? '<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>'
    : mode === 'trackpad'
      ? '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 7v3"/>'
      : '<path d="M12 3v18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3"/>';
  $('#btn-scroll').classList.toggle('active', mode === 'scroll');
  $('#btn-mode').classList.toggle('active', mode !== 'touch');
}

function applyViewOnly() {
  const value = $('#viewonly').checked;
  if (state.session) state.session.setViewOnly(value);
  $('#menu-viewonly').textContent = value ? 'on' : 'off';
}

/* ── remote toolbar wiring ─────────────────────────────────────── */

$('#btn-kbd').addEventListener('click', () => {
  const row = $('#mod-row');
  row.hidden = !row.hidden;
  const proxy = $('#kbd-proxy');
  if (!row.hidden) proxy.focus({ preventScroll: true });
  else proxy.blur();
});

$('#btn-mode').addEventListener('click', () => {
  if (!state.session?.input) return;
  const next = state.session.input.cycleMode();
  applyMode(next);
  toast(next === 'touch' ? 'Touch mode — finger is the pointer' : next === 'trackpad' ? 'Trackpad mode — relative movement' : 'Scroll mode — drag to scroll', '', 1600);
});

$('#btn-scroll').addEventListener('click', () => {
  if (!state.session?.input) return;
  const next = state.session.input.mode === 'scroll' ? 'touch' : 'scroll';
  state.session.input.setMode(next);
  applyMode(next);
});

$('#btn-more').addEventListener('click', () => {
  const menu = $('#remote-menu');
  menu.hidden = !menu.hidden;$('#btn-more').setAttribute('aria-expanded',String(!menu.hidden));
});

$('#btn-remote-back').addEventListener('click', closeRemote);
$('#btn-back-from-error').addEventListener('click', closeRemote);
/** Plain retry (the 'restart-vnc' / 'login' actions are handled above). */
$('#btn-retry').addEventListener('click', async () => {
  if ($('#btn-retry').dataset.action === 'restart-vnc') return; // handled by the smart handler
  if (await api('/api/auth').then((a) => !a.authed).catch(() => true)) {
    show('login');
    return;
  }
  setRemoteStatus('connecting', 'Retrying…');
  if (state.session) state.session.disconnect();
  state.session = null;
  await ensureVnc({ silent: true });
  await openRemote({ attempt: 1 });
});

$('#btn-remote-diag').addEventListener('click', showDiagnostics);

$('#btn-remote-hide').addEventListener('click', () => {
  $('#screen-remote').classList.add('hide-ui');
  $('#remote-dock').inert=true;$('#remote-bar').inert=true;
  $('#btn-show-bar').hidden = false;
});
$('#btn-show-bar').addEventListener('click', (ev) => {
  ev.stopPropagation();
  $('#screen-remote').classList.remove('hide-ui');
  $('#remote-dock').inert=false;$('#remote-bar').inert=false;
  $('#btn-show-bar').hidden = true;
});

$('#remote-menu').addEventListener('click', async (ev) => {
  const item = ev.target.closest('.menu-item');
  const action = item?.dataset.action;
  if (!item) return;
  const menu = $('#remote-menu');

  switch (action) {
    case 'keyboard': {
      menu.hidden = true;
      $('#mod-row').hidden = false;
      $('#kbd-proxy').focus({ preventScroll: true });
      break;
    }
    case 'keyboard-page': menu.hidden=true;openKeyboard('remote');break;
    case 'settings-page': menu.hidden=true;openSettings('display');break;
    case 'clipboard':
      menu.hidden = true;
      openSheet('sheet-clipboard');
      break;
    case 'screenshot':
      menu.hidden = true;
      openSheet('sheet-shot');
      loadScreenshot();
      break;
    case 'zoom': {
      const order = ['fit', '1', '2'];
      const current = state.session?.zoomMode || 'fit';
      const next = order[(order.indexOf(current) + 1) % order.length];
      state.session?.setZoom(next);
      break;
    }
    case 'quality': {
      const order = ['sharp', 'balanced', 'fast'];
      const current = localStorage.getItem('quality') || 'balanced';
      const next = order[(order.indexOf(current) + 1) % order.length];
      state.session?.setQuality(next);
      $('#menu-quality').textContent = next[0].toUpperCase() + next.slice(1);
      localStorage.setItem('quality', next);
      toast(`Quality: ${next}`, '', 1400);
      break;
    }
    case 'viewonly': {
      $('#viewonly').checked = !$('#viewonly').checked;
      applyViewOnly();
      toast($('#viewonly').checked ? 'View only — input disabled' : 'Input enabled', '', 1600);
      break;
    }
    case 'fullscreen': {
      menu.hidden = true;
      toggleFullscreen();
      break;
    }
    case 'gestures':
      menu.hidden = true;
      openSheet('sheet-gestures');
      break;
    case 'disconnect':
      menu.hidden = true;
      closeRemote();
      break;
    default:
      break;
  }
});

async function toggleFullscreen() {
  toggleImmersive();
}

/* ── modifier / key chips ──────────────────────────────────────── */

$('#mod-row').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip || !state.session) return;
  if (chip.dataset.mod) {
    const active = state.session.toggleModifier(chip.dataset.mod);
    chip.classList.toggle('active', active);
    return;
  }
  const send = chip.dataset.send;
  if (!send) return;
  if (send === 'ctrl-alt-del') {
    state.session.ctrlAltDel();
    return;
  }
  chip.classList.add('active');
  setTimeout(() => chip.classList.remove('active'), 140);
  state.session.pressKey(send);
  $$('#mod-row .chip[data-mod]').forEach((c) => c.classList.remove('active'));
});

/* ── software keyboard bridge ──────────────────────────────────── */

const proxy = $('#kbd-proxy');
proxy.addEventListener('input', () => {
  const value = proxy.value;
  proxy.value = '';
  if (!state.session) return;
  state.session.typeText(value);
  $$('#mod-row .chip[data-mod]').forEach((c) => c.classList.remove('active'));
});
proxy.addEventListener('keydown', (ev) => {
  if (!state.session) return;
  if (ev.key === 'Backspace') { state.session.pressKey('Backspace'); ev.preventDefault(); }
  if (ev.key === 'Enter') { state.session.pressKey('Enter'); ev.preventDefault(); }
});
proxy.addEventListener('blur', () => {
  // keep the dock as-is; the user can hide it manually
});

/* ── push to talk ──────────────────────────────────────────────── */

const pttBtn = $('#btn-ptt');
let pttActive = false;

async function pttStart(ev) {
  ev.preventDefault();
  if (pttActive || !state.session?.connected) return;
  pttActive = true;
  pttBtn.classList.add('recording');
  pttBtn.textContent = '🎙 Listening… release to play';
  try {
    const res = await api('/api/ptt/start', { method: 'POST' });
    if (res.ok === false) throw new Error(res.error || 'Microphone unavailable');
  } catch (err) {
    pttActive = false;
    pttBtn.classList.remove('recording');
    pttBtn.textContent = '🎙 Hold to talk on PC';
    toast(err.message, 'err', 5000);
  }
}

async function pttEnd(ev) {
  ev?.preventDefault();
  if (!pttActive) return;
  pttActive = false;
  pttBtn.classList.remove('recording');
  pttBtn.textContent = '🎙 Hold to talk on PC';
  try {
    await api('/api/ptt/stop', { method: 'POST', body: { play: true } });
  } catch (err) {
    toast(err.message, 'err');
  }
}

pttBtn.addEventListener('pointerdown', pttStart);
pttBtn.addEventListener('pointerup', pttEnd);
pttBtn.addEventListener('pointercancel', pttEnd);
pttBtn.addEventListener('pointerleave', (ev) => { if (pttActive) pttEnd(ev); });

/* ── sheets ────────────────────────────────────────────────────── */

let screenshotReturnFocus=null;
function openSheet(id) {
  const previous=document.activeElement;
  closeSheets();
  if(id==='sheet-shot')screenshotReturnFocus=previous;
  $('#backdrop').hidden = false;
  $(`#${id}`).hidden = false;
}

function closeSheets() {
  const wasScreenshot=!$('#sheet-shot').hidden;
  if(wasScreenshot)cancelScreenshot();
  if(!$('#sheet-settings').hidden && settingsFocus?.getClientRects().length)settingsFocus.focus({preventScroll:true});
  $('#backdrop').hidden = true;
  $$('.sheet').forEach((s) => { s.hidden = true; });
  if(wasScreenshot&&screenshotReturnFocus?.getClientRects().length)screenshotReturnFocus.focus({preventScroll:true});
}

$('#backdrop').addEventListener('click', closeSheets);
$$('[data-close-sheet]').forEach((btn) => btn.addEventListener('click', closeSheets));

/* settings sheet */

async function loadSettings() {
  const { data } = await api('/api/config');
  state.cfg = data;
  $('#set-name').value = data.name || '';
  $('#set-vncpass').value = data.vnc.password || '';
  $('#set-pttkey').value = data.ptt?.key || 'space';
  $$('#set-quality button').forEach((b) => b.classList.toggle('active', b.dataset.value === (data.quality || 'balanced')));
  $('#settings-device').textContent = `${state.auth?.host || ''} · signed in as ${state.auth?.user || 'user'} · ${state.auth?.tls ? 'HTTPS' : 'HTTP'}`;
}

$('#set-quality').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  $$('#set-quality button').forEach((b) => b.classList.toggle('active', b === btn));
});

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    const body = {
      name: $('#set-name').value.trim(),
      quality: $('#set-quality button.active')?.dataset.value || 'balanced',
      ptt: { key: ($('#set-pttkey').value.trim() || 'space') },
    };
    const pass = $('#set-vncpass').value.trim();
    if (pass !== (state.cfg?.vnc?.password || '')) {
      if (pass) body.vncPassword = pass;
      else body.vncPassword = '';
    }
    await api('/api/config', { method: 'POST', body });
    state.session?.setQuality(body.quality);
    $('#menu-quality').textContent = body.quality[0].toUpperCase() + body.quality.slice(1);
    toast('Settings saved', 'ok');
    closeSheets();
    refreshInfo();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-show-diag').addEventListener('click', showDiagnostics);

$('#btn-restart-vnc').addEventListener('click', async () => {
  toast('Restarting the screen server…');
  await api('/api/vnc/stop', { method: 'POST' }).catch(() => {});
  await ensureVnc();
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  sessionToken.clear();
  closeSheets();
  state.auth = null;
  boot();
});

/* pairing sheet */

async function loadPairing() {
  $('#qrbox').innerHTML = '<div class="spinner"></div>';
  $('#pair-url').textContent = '…';
  try {
    const { url, svg } = await api('/api/pair', { method: 'POST' });
    $('#qrbox').innerHTML = svg;
    $('#pair-url').textContent = url;
  } catch (err) {
    $('#qrbox').textContent = '';
    $('#pair-url').textContent = err.message;
  }
}

$('#btn-new-pair').addEventListener('click', loadPairing);
$('#btn-pair-here').addEventListener('click', () => {
  openSheet('sheet-pair');
  loadPairing();
});
$('#btn-copy-pair').addEventListener('click', async () => {
  const url = $('#pair-url').textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', 'ok');
  } catch {
    toast('Copy failed — long-press the link instead', 'err');
  }
});

/* power sheet */

$('#sheet-power').addEventListener('click', async (ev) => {
  const action = ev.target.closest('[data-power]')?.dataset.power;
  if (!action) return;
  const names = { lock: 'Lock', suspend: 'Suspend', reboot: 'Restart', poweroff: 'Shut down' };
  if ((action === 'reboot' || action === 'poweroff') && !confirm(`${names[action]} this PC?`)) return;
  try {
    await api('/api/power', { method: 'POST', body: { action } });
    toast(`${names[action]} sent`, 'ok');
    closeSheets();
  } catch (err) {
    toast(err.message, 'err', 6000);
    $('#power-hint').textContent = 'Tip: restart the app with `./install.sh --with-sudo` (run on the PC) to allow power actions.';
  }
});

/* clipboard sheet */

$('#btn-clip-send').addEventListener('click', () => {
  const text = $('#clip-out').value;
  if (!text) return toast('Nothing to send', 'err');
  state.session?.sendClipboard(text);
  toast('Sent to the PC clipboard', 'ok');
  closeSheets();
});

$('#btn-clip-copy').addEventListener('click', async () => {
  const text = $('#clip-in').value;
  if (!text) return toast('Nothing received yet', 'err');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok');
  } catch {
    toast('Select the text and copy manually', 'err');
  }
});

/* screenshot sheet */

const shotViewer=screenshotViewer($('#sheet-shot'));
let shotURL=null,shotController=null,shotRequest=0;
function cancelScreenshot(){
  shotRequest++;shotController?.abort();shotController=null;shotViewer.clear();
  if(shotURL)URL.revokeObjectURL(shotURL);shotURL=null;
  $('#btn-shot-again').disabled=false;
}
async function loadScreenshot() {
  cancelScreenshot();const request=shotRequest;
  shotController=new AbortController();
  const img=$('#shot-img'),msg=$('#shot-msg');
  msg.hidden=false;msg.textContent='Capturing…';$('#btn-shot-again').disabled=true;
  try{
    const token=sessionToken.get();
    const res=await fetch('/api/screenshot',{credentials:'same-origin',cache:'no-store',signal:shotController.signal,headers:token?{Authorization:`Bearer ${token}`}:{}});
    if(!res.ok){const data=await res.json().catch(()=>({}));throw Error(data.error||'Screenshot failed');}
    const blob=await res.blob();if(request!==shotRequest)return;
    shotURL=URL.createObjectURL(blob);img.src=shotURL;await img.decode();
    if(request!==shotRequest)return;
    img.hidden=false;msg.hidden=true;shotViewer.loaded();
  }catch(err){
    if(request!==shotRequest)return;
    shotViewer.clear();if(shotURL)URL.revokeObjectURL(shotURL);shotURL=null;
    msg.hidden=false;msg.textContent=err.message||'Screenshot failed';
  }finally{if(request===shotRequest)$('#btn-shot-again').disabled=false;}
}

$('#btn-shot-again').addEventListener('click', loadScreenshot);

$('#btn-diag-copy').addEventListener('click', async () => {
  const text = $('#diag-text').value;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste it anywhere', 'ok');
  } catch {
    // clipboard needs HTTPS on phones: select the text so it can be copied manually
    const box = $('#diag-text');
    box.removeAttribute('readonly');
    box.focus();
    box.select();
    document.execCommand?.('copy');
    box.setAttribute('readonly', '');
    toast('Selected — use Copy from the menu', '', 3000);
  }
});
$('#btn-diag-again').addEventListener('click', showDiagnostics);
$('#btn-diag-restart').addEventListener('click', restartServer);
$('#btn-diag-vnc').addEventListener('click', () => restartScreenServer());

/* home tiles & tabs */

$('#tile-screenshot').addEventListener('click', () => { openSheet('sheet-shot'); loadScreenshot(); });
$('#tile-power').addEventListener('click', () => openSheet('sheet-power'));
$('#tile-settings').addEventListener('click',()=>openSettings());
$('#tile-pair').addEventListener('click', () => { openSheet('sheet-pair'); loadPairing(); });

$('#btn-home-refresh').addEventListener('click', () => { refreshInfo(); toast('Refreshed'); });

$$('.tab').forEach((tab) => tab.addEventListener('click', async () => {
  $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  const which = tab.dataset.tab;
  if (which === 'home') return;
  if (which === 'screenshot') { openSheet('sheet-shot'); loadScreenshot(); }
  if (which === 'settings') await openSettings();
}));

$('#viewonly').addEventListener('change', applyViewOnly);

$('#btn-connect').addEventListener('click', async () => {
  const btn = $('#btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const ok = await ensureVnc({ silent: true });
    if (!ok) {
      toast('The screen server is not running', 'err', 5000);
      return;
    }
    await openRemote();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Open remote screen';
  }
});

$('#btn-vnc-start').addEventListener('click', () => ensureVnc());

/* ── pairing via QR link (?t=…) ────────────────────────────────── */

async function consumePairToken() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  if (!token) return false;
  try {
    const res = await api('/api/pair/consume', { method: 'POST', body: { token } });
    if (res.token) sessionToken.set(res.token);
    history.replaceState({}, '', location.pathname);
    toast('Device paired', 'ok');
    return true;
  } catch (err) {
    toast(err.message, 'err', 5000);
    history.replaceState({}, '', location.pathname);
    return false;
  }
}

/* ── boot ──────────────────────────────────────────────────────── */

async function boot() {
  let auth;
  try {
    auth = await api('/api/auth');
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  state.auth = auth;
  checkVersion(auth.version);
  $('#login-host').textContent = auth.name || auth.host;
  $('#login-title').textContent = `Unlock ${auth.name || 'your PC'}`;

  if (!auth.configured) return show('setup');
  if (!auth.authed) {
    pinBuffer = '';
    renderPinDots();
    return show('login');
  }
  $('#home-name').textContent = auth.name || auth.host;
  show('home');
  refreshInfo();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#screen-home').hidden) refreshInfo();
});

window.addEventListener('popstate', () => {
  if (!$('#screen-keyboard').hidden) closeKeyboard();
  else if (!$('#screen-remote').hidden) closeRemote();
  if (!$('#screen-pad').hidden) padScreen?.exit();
  if (!$('#screen-mouse').hidden) { mouseAbort?.abort(); mouseMotion?.stop(); show('home'); }
});

/** Service workers need HTTPS (or localhost); silently skip on plain-HTTP LAN. */
async function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('service worker not registered:', err.message);
  }
}

/** Handy for debugging from the browser console: __pd.state, __pd.api(). */
window.__pd = {
  state, api, toast, openRemote, closeRemote, restartServer, showDiagnostics, checkVersion,
  version: CLIENT_VERSION,
};

(async function init() {
  registerWorker();
  renderPinDots();
  $('#setup-name').value = '';
  await consumePairToken();
  await boot();
  if (!$('#screen-home').hidden) {
    const { data } = await api('/api/config').catch(() => ({ data: null }));
    state.cfg = data;
  }
})();
