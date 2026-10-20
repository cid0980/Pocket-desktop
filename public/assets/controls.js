/* Shared controller utilities. No network or third-party dependencies. */
/** Immersive mode hides the app's top bars and bottom controls so the picture uses the whole screen. */
export function isImmersive() { return document.body.classList.contains('pd-immersive'); }
/** Floating Menu in fullscreen: keeps Customize layout and Exit reachable, outside the top bar. */
function immersiveMenu() {
  let wrap = document.getElementById('pd-immersive-menu-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'pd-immersive-menu-wrap'; wrap.hidden = true;
    wrap.innerHTML = `<button type="button" id="pd-immersive-menu" aria-expanded="false" aria-label="Fullscreen menu">Menu</button>
      <div id="pd-immersive-panel" hidden>
        <button type="button" data-imm="pad">Gamepad</button>
        <button type="button" data-imm="mouse">Mouse pad</button>
        <button type="button" data-imm="keyboard">Keyboard</button>
        <button type="button" data-imm="layout">Customize layout</button>
        <button type="button" data-imm="exit">Exit fullscreen</button>
      </div>`;
    document.body.append(wrap);
    const menu = wrap.querySelector('#pd-immersive-menu');
    const panel = wrap.querySelector('#pd-immersive-panel');
    menu.addEventListener('click', () => {
      panel.hidden = !panel.hidden; menu.setAttribute('aria-expanded', String(!panel.hidden));
    });
    panel.addEventListener('click', e => {
      const op = e.target.closest('[data-imm]')?.dataset.imm;
      panel.hidden = true; menu.setAttribute('aria-expanded', 'false');
      if (op === 'exit') toggleImmersive();
      if (op === 'layout') document.dispatchEvent(new CustomEvent('pd:customize'));
      if (op === 'pad' || op === 'mouse' || op === 'keyboard') document.dispatchEvent(new CustomEvent('pd:open', { detail: op }));
    });
  }
  return wrap;
}
let immersiveToast = () => {};
/** Ask the browser for real fullscreen (hides address and status bars where allowed). Best effort. */
function browserFullscreen(on) {
  const el = document.documentElement;
  if (on && !document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      immersiveToast('The browser blocked full screen on this address. The app is still full screen. For full screen with the address bar hidden, open it over HTTPS (run.sh --tls).', 'err', 8000);
    });
  } else if (!on && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}
export function toggleImmersive() {
  const on = !isImmersive();
  document.body.classList.toggle('pd-immersive', on);
  immersiveMenu().hidden = !on;
  document.querySelectorAll('[data-fullscreen]').forEach(b => {
    if (!b.hasAttribute('data-compact')) b.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    b.setAttribute('aria-pressed', String(on));
  });
  browserFullscreen(on);
  window.dispatchEvent(new Event('resize'));
}
// Leaving browser fullscreen (system back/gesture) also leaves the app's fullscreen.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && isImmersive()) toggleImmersive();
});
export async function fullscreen(toast) { immersiveToast = toast || immersiveToast; toggleImmersive(); }

