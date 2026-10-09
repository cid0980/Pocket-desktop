/**
 * Remote session: wraps noVNC and adds a phone-friendly touch layer.
 *
 * Why this file exists
 * --------------------
 * noVNC's public API has no way to inject pointer/keyboard input, and its own
 * touch handling is aimed at desktops with touch monitors rather than thumbs on
 * a phone. So:
 *   • we synthesise DOM mouse/wheel events on noVNC's canvas — the library maps
 *     them to RFB messages for us (coordinates included, even when the view is
 *     scaled or zoomed),
 *   • we block the *real* mouse events at the stage so nothing is handled twice,
 *   • keyboards (soft and hardware) are translated to X11 keysyms.
 */

import RFB from '/vendor/novnc/core/rfb.js';

const WHEEL_STEP = 50; // noVNC accumulates wheel deltas; a step is emitted each 50px

/** DOM `buttons` bitmask values for the buttons we care about. */
const BTN = { left: 1, right: 2, middle: 4 };

/** DOM code → X11 keysym, for keys that do not produce a character. */
const KEYSYMS = {
  Enter: 0xff0d, NumpadEnter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b,
  Delete: 0xffff, Insert: 0xff63, Home: 0xff50, End: 0xff57,
  PageUp: 0xff55, PageDown: 0xff56, PrintScreen: 0xff61, Pause: 0xff13,
  ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
  ControlLeft: 0xffe3, ControlRight: 0xffe4, ShiftLeft: 0xffe1, ShiftRight: 0xffe2,
  AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb, MetaRight: 0xffec,
  CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14, ContextMenu: 0xff67,
  Space: 0x20, Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b, BracketRight: 0x5d,
  Backslash: 0x5c, Semicolon: 0x3b, Quote: 0x27, Backquote: 0x60,
  Comma: 0x2c, Period: 0x2e, Slash: 0x2f,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
};