export class MotionPointer {
  constructor(send, status, sensitivity = () => 1) {
    Object.assign(this, { send, status, sensitivity });
    this.handler = e => this.read(e);
    this.rotate = () => { this.base = null; this.sx = this.sy = 0; };
    this.hide = () => { if (document.hidden) this.stop(); };
  }
  async toggle() {
    if (this.enabled) return this.stop();
    if (!window.isSecureContext) return this.status('Motion blocked: this page uses insecure HTTP. Use trusted HTTPS (see README → Motion / HTTPS), then allow motion sensors. Touchpad still works.', false);
    const API = window.DeviceOrientationEvent;
    if (!API) return this.status('Orientation API unavailable in this browser. Try an updated mobile browser; use the touchpad instead.', false);
    try {
      if (typeof API.requestPermission === 'function' && await API.requestPermission() !== 'granted')
        return this.status('Motion permission denied. Allow Motion & Orientation in browser site settings, then try again.', false);
    } catch (e) { return this.status('Motion permission request failed: ' + e.message, false); }
    this.enabled = true; this.active = false; this.base = null; this.sx = this.sy = 0;
    this.status('Waiting for sensor data…', false);
    window.addEventListener('deviceorientation', this.handler);
    window.addEventListener('orientationchange', this.rotate);
    document.addEventListener('visibilitychange', this.hide);
    this.timer = setTimeout(() => {
      if (!this.active) { this.stop(); this.status('No usable sensor data. Check site sensor permissions; this device or browser may not expose orientation sensors. Use the touchpad.', false); }
    }, 4000);
  }
  read(e) {
    if (!this.enabled || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    if (!this.active) { this.active = true; clearTimeout(this.timer); this.status('Motion on — tilt gently; Re-centre sets neutral.', true); }
    if (!this.base) { this.base = [e.beta, e.gamma]; this.last = performance.now(); return; }
    const now = performance.now(), dt = Math.min(40, now - this.last) / 16.667; this.last = now;
    const delta = (a,b) => ((a-b+540)%360)-180;
    const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI / 180;
    const x = delta(e.gamma, this.base[1]), y = delta(e.beta, this.base[0]);
    const dead = v => Math.abs(v) < 1.5 ? 0 : Math.sign(v) * Math.min(25, Math.abs(v)-1.5);
    this.sx = .75*this.sx + .25*dead(x*Math.cos(angle)+y*Math.sin(angle));
    this.sy = .75*this.sy + .25*dead(y*Math.cos(angle)-x*Math.sin(angle));
    const gain = this.sensitivity()*dt;
    const dx = Math.round(this.sx*gain), dy = Math.round(this.sy*gain);
    if (dx || dy) this.send({t:'ptr',dx,dy});
  }
  recenter() { this.rotate(); }
  stop() {
    this.enabled = this.active = false; clearTimeout(this.timer);
    window.removeEventListener('deviceorientation', this.handler);
    window.removeEventListener('orientationchange', this.rotate);
    document.removeEventListener('visibilitychange', this.hide);
    this.status('Motion off', false);
  }
}

const MIN_SCALE = 0.5, MAX_SCALE = 2.5;
const SHAPES = ['circle', 'rounded', 'pill'];
const SHAPE_RADIUS = { circle: '50%', rounded: '16px', pill: '999px' };
const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clampScale = (v) => Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, v)) * 100) / 100;

/**
 * Layout editor v3.
 * Stored per control: {x, y, sx, sy, h, shape?}
 *   x,y    normalized position (0..1) inside the viewport
 *   sx,sy  width and height multipliers (0.5..2.5)
 *   h      hidden flag (hidden controls stay in the editor, dashed, so they can be shown again)
 *   shape  optional: 'circle' | 'rounded' | 'pill' (absent = the control's own shape)
 * Version 1 ({x,y}) and version 2 ({x,y,s,h}) files are still accepted.
 */