/** Characters that sit on the shifted row of a US keyboard. */
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class RemoteSession {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.stage  element that receives touch input
   * @param {HTMLElement} opts.wrap   element that gets zoom/pan transforms
   * @param {HTMLElement} opts.host   element noVNC attaches its canvas to
   */
  constructor(opts) {
    this.stage = opts.stage;
    this.wrap = opts.wrap;
    this.host = opts.host;
    this.callbacks = {
      onState: opts.onState || (() => {}),
      onDesktopName: opts.onDesktopName || (() => {}),
      onClipboard: opts.onClipboard || (() => {}),
      onBell: opts.onBell || (() => {}),
      onViewChange: opts.onViewChange || (() => {}),
      onError: opts.onError || (() => {}),
      onNeedPassword: opts.onNeedPassword || (() => null),
    };
    this.credentials = opts.credentials || {};

    this.token = opts.token || null;
    this.rfb = null;
    this.connected = false;
    this.viewOnly = false;
    this.input = null;      // InputLayer
    this.modifiers = new Set();
    this._heldKeys = new Map();
    this._active = false;   // is the remote screen visible?

    // view transform
    this.factor = 1;        // relative to "fit" (1 = fit, >1 = zoomed in)
    this.tx = 0;
    this.ty = 0;
    this.zoomMode = 'fit';

    this._bound = {
      down: (e) => this._onPointerDown(e),
      move: (e) => this._onPointerMove(e),
      up: (e) => this._onPointerUp(e),
      cancel: (e) => this._onPointerUp(e, true),
      keydown: (e) => this._onKeyDown(e),
      keyup: (e) => this._onKeyUp(e),
      blocker: (e) => this._blockRealEvents(e),
      resize: () => this._clampPan(),
    };
  }

  get canvas() {
    return this.rfb?._canvas || this.host.querySelector('canvas');
  }

  /* ── lifecycle ─────────────────────────────────────────────────── */

  async connect() {
    if (this.rfb) this.disconnect();
    this.callbacks.onState('connecting');
    const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = this.token ? `?t=${encodeURIComponent(this.token)}` : '';
    const url = `${wsScheme}://${location.host}/ws${query}`;

    const rfb = new RFB(this.host, url, { credentials: this.credentials });
    this.rfb = rfb;
    rfb.background = '#000';
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;
    rfb.dragViewport = false;
    rfb.viewOnly = this.viewOnly;
    this._applyQualityFromStorage();

    // Watch the raw socket so failures have a concrete reason (HTTP status,
    // close code) instead of a generic "connection lost".
    const ws = rfb._sock?._websocket;
    if (ws) {
      this._watchSocket(ws);
    }

    rfb.addEventListener('connect', () => {
      this.connected = true;
      this._attachInput(); // before announcing, so callers can read .input
      this._connectedAt = Date.now();
      this.callbacks.onState('connected');
    });
    rfb.addEventListener('disconnect', (ev) => {
      this.connected = false;
      this._detachInput();
      this.callbacks.onState('disconnected', {
        clean: ev.detail?.clean,
        code: this._closeCode ?? null,
        reason: this._closeReason || null,
        httpStatus: this._httpStatus || null,
        livedMs: this._connectedAt ? Date.now() - this._connectedAt : null,
      });
    });
    rfb.addEventListener('credentialsrequired', async () => {
      // x11vnc asks for the VNC password; use ours (from the app config).
      const pw = this.credentials.password ?? (await this.callbacks.onNeedPassword());
      if (pw) {
        this.credentials = { password: pw };
        rfb.sendCredentials({ password: pw });
      } else {
        this.callbacks.onError('authentication');
      }
    });
    rfb.addEventListener('securityfailure', (ev) => {
      this.callbacks.onError('security', ev.detail?.reason || 'authentication failed');
    });
    rfb.addEventListener('desktopname', (ev) => this.callbacks.onDesktopName(ev.detail.name));
    rfb.addEventListener('clipboard', (ev) => this.callbacks.onClipboard(ev.detail.text));
    rfb.addEventListener('bell', () => this.callbacks.onBell());
    return rfb;
  }

  /** Attach diagnostics listeners to the underlying WebSocket. */
  _watchSocket(ws) {
    try {
      ws.addEventListener('close', (ev) => {
        this._closeCode = ev.code;
        this._closeReason = ev.reason || '';
      });
      ws.addEventListener('error', () => {
        this._closeReason = this._closeReason || 'socket error';
      });
      // Non-101 handshake responses are reported by noVNC as a failure; the
      // status lives on the WebSocket object in some browsers.
      this._ws = ws;
    } catch { /* older browsers */ }
  }

  disconnect() {
    this._detachInput();
    this._releaseEverything();
    if (this.rfb) {
      try {
        this.rfb.disconnect();
      } catch { /* already gone */ }
      this.rfb = null;
    }
    this.connected = false;
  }

  _applyQualityFromStorage() {
    const q = localStorage.getItem('quality') || 'balanced';
    this.setQuality(q);
  }

  setQuality(name) {
    const table = { sharp: [8, 1], balanced: [6, 2], fast: [3, 7] };
    const [q, c] = table[name] || table.balanced;
    if (this.rfb) {
      this.rfb.qualityLevel = q;
      this.rfb.compressionLevel = c;
    }
    localStorage.setItem('quality', name);
  }

  setViewOnly(value) {
    this.viewOnly = Boolean(value);
    if (this.rfb) this.rfb.viewOnly = this.viewOnly;
  }

  /* ── input plumbing ────────────────────────────────────────────── */

  _attachInput() {
    if (this.input) return;
    this.input = new InputLayer(this);
    const stage = this.stage;
    stage.addEventListener('pointerdown', this._bound.down, { passive: false });
    stage.addEventListener('pointermove', this._bound.move, { passive: false });
    stage.addEventListener('pointerup', this._bound.up, { passive: false });
    stage.addEventListener('pointercancel', this._bound.cancel, { passive: false });
    // Keep real mouse/wheel events away from noVNC: everything goes through our
    // synthetic path so nothing is applied twice.
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      stage.addEventListener(type, this._bound.blocker, { capture: true, passive: false });
    }
    window.addEventListener('keydown', this._bound.keydown);
    window.addEventListener('keyup', this._bound.keyup);
    window.addEventListener('resize', this._bound.resize);
    this._active = true;
  }

  _detachInput() {
    const stage = this.stage;
    stage.removeEventListener('pointerdown', this._bound.down, { passive: false });
    stage.removeEventListener('pointermove', this._bound.move, { passive: false });
    stage.removeEventListener('pointerup', this._bound.up, { passive: false });
    stage.removeEventListener('pointercancel', this._bound.cancel, { passive: false });
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      stage.removeEventListener(type, this._bound.blocker, { capture: true, passive: false });
    }
    window.removeEventListener('keydown', this._bound.keydown);
    window.removeEventListener('keyup', this._bound.keyup);
    window.removeEventListener('resize', this._bound.resize);
    this.input = null;
    this._active = false;
  }

  /**
   * Block *trusted* mouse/wheel events from reaching noVNC's own handlers, so
   * that input is applied exactly once (through our synthetic events).
   *
   * Only trusted events are blocked: the synthetic events we dispatch carry
   * isTrusted === false and must travel on to noVNC's canvas listeners.
   */
  _blockRealEvents(ev) {
    if (!this._active) return;
    if (!ev.isTrusted) return; // ours — let it through
    // let overlays (status/retry, sheets, menus, toolbars) work normally
    if (ev.target && ev.target.closest && ev.target.closest('.overlay-center, .sheet, .menu, .remote-dock, .topbar')) return;
    ev.stopPropagation();
    ev.preventDefault();
  }

  /* ── low level event synthesis ─────────────────────────────────── */

  _synthMouse(type, x, y, buttons, releasedButton = 0) {
    const canvas = this.canvas;
    if (!canvas || this.viewOnly) return;
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      buttons,
      button: type === 'mouseup' ? releasedButton : type === 'contextmenu' ? 2 : buttons & BTN.right ? 2 : buttons & BTN.middle ? 1 : 0,
    }));
  }

  mouseDown(button, x, y) {
    this.lastPointer = {x,y};
    this._synthMouse('mousedown', x, y, BTN[button] ?? 1);
  }

  mouseUp(button, x, y) {
    this._synthMouse('mouseup', x, y, 0, button === 'right' ? 2 : button === 'middle' ? 1 : 0);
  }

  mouseMove(x, y, buttons = 0) {
    this.lastPointer = {x,y};
    this._synthMouse('mousemove', x, y, buttons);
  }

  click(button, x, y) {
    this.mouseDown(button, x, y);
    this.mouseUp(button, x, y);
  }

  wheel(dx, dy, x, y) {
    const canvas = this.canvas;
    if (!canvas || this.viewOnly) return;
    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0,
      buttons: 0,
    }));
  }

  /* ── keyboard ──────────────────────────────────────────────────── */

  sendKey(keysym, code, down) {
    if (!this.rfb || !this.connected || this.viewOnly) return;
    this.rfb.sendKey(keysym, code, down);
  }

  /** Press and release a key by DOM code (used by the modifier/key chip row). */
  pressKey(code) {
    const keysym = KEYSYMS[code];
    if (keysym === undefined) return;
    if (code === 'PrintScreen') {
      // many desktops need the modifier dance for PrtSc
      this.sendKey(KEYSYMS.PrintScreen, 'PrintScreen', true);
      this.sendKey(KEYSYMS.PrintScreen, 'PrintScreen', false);
      return;
    }
    this.sendKey(keysym, code, true);
    this.sendKey(keysym, code, false);
    this.releaseModifiers(true);
  }

  toggleModifier(code) {
    if (!KEYSYMS[code]) return false;
    if (this.modifiers.has(code)) {
      this.sendKey(KEYSYMS[code], code, false);
      this.modifiers.delete(code);
      return false;
    }
    this.sendKey(KEYSYMS[code], code, true);
    this.modifiers.add(code);
    return true;
  }

  /** One-shot behaviour: modifiers release themselves after the next key. */
  releaseModifiers(force = false) {
    if (!this.modifiers.size) return;
    for (const code of [...this.modifiers]) {
      this.sendKey(KEYSYMS[code], code, false);
      this.modifiers.delete(code);
    }
  }

  ctrlAltDel() {
    if (this.rfb && this.connected) this.rfb.sendCtrlAltDel();
  }

  /** Type a single character, handling shift for capitals and symbols. */
  typeChar(ch) {
    if (!ch) return;
    const isLetter = /[a-zA-Z]/.test(ch);
    const code = ch.codePointAt(0);
    let keysym = code;
    let shift = false;
    if (isLetter) {
      keysym = ch.toLowerCase().codePointAt(0);
      shift = ch === ch.toUpperCase();
    } else if (SHIFTED.has(ch)) {
      shift = true;
    } else if (code > 0xff) {
      keysym = 0x01000000 + code; // Unicode keysym range
    }
    const ownShift = shift && !this.modifiers.has('ShiftLeft') && !this.modifiers.has('ShiftRight');
    if (ownShift) this.sendKey(KEYSYMS.ShiftLeft, 'ShiftLeft', true);
    this.sendKey(keysym, undefined, true);
    this.sendKey(keysym, undefined, false);
    if (ownShift) this.sendKey(KEYSYMS.ShiftLeft, 'ShiftLeft', false);
    if (this.modifiers.size) this.releaseModifiers();
  }

  typeText(text) {
    for (const ch of String(text)) {
      if (ch === '\n') this.pressKey('Enter');
      else if (ch === '\t') this.pressKey('Tab');
      else this.typeChar(ch);
    }
  }

  sendClipboard(text) {
    if (this.rfb && this.connected) this.rfb.clipboardPasteFrom(String(text));
  }

  _releaseEverything() {
    this.releaseModifiers();
    for (const [code, keysym] of this._heldKeys) this.sendKey(keysym, code, false);
    this._heldKeys.clear();
    if (this.input) this.input.reset();
  }

  _onKeyDown(ev) {
    if (!this._active || this.viewOnly) return;
    const target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (ev.metaKey && ev.code === 'Tab') return; // don't hijack OS/browser tab switching

    const printable = ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey;
    if (this._heldKeys.has(ev.code)) {
      // auto-repeat: forward as an extra press
      const keysym = this._heldKeys.get(ev.code);
      this.sendKey(keysym, ev.code, true);
      this.sendKey(keysym, ev.code, false);
      ev.preventDefault();
      return;
    }
    if (MODIFIER_CODES.has(ev.code) || KEYSYMS[ev.code] !== undefined) {
      const keysym = KEYSYMS[ev.code];
      this.sendKey(keysym, ev.code, true);
      this._heldKeys.set(ev.code, keysym);
      ev.preventDefault();
      return;
    }
    if (printable) {
      this.typeChar(ev.key);
      ev.preventDefault();
    }
  }

  _onKeyUp(ev) {
    if (!this._active) return;
    if (this._heldKeys.has(ev.code)) {
      this.sendKey(this._heldKeys.get(ev.code), ev.code, false);
      this._heldKeys.delete(ev.code);
    }
  }

  /* ── view: zoom + pan ──────────────────────────────────────────── */

  /** CSS pixels per remote pixel at the current fit scale. */
  fitScale() {
    const canvas = this.canvas;
    if (!canvas || !this.rfb?._display?.width) return 1;
    const rect = canvas.getBoundingClientRect();
    const zoom = this.factor || 1;
    return rect.width / this.rfb._display.width / zoom;
  }

  setZoom(mode, focus) {
    this.zoomMode = mode;
    let target = 1;
    if (mode === '1') target = 1 / (this.fitScale() || 1);
    if (mode === '2') target = 2 / (this.fitScale() || 1);
    target = clamp(target, 1, 8);
    const rect = this.stage.getBoundingClientRect();
    const fx = focus?.x ?? rect.width / 2;
    const fy = focus?.y ?? rect.height / 2;
    const ratio = target / (this.factor || 1);
    this.tx = fx - (fx - this.tx) * ratio;
    this.ty = fy - (fy - this.ty) * ratio;
    this.factor = target;
    this._applyTransform();
  }

  setFactor(factor, focus) {
    const target = clamp(factor, 1, 8);
    const ratio = target / (this.factor || 1);
    const fx = focus?.x ?? 0;
    const fy = focus?.y ?? 0;
    this.tx = fx - (fx - this.tx) * ratio;
    this.ty = fy - (fy - this.ty) * ratio;
    this.factor = target;
    this.zoomMode = target <= 1.02 ? 'fit' : 'zoom';
    this._applyTransform();
  }

  panBy(dx, dy) {
    this.tx += dx;
    this.ty += dy;
    this._applyTransform();
  }

  _clampPan() {
    const stage = this.stage.getBoundingClientRect();
    const minX = stage.width * (1 - this.factor);
    const minY = stage.height * (1 - this.factor);
    this.tx = clamp(this.tx, minX, 0);
    this.ty = clamp(this.ty, minY, 0);
    this._applyTransform();
  }

  _applyTransform() {
    this._clampPanValues();
    if (this.factor <= 1.001) {
      this.wrap.style.transform = '';
    } else {
      this.wrap.style.transform = `translate3d(${Math.round(this.tx)}px, ${Math.round(this.ty)}px, 0) scale(${this.factor.toFixed(4)})`;
    }
    this.callbacks.onViewChange({ zoom: this.zoomMode, factor: this.factor });
  }

  _clampPanValues() {
    const stage = this.stage.getBoundingClientRect();
    const minX = Math.min(0, stage.width * (1 - this.factor));
    const minY = Math.min(0, stage.height * (1 - this.factor));
    this.tx = clamp(this.tx, minX, 0);
    this.ty = clamp(this.ty, minY, 0);
  }

  resetView() {
    this.factor = 1;
    this.tx = 0;
    this.ty = 0;
    this.zoomMode = 'fit';
    this._applyTransform();
  }

  /* ── pointer routing (delegates to InputLayer) ─────────────────── */

  _onPointerDown(ev) {
    if (!this.input) return;
    if (ev.target && ev.target.closest && ev.target.closest('.overlay-center, .sheet, .menu, .remote-dock, .topbar')) return;
    this.input.down(ev);
  }

  _onPointerMove(ev) {
    if (!this.input) return;
    this.input.move(ev);
  }

  _onPointerUp(ev, cancelled = false) {
    if (!this.input) return;
    this.input.up(ev, cancelled);
  }
}

/* ------------------------------------------------------------------ *
 * InputLayer — gesture → mouse/key mapping
 * ------------------------------------------------------------------ */

const LONG_PRESS_MS = 480;
const TAP_MS = 260;
const TAP_SLOP = 9;
const TRACKPAD_SPEED = 1.35;
const SCROLL_GAIN = 1.8;

export class InputLayer {
  constructor(session) {
    this.s = session;
    this.pointers = new Map();
    this.mode = localStorage.getItem('inputMode') || 'touch';
    this.cursor = { x: 0, y: 0 };
    this.leftDown = false;
    this.longFired = false;
    this.two = null;
    this.pendingRight = false;
    this.acc = { x: 0, y: 0 };
    this.longTimer = null;
  }

  reset() {
    this.clearLongPress();
    for (const p of this.pointers.values()) p.dead = true;
    this.pointers.clear();
    if (this.leftDown) {
      this.s.mouseUp('left', this.cursor.x, this.cursor.y);
      this.leftDown = false;
    }
    this.two = null;
    this.pendingRight = false;
  }

  setMode(mode) {
    this.reset();
    this.mode = mode;
    localStorage.setItem('inputMode', mode);
    if (mode !== 'touch') {
      // park the virtual cursor in the middle of the visible area
      const rect = this.s.stage.getBoundingClientRect();
      this.cursor = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }

  cycleMode() {
    const order = ['touch', 'trackpad', 'scroll'];
    const next = order[(order.indexOf(this.mode) + 1) % order.length];
    this.setMode(next);
    return next;
  }

  clearLongPress() {
    if (this.longTimer) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
  }

  /* ── pointer events ───────────────────────────────────────────── */

  down(ev) {
    ev.preventDefault();
    const rect = this.s.stage.getBoundingClientRect();
    // A browser occasionally drops a pointerup (backgrounded tab, palm touch,
    // OS gesture takeover). Treat very old pointers as gone so a new touch is
    // always a clean single-finger gesture.
    for (const [id, other] of this.pointers) {
      if (Date.now() - other.t > 2500) {
        this.pointers.delete(id);
        if (this.leftDown) {
          this.s.mouseUp('left', this.cursor.x, this.cursor.y);
          this.leftDown = false;
        }
      }
    }
    const p = {
      id: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      sx: ev.clientX,
      sy: ev.clientY,
      lx: ev.clientX,
      ly: ev.clientY,
      t: Date.now(),
      moved: false,
      dead: false,
    };
    this.pointers.set(ev.pointerId, p);

    if (this.pointers.size === 1) {
      this.longFired = false;
      this.pendingRight = false;
      if (this.mode === 'touch') {
        this.setCursor(p.x, p.y);
        this.s.mouseDown('left', p.x, p.y);
        this.leftDown = true;
        this.armLongPress(p);
      } else {
        if (this.mode === 'trackpad') {
          // keep the virtual cursor where the last gesture left it
          this.cursor.x = clamp(this.cursor.x, rect.left, rect.right);
          this.cursor.y = clamp(this.cursor.y, rect.top, rect.bottom);
          this.armLongPress(p, true);
        }
      }
    } else if (this.pointers.size === 2) {
      this.clearLongPress();
      if (this.leftDown) {
        this.s.mouseUp('left', this.cursor.x, this.cursor.y);
        this.leftDown = false;
      }
      this.startTwo(p);
    }
  }

  move(ev) {
    const p = this.pointers.get(ev.pointerId);
    if (!p) return;
    ev.preventDefault();
    const dx = ev.clientX - p.lx;
    const dy = ev.clientY - p.ly;
    p.lx = ev.clientX;
    p.ly = ev.clientY;

    if (!p.moved && Math.hypot(ev.clientX - p.sx, ev.clientY - p.sy) > TAP_SLOP) {
      p.moved = true;
      this.clearLongPress();
    }

    if (this.pointers.size === 1) {
      if (this.mode === 'touch') {
        p.x = ev.clientX;
        p.y = ev.clientY;
        this.setCursor(ev.clientX, ev.clientY);
        this.s.mouseMove(ev.clientX, ev.clientY, this.leftDown ? BTN.left : 0);
      } else if (this.mode === 'trackpad') {
        this.moveCursorBy(dx * TRACKPAD_SPEED, dy * TRACKPAD_SPEED);
        this.s.mouseMove(this.cursor.x, this.cursor.y, this.leftDown ? BTN.left : 0);
      } else if (this.mode === 'scroll') {
        this.scrollBy(dx * SCROLL_GAIN, dy * SCROLL_GAIN, this.cursor.x, this.cursor.y);
      }
    } else if (this.pointers.size >= 2) {
      this.twoMove();
    }
  }

  up(ev, cancelled = false) {
    const p = this.pointers.get(ev.pointerId);
    if (!p) return;
    const wasTwo = this.pointers.size >= 2;
    const quick = !p.moved && Date.now() - p.t < TAP_MS;
    this.pointers.delete(ev.pointerId);

    if (this.pointers.size === 0) {
      this.clearLongPress();
      if (this.mode === 'touch') {
        if (this.leftDown) {
          this.s.mouseUp('left', p.x, p.y);
          this.leftDown = false;
        } else if (quick && !cancelled && !this.longFired && !this.pendingRight) {
          // Safety net: make sure a genuine tap always registers a click even
          // if the browser never delivered the matching pointerdown.
          this.s.click('left', p.x, p.y);
        }
      } else if (this.mode === 'trackpad' && quick && !cancelled && !this.pendingRight && !this.longFired) {
        this.s.click('left', this.cursor.x, this.cursor.y);
      }
      if (this.pendingRight && !cancelled) {
        this.s.click('right', this.cursor.x, this.cursor.y);
      }
      this.pendingRight = false;
      this.two = null;
      this.longFired = false;
      this.acc = { x: 0, y: 0 };
      return;
    }

    if (wasTwo && this.pointers.size === 1) {
      const two = this.two;
      // two-finger tap → right click
      if (two && two.quick && quick && !two.pinch && !cancelled) this.pendingRight = true;
      this.two = null;
    }
  }

  /* ── helpers ──────────────────────────────────────────────────── */

  setCursor(x, y) {
    this.cursor.x = x;
    this.cursor.y = y;
  }

  moveCursorBy(dx, dy) {
    const rect = this.s.stage.getBoundingClientRect();
    this.cursor.x = clamp(this.cursor.x + dx, rect.left, rect.right);
    this.cursor.y = clamp(this.cursor.y + dy, rect.top, rect.bottom);
  }

  armLongPress(p, rightAtCursor = false) {
    this.clearLongPress();
    this.longTimer = setTimeout(() => {
      const cur = this.pointers.get(p.id);
      if (!cur || cur.moved || this.pointers.size !== 1) return;
      this.longFired = true;
      if (this.leftDown) {
        this.s.mouseUp('left', this.cursor.x, this.cursor.y);
        this.leftDown = false;
      }
      const x = rightAtCursor ? this.cursor.x : p.x;
      const y = rightAtCursor ? this.cursor.y : p.y;
      this.s.click('right', x, y);
    }, LONG_PRESS_MS);
  }

  startTwo(p) {
    const [a, b] = [...this.pointers.values()];
    this.two = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      lastDist: 0,
      lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startTime: Date.now(),
      travelled: 0,
      pinch: false,
      quick: true,
      baseFactor: this.s.factor,
    };
    this.two.lastDist = this.two.startDist;
  }