export class LayoutEditor {
  constructor(pages, toast) {
    this.pages = pages; this.toast = toast; this.key = 'pd-layouts-v1';
    this.saved = this.empty(); this.nodes = {}; this.natural = {};
    this.editing = false; this.page = null; this.selected = null; this.collapsed = true;
    this.drag = null; this.resizing = null;

    for (const [page, root] of Object.entries(pages)) {
      this.nodes[page] = {}; this.natural[page] = {};
      root.querySelectorAll('[data-layout]').forEach(el => { this.nodes[page][el.dataset.layout] = el; });
      root.addEventListener('pointerdown', e => this.down(e, page), true);
      root.addEventListener('pointermove', e => this.move(e), true);
      for (const event of ['pointerup', 'pointercancel']) root.addEventListener(event, e => {
        if (!this.editing) return; e.stopImmediatePropagation(); e.preventDefault();
        this.drag = null; this.panel.classList.remove('dragging');
      }, true);
      root.addEventListener('click', e => {
        if (this.editing && e.target.closest('[data-layout]')) { e.stopImmediatePropagation(); e.preventDefault(); }
      }, true);
    }

    // Layouts saved before v3 stored the whole pad face/system groups as one item. Those cannot map to
    // individual buttons, so drop them (the buttons then use their default place) instead of rejecting everything.
    this.headerNodes = new Set();
    for (const nodes of Object.values(this.nodes)) for (const el of Object.values(nodes))
      if (el.closest('.pad-top, .control-top, #remote-bar')) this.headerNodes.add(el);
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) {
        const data = JSON.parse(raw);
        // Drop ids that no longer exist (e.g. older grouped items such as pad-face or remote-dock).
        if (data?.pages) for (const page of Object.keys(data.pages))
          for (const k of Object.keys(data.pages[page] || {})) if (!this.nodes[page]?.[k]) delete data.pages[page][k];
        this.saved = this.validate(data);
      }
    } catch { toast('Saved layouts were unreadable or outdated; using defaults.'); }
    this.draft = clone(this.saved);

    // Toolbar: fixed to the bottom above the safe area. It starts collapsed and hides while dragging.
    this.panel = document.createElement('div');
    this.panel.className = 'layout-editor'; this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="le-head">
        <strong data-sel>Tap a control to select it</strong>
        <button type="button" data-op="save" class="primary">Save</button>
        <button type="button" data-op="cancel">Cancel</button>
        <button type="button" data-op="collapse" aria-expanded="false">Tools ▴</button>
      </div>
      <div class="le-body">
        <div class="le-row">
          <button type="button" data-op="smaller" disabled aria-label="Smaller">−</button>
          <button type="button" data-op="bigger" disabled aria-label="Bigger">+</button>
          <label class="le-num">W% <input type="number" data-op="w" min="50" max="250" step="1" disabled></label>
          <label class="le-num">H% <input type="number" data-op="h" min="50" max="250" step="1" disabled></label>
          <select data-op="shape" disabled aria-label="Shape">
            <option value="">Shape: default</option>
            <option value="circle">Circle</option>
            <option value="rounded">Rounded</option>
            <option value="pill">Pill</option>
          </select>
          <button type="button" data-op="hide" disabled>Hide</button>
        </div>
        <div class="le-row" data-hidden-list hidden></div>
        <div class="le-main">
          <button type="button" data-op="reset">Reset page</button>
          <button type="button" data-op="all">Reset all</button>
          <button type="button" data-op="export">Export JSON</button>
          <button type="button" data-op="import">Import JSON</button>
        </div>
        <div class="le-hint">Tap a control to select it. Drag to move. Drag the corner handle to change width and height. + / − resizes both.</div>
        <p role="status">Changes are not saved yet.</p>
      </div>
      <input type="file" accept="application/json,.json" hidden>`;
    document.body.append(this.panel);
    this.panel.addEventListener('click', e => {
      const b = e.target.closest('[data-op]');
      if (!b || b.disabled || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
      if (b.dataset.op === 'show') this.unhide(b.dataset.id);
      else this.action(b.dataset.op);
    });
    // Enter in a size box applies it (blur fires the change event).
    this.panel.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.target.dataset.op === 'w' || e.target.dataset.op === 'h')) e.target.blur();
    });
    this.panel.addEventListener('change', e => {
      const op = e.target.dataset.op;
      if (op === 'shape') this.setShape(this.page, this.selected, e.target.value);
      if ((op === 'w' || op === 'h') && this.selected && this.draft.pages[this.page][this.selected]) {
        const v = Number(e.target.value);
        if (!Number.isFinite(v) || v <= 0) { this.renderTools(); return; }
        const cur = this.draft.pages[this.page][this.selected];
        if (op === 'w') this.setSize(this.page, this.selected, v / 100, cur.sy);
        else this.setSize(this.page, this.selected, cur.sx, v / 100);
      }
    });
    this.panel.querySelector('input[type="file"]').addEventListener('change', async e => {
      try {
        const file = e.target.files[0]; if (!file) return;
        if (file.size > 100000) throw Error('File too large');
        const valid = this.validate(JSON.parse(await file.text()));
        if (!confirm('Replace the layout draft for all pages with this file? Click Save to keep it.')) return;
        this.draft = valid; this.selected = null; this.apply();
        this.message('Imported and validated. Click Save to keep these layouts.', true);
      } catch (err) { this.message('Import rejected: ' + err.message, true); }
      e.target.value = '';
    });

    // Resize handle for the selected control. It sits outside the page roots.
    this.handle = document.createElement('div');
    this.handle.className = 'layout-handle'; this.handle.hidden = true;
    this.handle.setAttribute('role', 'presentation');
    document.body.append(this.handle);
    this.handle.addEventListener('pointerdown', e => {
      const page = this.page, id = this.selected;
      if (!this.editing || !id || !this.draft.pages[page][id]) return;
      e.preventDefault(); e.stopPropagation();
      const r = this.nodes[page][id].getBoundingClientRect(), cur = this.draft.pages[page][id];
      this.resizing = { pointer: e.pointerId, page, id, left: r.left, top: r.top,
        dx: Math.max(20, e.clientX - r.left), dy: Math.max(20, e.clientY - r.top), sx: cur.sx, sy: cur.sy };
      this.panel.classList.add('dragging');
      this.handle.setPointerCapture(e.pointerId);
    });
    this.handle.addEventListener('pointermove', e => {
      const z = this.resizing; if (!z || e.pointerId !== z.pointer) return;
      e.preventDefault(); e.stopPropagation();
      const fx = Math.max(0.05, e.clientX - z.left) / z.dx, fy = Math.max(0.05, e.clientY - z.top) / z.dy;
      this.setSize(z.page, z.id, z.sx * fx, z.sy * fy);
    });
    const endResize = e => {
      if (this.resizing && e.pointerId === this.resizing.pointer) { this.resizing = null; this.panel.classList.remove('dragging'); }
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.handle.addEventListener(ev, endResize);

    this.resize = () => this.apply();
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    this.apply();
  }

  empty() { return { version: 3, pages: { remote: {}, pad: {}, mouse: {} } }; }

  validate(value) {
    if (!value || ![1, 2, 3].includes(value.version) || !value.pages || Object.keys(value.pages).length !== 3)
      throw Error('Expected a layout file with remote, pad and mouse pages');
    const out = this.empty();
    for (const page of Object.keys(out.pages)) {
      const entries = value.pages[page];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('Invalid page ' + page);
      for (const [id, pos] of Object.entries(entries)) {
        if (!Object.hasOwn(this.nodes[page], id) || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)
            || pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1)
          throw Error('Invalid control position: ' + id);
        const sx = pos.sx ?? pos.s ?? 1, sy = pos.sy ?? pos.s ?? 1;
        for (const v of [sx, sy]) if (!Number.isFinite(v) || v < MIN_SCALE || v > MAX_SCALE) throw Error('Invalid size for ' + id);
        if (pos.h !== undefined && typeof pos.h !== 'boolean') throw Error('Invalid hidden flag for ' + id);
        if (pos.shape !== undefined && !SHAPES.includes(pos.shape)) throw Error('Invalid shape for ' + id);
        const entry = { x: pos.x, y: pos.y, sx, sy, h: !!pos.h };
        if (pos.shape) entry.shape = pos.shape;
        out.pages[page][id] = entry;
      }
    }
    return out;
  }

  begin(page) {
    if (this.editing) return;
    this.page = page; this.editing = true; this.selected = null; this.draft = clone(this.saved);
    this.panel.hidden = false; this.setCollapsed(true);
    this.pages[page].classList.add('layout-editing');
    this.pages[page].querySelectorAll('[data-edit]').forEach(b => b.setAttribute('aria-pressed', 'true'));
    this.message('Changes are not saved yet.');
    this.apply();
  }

  message(text, important = false) {
    this.panel.querySelector('[role="status"]').textContent = text;
    if (important && this.collapsed) this.toast(text, '', 5000);
  }

  setCollapsed(on) {
    this.collapsed = on;
    this.panel.classList.toggle('collapsed', on);
    const b = this.panel.querySelector('[data-op="collapse"]');
    b.setAttribute('aria-expanded', String(!on)); b.textContent = on ? 'Tools ▴' : 'Tools ▾';
  }

  topInset(page, id) {
    if (id && this.headerNodes.has(this.nodes[page][id])) return 8;
    return page === 'pad' ? Math.max(8, this.pages.pad.querySelector('.pad-top').getBoundingClientRect().bottom + 8) : 8;
  }

  /** On-screen size of a control: natural size times its width/height multipliers. */
  size(page, id) {
    const n = this.natural[page][id] || { w: 40, h: 40 };
    const d = this.draft.pages[page][id];
    return { w: n.w * (d?.sx ?? 1), h: n.h * (d?.sy ?? 1) };
  }

  /** First touch on a control that has never been moved: store its current place so it can be edited. */
  ensurePos(page, id) {
    const cur = this.draft.pages[page];
    if (cur[id]) return cur[id];
    const r = this.nodes[page][id].getBoundingClientRect();
    const top = this.topInset(page, id);
    cur[id] = {
      x: clamp01((r.left - 8) / Math.max(1, innerWidth - r.width - 16)),
      y: clamp01((r.top - top) / Math.max(1, innerHeight - r.height - top - 8)),
      sx: 1, sy: 1, h: false,
    };
    return cur[id];
  }

  down(e, page) {
    if (!this.editing || page !== this.page) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const el = e.target.closest('[data-layout]');
    if (!el) { this.select(null); return; }
    const id = el.dataset.layout;
    this.ensurePos(page, id);
    this.select(id);
    const r = el.getBoundingClientRect();
    this.drag = { el, page, id, pointer: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top };
    this.panel.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
  }

  move(e) {
    const d = this.drag; if (!d || e.pointerId !== d.pointer) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const top = this.topInset(d.page, d.id), { w, h } = this.size(d.page, d.id);
    const cur = this.draft.pages[d.page][d.id];
    cur.x = clamp01((e.clientX - d.ox - 8) / Math.max(1, innerWidth - w - 16));
    cur.y = clamp01((e.clientY - d.oy - top) / Math.max(1, innerHeight - h - top - 8));
    this.apply(); this.message('Unsaved changes');
  }

  /** Change width/height multipliers but keep the control's top-left corner where it is. */
  setSize(page, id, sx, sy) {
    const cur = this.draft.pages[page][id];
    const r = this.nodes[page][id].getBoundingClientRect();
    cur.sx = clampScale(sx); cur.sy = clampScale(sy);
    const top = this.topInset(page, id), { w, h } = this.size(page, id);
    cur.x = clamp01((r.left - 8) / Math.max(1, innerWidth - w - 16));
    cur.y = clamp01((r.top - top) / Math.max(1, innerHeight - h - top - 8));
    this.apply();
    this.message(`Size ${Math.round(cur.sx * 100)}% × ${Math.round(cur.sy * 100)}%`);
  }

  setShape(page, id, shape) {
    const cur = this.draft.pages[page]?.[id]; if (!cur) return;
    if (shape) cur.shape = shape; else delete cur.shape;
    this.apply(); this.message(shape ? `Shape: ${shape}` : 'Shape: default');
  }

  select(id) { this.selected = id; this.apply(); }

  labelOf(page, id) {
    const el = this.nodes[page][id];
    return el.getAttribute('aria-label') || el.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) || id;
  }

  apply() {
    for (const [page, nodes] of Object.entries(this.nodes)) {
      for (const el of Object.values(nodes)) {
        for (const prop of ['position', 'left', 'top', 'right', 'bottom', 'transform', 'transform-origin', 'z-index',
                            'margin', 'width', 'height', 'display', 'border-radius'])
          el.style.removeProperty(prop);
        el.classList.remove('layout-hidden', 'layout-selected');
      }
      if (this.pages[page].hidden) continue;
      // Measure natural sizes with no inline styles applied.
      for (const [id, el] of Object.entries(nodes)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) this.natural[page][id] = { w: r.width, h: r.height };
      }
      for (const [id, el] of Object.entries(nodes)) {
        const pos = this.draft.pages[page][id]; const n = this.natural[page][id];
        if (!pos || !n) continue;
        const { w, h } = this.size(page, id), top = this.topInset(page, id);
        Object.assign(el.style, {
          position: 'fixed', right: 'auto', bottom: 'auto', margin: '0', zIndex: '12',
          width: n.w + 'px', height: n.h + 'px', transformOrigin: '0 0',
          transform: `scale(${pos.sx}, ${pos.sy})`,
          left: (8 + pos.x * Math.max(0, innerWidth - w - 16)) + 'px',
          top: (top + pos.y * Math.max(0, innerHeight - h - top - 8)) + 'px',
        });
        if (pos.shape) el.style.borderRadius = SHAPE_RADIUS[pos.shape];
        if (pos.h) {
          if (this.editing) el.classList.add('layout-hidden'); else el.style.display = 'none';
        }
        if (this.editing && page === this.page && id === this.selected) el.classList.add('layout-selected');
      }
    }
    this.renderTools(); this.placeHandle();
  }

  renderTools() {
    if (!this.editing) return;
    const page = this.page, id = this.selected, pos = id && this.draft.pages[page][id];
    const sel = this.panel.querySelector('[data-sel]');
    sel.textContent = pos
      ? `${this.labelOf(page, id)}${pos.h ? ' (hidden)' : ''} · ${Math.round(pos.sx * 100)}%×${Math.round(pos.sy * 100)}%`
      : 'Tap a control to select it';
    for (const op of ['smaller', 'bigger', 'hide']) this.panel.querySelector(`[data-op="${op}"]`).disabled = !pos;
    const shapeSel = this.panel.querySelector('[data-op="shape"]');
    shapeSel.disabled = !pos; shapeSel.value = pos?.shape || '';
    for (const [op, v] of [['w', pos?.sx], ['h', pos?.sy]]) {
      const input = this.panel.querySelector(`[data-op="${op}"]`);
      input.disabled = !pos;
      if (document.activeElement !== input) input.value = pos ? Math.round(v * 100) : '';
    }
    this.panel.querySelector('[data-op="hide"]').textContent = pos?.h ? 'Show' : 'Hide';

    const list = this.panel.querySelector('[data-hidden-list]');
    const hiddenIds = Object.keys(this.draft.pages[page]).filter(k => this.draft.pages[page][k].h && this.nodes[page][k]);
    list.replaceChildren();
    list.hidden = !hiddenIds.length;
    if (hiddenIds.length) {
      const label = document.createElement('span'); label.textContent = 'Hidden:';
      list.append(label);
      for (const hid of hiddenIds) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.op = 'show'; b.dataset.id = hid;
        b.textContent = '+ ' + this.labelOf(page, hid);
        list.append(b);
      }
    }
  }

  placeHandle() {
    const page = this.page, id = this.selected;
    const show = this.editing && id && !this.pages[page].hidden && this.draft.pages[page][id];
    this.handle.hidden = !show;
    if (!show) return;
    const r = this.nodes[page][id].getBoundingClientRect();
    Object.assign(this.handle.style, { left: (r.right - 22) + 'px', top: (r.bottom - 22) + 'px' });
  }

  unhide(id) {
    const pos = this.draft.pages[this.page][id]; if (!pos) return;
    pos.h = false; this.selected = id; this.apply(); this.message('Shown again.');
  }

  action(op) {
    const page = this.page, id = this.selected, pos = id && this.draft.pages[page][id];
    if (op === 'collapse') { this.setCollapsed(!this.collapsed); return; }
    if (op === 'bigger' || op === 'smaller') {
      if (pos) { const d = op === 'bigger' ? 0.1 : -0.1; this.setSize(page, id, pos.sx + d, pos.sy + d); }
      return;
    }
    if (op === 'hide') {
      if (!pos) return;
      pos.h = !pos.h; this.apply();
      this.message(pos.h ? 'Hidden. Use + in the Hidden list to show it again.' : 'Shown again.');
      return;
    }
    if (op === 'reset') { this.draft.pages[page] = {}; this.selected = null; this.apply(); this.message('Page reset. Click Save to keep.'); }
    if (op === 'all' && confirm('Reset layouts on all three pages?')) { this.draft = this.empty(); this.selected = null; this.apply(); this.message('All reset. Click Save to keep.'); }
    if (op === 'save') {
      try {
        const valid = this.validate(this.draft);
        localStorage.setItem(this.key, JSON.stringify(valid));
        this.saved = valid; this.toast('Layouts saved on this browser'); this.finish();
      } catch (e) { this.message('Could not save: ' + e.message, true); }
    }
    if (op === 'cancel') this.finish();
    if (op === 'import') this.panel.querySelector('input[type="file"]').click();
    if (op === 'export') {
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.draft, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'pocket-desktop-layouts.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message('Exported current layout draft.', true);
    }
  }

  finish() {
    this.editing = false; this.drag = null; this.resizing = null; this.selected = null;
    this.panel.hidden = true; this.handle.hidden = true; this.panel.classList.remove('dragging');
    Object.values(this.pages).forEach(r => {
      r.classList.remove('layout-editing');
      r.querySelectorAll('[data-edit]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    });
    this.draft = clone(this.saved); this.apply();
  }
}

export function bindMouseButton(el, button, send, signal) {
  let pointer=null;
  const up=()=> { if(pointer===null) return; pointer=null; el.classList.remove('down'); send({t:'btn',b:button,d:0}); };
  el.addEventListener('pointerdown',e=>{ if(pointer!==null) return; pointer=e.pointerId; el.setPointerCapture(e.pointerId); el.classList.add('down'); send({t:'btn',b:button,d:1}); e.preventDefault(); },{signal});
  for(const event of ['pointerup','pointercancel','lostpointercapture']) el.addEventListener(event,up,{signal});
  el.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
  window.addEventListener('blur',up,{signal});
  signal?.addEventListener('abort',up,{once:true});
}

/** One owner for surface gestures and dedicated buttons. All output uses the
 * existing btn/down/up + relative-pointer protocol, never synthetic click-only drag.
 * Touch: early swipe = move; 400ms stationary hold = left drag; configurable tap window.
 */
export function bindTouchpad(el, send, signal, options = {}) {
  const tapMs = () => Math.max(250, Math.min(350, Number(options.tapMs?.()) || 300));
  const speed = () => Math.max(.2, Math.min(2, Number(options.speed?.()) || .6));
  const HOLD_MS=400, SLOP=10, DOUBLE_RADIUS=32;
  let fractionX=0, fractionY=0;
  const move = (dx,dy) => {
    fractionX += dx*speed(); fractionY += dy*speed();
    const x=Math.trunc(fractionX),y=Math.trunc(fractionY);
    fractionX-=x;fractionY-=y;
    if(x||y)send({t:'ptr',dx:x,dy:y});
  };
  const points=new Map(), held=new Map(), buttonEls=new Map(), resetters=new Set();
  let pending=null, holdTimer=null, hover=null;
  const on=(target,type,fn,extra={})=>target.addEventListener(type,fn,{signal,...extra});
  const anyHeld=()=>held.size>0;
  const set=(owner,button,down)=>{
    const was=[...held.values()].includes(button);
    if(down) held.set(owner,button); else held.delete(owner);
    const now=[...held.values()].includes(button);
    if(was!==now) send({t:'btn',b:button,d:now?1:0});
    el.classList.toggle('dragging',anyHeld());
  };
  const cancelTap=()=>{if(pending)clearTimeout(pending.timer);pending=null;};
  const cancelHold=()=>{clearTimeout(holdTimer);holdTimer=null;};
  // Taps are timed at the PC, not as back-to-back down/up packets.
  const click=button=>{if(!anyHeld())send({t:'click',b:button});};
  const reset=()=>{
    cancelTap();cancelHold();points.clear();hover=null;fractionX=fractionY=0;
    for(const [owner,button]of [...held])set(owner,button,false);
    for(const button of buttonEls.keys())button.classList.remove('down');
    for(const fn of resetters)fn();
    el.classList.remove('dragging');
  };
  const outside=e=>{const r=el.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
  on(el,'pointerdown',e=>{
    if(e.pointerType==='mouse' && ![0,2].includes(e.button))return;
    e.preventDefault();try{el.setPointerCapture(e.pointerId);}catch{}hover=null;
    fractionX=fractionY=0;
    let second=false; const prior=pending;
    if(pending) {
      second=performance.now()-pending.at<=tapMs()&&Math.hypot(e.clientX-pending.x,e.clientY-pending.y)<=DOUBLE_RADIUS;
      cancelTap();
    }
    const p={x:e.clientX,y:e.clientY,ox:e.clientX,oy:e.clientY,at:performance.now(),mode:anyHeld()?'external':'tap',second,first:!!prior&&!second,button:e.button===2?'right':'left',type:e.pointerType};
    points.set(e.pointerId,p);
    if(points.size>1){cancelHold();cancelTap();for(const q of points.values())q.mode='ignored';if(held.has('surface'))set('surface',held.get('surface'),false);return;}
    if(p.mode==='tap') holdTimer=setTimeout(()=>{
      if(points.get(e.pointerId)!==p||p.mode!=='tap')return;
      cancelTap();p.mode='drag';set('surface',p.button,true);
    },HOLD_MS);
  });
  on(el,'pointermove',e=>{
    const p=points.get(e.pointerId);
    if(!p) {
      if(e.pointerType==='mouse'&&!e.buttons){if(hover)move(e.clientX-hover.x,e.clientY-hover.y);hover={x:e.clientX,y:e.clientY};}
      return;
    }
    e.preventDefault();if(outside(e)){reset();return;}
    let dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
    if(p.mode==='tap') {
      if(Math.hypot(e.clientX-p.ox,e.clientY-p.oy)<=SLOP)return;
      cancelTap();cancelHold();
      if(p.type==='mouse'){p.mode='drag';set('surface',p.button,true);}else p.mode='move';
      // Do not replay the tap dead-zone as a jump when movement starts.
    }
    if(p.mode!=='ignored'&&(dx||dy))move(dx,dy);
  });
  on(el,'pointerup',e=>{
    const p=points.get(e.pointerId);if(!p)return;
    e.preventDefault();points.delete(e.pointerId);cancelHold();
    if(p.mode==='tap'&&performance.now()-p.at<HOLD_MS&&!outside(e)&&!anyHeld()) {
      if(p.second||p.button==='right')click('right');
      else {if(p.first)click('left');const tap={at:performance.now(),x:e.clientX,y:e.clientY};tap.timer=setTimeout(()=>{if(pending===tap){pending=null;click('left');}},tapMs());pending=tap;}
    } else if(p.mode==='drag'||p.mode==='external')reset();
    // Multi-touch on the pad is ignored until all contacts lift. No scroll gesture.
  });
  on(el,'pointercancel',e=>{if(points.has(e.pointerId))reset();});
  on(el,'pointerleave',e=>{if((points.has(e.pointerId)||anyHeld())&&outside(e))reset();else hover=null;});
  on(el,'lostpointercapture',e=>{if(points.has(e.pointerId))reset();});
  on(el,'contextmenu',e=>e.preventDefault());
  // Native trackpad wheel events must not reintroduce two-finger scrolling.
  on(el,'wheel',e=>e.preventDefault(),{passive:false});
  on(window,'blur',reset);on(window,'pd:control-lost',reset);
  on(document,'visibilitychange',()=>{if(document.hidden)reset();});
  signal.addEventListener('abort',reset,{once:true});
  const bindButton=(button,name)=>{
    buttonEls.set(button,name);let pointer=null;resetters.add(()=>pointer=null);
    const up=e=>{if(pointer===null||(e&&e.pointerId!==pointer))return;pointer=null;button.classList.remove('down');set(button,name,false);};
    on(button,'pointerdown',e=>{
      if(pointer!==null)return;
      cancelTap();cancelHold();for(const p of points.values())p.mode='external';
      pointer=e.pointerId;button.setPointerCapture(pointer);button.classList.add('down');set(button,name,true);e.preventDefault();
    });
    for(const event of ['pointerup','pointercancel','pointerleave','lostpointercapture'])on(button,event,up);
    on(button,'contextmenu',e=>e.preventDefault());
    on(button,'click',e=>{if(e.detail===0){cancelTap();if(!anyHeld())click(name);}}); // keyboard/AT activation
    on(window,'pd:control-lost',()=>pointer=null);on(window,'blur',()=>pointer=null);
    on(document,'visibilitychange',()=>{if(document.hidden)pointer=null;});
    signal.addEventListener('abort',()=>pointer=null,{once:true});
  };
  return {reset,bindButton,cancelPending:cancelTap};
}

/** Independent one-finger scroll strip. Upward drag -> positive Linux wheel. */
export function bindScrollStrip(el, send, signal, cancelPending = () => {}) {
  let pointer=null,lastY=0,remainder=0,originY=0;
  const thumb=el.querySelector('.scroll-thumb');
  const on=(type,fn,extra={})=>el.addEventListener(type,fn,{signal,...extra});
  const reset=()=>{pointer=null;remainder=0;thumb.style.transform='translateY(0px)';el.setAttribute('aria-valuenow','0');el.classList.remove('active');};
  on('pointerdown',e=>{if(pointer!==null)return;cancelPending();pointer=e.pointerId;lastY=originY=e.clientY;el.setPointerCapture(pointer);el.classList.add('active');e.preventDefault();});
  on('pointermove',e=>{
    if(e.pointerId!==pointer)return;e.preventDefault();
    remainder+=(lastY-e.clientY)/18;lastY=e.clientY;
    const wheel=Math.trunc(remainder);remainder-=wheel;if(wheel)send({t:'wheel',d:Math.max(-8,Math.min(8,wheel))});
    const limit=Math.max(1,(el.clientHeight-70)/2),offset=Math.max(-limit,Math.min(limit,e.clientY-originY));
    thumb.style.transform=`translateY(${offset}px)`;el.setAttribute('aria-valuenow',String(Math.round(-offset/limit*100)));
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])on(event,e=>{if(e.pointerId===pointer)reset();});
  on('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();send({t:'wheel',d:e.key==='ArrowUp'?1:-1});}});
  on('wheel',e=>{e.preventDefault();send({t:'wheel',d:Math.sign(-e.deltaY)});},{passive:false});
  on('contextmenu',e=>e.preventDefault());
  window.addEventListener('pd:control-lost',reset,{signal});window.addEventListener('blur',reset,{signal});
  signal.addEventListener('abort',reset,{once:true});
  return {reset};
}