  twoMove() {
    if (!this.two) return;
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dMidX = mid.x - this.two.lastMid.x;
    const dMidY = mid.y - this.two.lastMid.y;
    const dDist = dist - this.two.lastDist;

    this.two.travelled += Math.abs(dMidX) + Math.abs(dMidY) + Math.abs(dDist);
    if (this.two.travelled > 12) this.two.quick = false;

    if (this.two.pinch || Math.abs(dist - this.two.startDist) > 22) {
      this.two.pinch = true;
      const factor = this.two.baseFactor * (dist / this.two.startDist);
      this.s.setFactor(factor, mid);
    } else if (this.s.factor > 1.02) {
      this.s.panBy(dMidX, dMidY);
      this.setCursor(mid.x, mid.y);
    } else {
      this.scrollBy(dMidX * SCROLL_GAIN, dMidY * SCROLL_GAIN, mid.x, mid.y);
      this.setCursor(mid.x, mid.y);
    }

    this.two.lastDist = dist;
    this.two.lastMid = mid;
  }

  scrollBy(dx, dy, x, y) {
    this.acc.x += dx;
    this.acc.y += dy;
    if (Math.abs(this.acc.x) < 6 && Math.abs(this.acc.y) < 6) return;
    this.s.wheel(this.acc.x, this.acc.y, x, y);
    this.acc = { x: 0, y: 0 };
  }
}

export { BTN, KEYSYMS, WHEEL_STEP };
