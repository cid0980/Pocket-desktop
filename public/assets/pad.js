import { MotionPointer, bindMouseButton } from './controls.js';
let bindingSignal;
function listen(target, type, fn) { target?.addEventListener(type, fn, {signal: bindingSignal}); }
'use strict';
/**
 * Gamepad screen — a full-screen controller for the phone.
 *
 * Left stick moves, right stick looks, face buttons and triggers are real Xbox
 * buttons, so Genshin / Honkai: Star Rail / Wuthering Waves see an ordinary
 * controller and use their own mapping.
 *
 * Motion mode turns the phone into an air mouse with big left/right buttons.
 */

const PAD_DEFAULTS = {
  sensitivity: 1,
  deadzone: 0.12,
  motionSensitivity: 1,
  invertY: false,
  haptics: true,
  swapSticks: false,
};

/** Analog stick: touch anywhere in the zone and the stick appears under you. */
class Stick {
  constructor(zone, { onChange, radius = 62, label = '' }) {
    this.zone = zone;
    this.radius = radius;
    this.onChange = onChange;
    this.active = false;
    this.originX = 0;
    this.originY = 0;
    this.x = 0;
    this.y = 0;
    this.pointerId = null;

    this.knob = document.createElement('div');
    this.knob.className = 'pad-stick';
    this.knob.innerHTML = `<span class="pad-stick-ring"></span><span class="pad-stick-knob"></span>`;
    zone.appendChild(this.knob);
    if (label) {
      const tag = document.createElement('span');
      tag.className = 'pad-zone-label';
      tag.textContent = label;
      zone.appendChild(tag);
    }

    listen(zone, 'pointerdown', (e) => this.down(e));
    listen(zone, 'pointermove', (e) => this.move(e));
    listen(zone, 'pointerup', (e) => this.up(e));
    listen(zone, 'pointercancel', (e) => this.up(e));
    listen(zone, 'pointerleave', (e) => this.up(e));
  }

  down(e) {
    if (this.active) return;
    this.active = true;
    this.pointerId = e.pointerId;
    const rect = this.zone.getBoundingClientRect();
    this.originX = e.clientX;
    this.originY = e.clientY;
    this.knob.style.left = `${e.clientX - rect.left}px`;
    this.knob.style.top = `${e.clientY - rect.top}px`;
    this.knob.classList.add('on');
    try { this.zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  }

  move(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.originX;
    const dy = e.clientY - this.originY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, this.radius) || 0;
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * clamped;
    const ky = Math.sin(angle) * clamped;
    this.x = clamped ? (Math.cos(angle) * (clamped / this.radius)) : 0;
    this.y = clamped ? (Math.sin(angle) * (clamped / this.radius)) : 0;
    this.knob.style.setProperty('--kx', `${kx}px`);
    this.knob.style.setProperty('--ky', `${ky}px`);
    this.onChange(this.x, this.y);
    e.preventDefault();
  }

  up(e) {
    if (!this.active || (e && e.pointerId !== this.pointerId)) return;
    this.active = false;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.knob.classList.remove('on');
    this.knob.style.setProperty('--kx', '0px');
    this.knob.style.setProperty('--ky', '0px');
    this.onChange(0, 0);
  }
}

/** A press-and-hold button (face buttons, triggers, d-pad). */
class PadButton {
  constructor(el, name, { onPress, onRelease, haptics = true }) {
    this.el = el;
    this.name = name;
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.haptics = haptics;
    this.down = false;
    this.pointerId = null;

    listen(el, 'pointerdown', (e) => this.press(e));
    listen(el, 'pointerup', (e) => this.release(e));
    listen(el, 'pointercancel', (e) => this.release(e));
    listen(el, 'pointerleave', (e) => this.release(e));
    listen(el, 'contextmenu', (e) => e.preventDefault());
  }

  press(e) {
    if (this.down) return;
    this.down = true;
    this.pointerId = e.pointerId;
    this.el.classList.add('down');
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.haptics && navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
    this.onPress(this.name);
    e.preventDefault();
  }

  release(e) {
    if (!this.down) return;
    if (e && this.pointerId !== null && e.pointerId !== this.pointerId) return;
    this.down = false;
    this.pointerId = null;
    this.el.classList.remove('down');
    this.onRelease(this.name);
  }
}

/** D-pad: one element, four directions, read from the touch offset. */
class DPad {
  constructor(el, onChange) {
    this.el = el;
    this.onChange = onChange;
    this.state = { dx: 0, dy: 0 };
    this.pointerId = null;

    listen(el, 'pointerdown', (e) => {
      this.pointerId = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.update(e);
      e.preventDefault();
    });
    listen(el, 'pointermove', (e) => {
      if (this.pointerId === e.pointerId) this.update(e);
    });
    const clear = (e) => {
      if (e && this.pointerId !== null && e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.set(0, 0);
    };
    listen(el, 'pointerup', clear);
    listen(el, 'pointercancel', clear);
    listen(el, 'pointerleave', clear);
  }

  update(e) {
    const rect = this.el.getBoundingClientRect();
    const nx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const ny = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    const threshold = 0.32;
    this.set(Math.abs(nx) > threshold ? Math.sign(nx) : 0,
      Math.abs(ny) > threshold ? Math.sign(ny) : 0);
  }

  set(dx, dy) {
    if (this.state.dx === dx && this.state.dy === dy) return;
    this.state = { dx, dy };
    this.el.dataset.dir = `${dx},${dy}`;
    this.onChange(dx, dy);
  }
}

/**
 * The gamepad screen.
 * Sends one JSON frame per animation tick through the control socket.
 */
class GamepadScreen {
  constructor({ socket, settings, onExit, onToast }) {
    this.socket = socket;
    this.settings = { ...PAD_DEFAULTS, ...(settings || {}) };
    this.onExit = onExit || (() => {});
    this.onToast = onToast || (() => {});

    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, dx: 0, dy: 0 };
    this.buttons = {};
    this.dirty = false;
    this.motion = { enabled: false, active: false, beta: null, gamma: null, raf: 0 };

    this.abort = new AbortController();
    bindingSignal = this.abort.signal;
    this.build();
    listen(window, 'blur', () => this.releaseAll());
    listen(document, 'visibilitychange', () => { if(document.hidden) this.releaseAll(); });
    bindingSignal = undefined;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  build() {
    const root = document.querySelector('#screen-pad');
    this.root = root;

    // Left stick = movement, right stick = camera.
    this.left = new Stick(root.querySelector('#pad-move'), {
      radius: 64, label: 'move',
      onChange: (x, y) => this.setAxis('lx', x, 'ly', y),
    });
    this.right = new Stick(root.querySelector('#pad-look'), {
      radius: 56, label: 'look',
      onChange: (x, y) => this.setAxis('rx', x, 'ry', y),
    });

    // Face buttons, triggers, sticks-as-buttons
    const press = (name) => { this.buttons[name] = 1; this.dirty = true; };
    const release = (name) => { this.buttons[name] = 0; this.dirty = true; };
    this.padButtons = [...root.querySelectorAll('[data-pad-btn]')].map((el) => new PadButton(
      el, el.dataset.padBtn,
      { onPress: press, onRelease: release, haptics: this.settings.haptics },
    ));

    // Axis protocol is 0..255, not normalized 0..1. Ordinary touches press
    // fully; pressure-capable pens use pressure, dragging upward feathers it.
    for (const el of root.querySelectorAll('[data-pad-trigger]')) {
      const axis = el.dataset.padTrigger;
      let pointer = null, startY = 0;
      listen(el, 'pointerdown', e => {
        if (pointer !== null) return;
        pointer = e.pointerId; startY = e.clientY;
        el.setPointerCapture(e.pointerId); el.classList.add('down');
        this.setTrigger(axis, e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1);
        e.preventDefault();
      });
      listen(el, 'pointermove', e => {
        if (e.pointerId !== pointer) return;
        this.setTrigger(axis, e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : Math.max(0, Math.min(1, 1+(e.clientY-startY)/100)));
      });
      const up = e => { if(e.pointerId !== pointer) return; pointer=null; el.classList.remove('down'); this.setTrigger(axis,0); };
      for(const event of ['pointerup','pointercancel','lostpointercapture']) listen(el,event,up);
    }

    this.dpad = new DPad(root.querySelector('#pad-dpad'), (dx, dy) => {
      this.setAxisRaw('dx', dx);
      this.setAxisRaw('dy', dy);
    });

    this.motionController = new MotionPointer(msg => this.socket.send(msg), (text, active) => {
      if(this.motionBtn) this.motionBtn.textContent = active ? 'Motion: on' : 'Motion: off';
      this.onToast(text, active ? '' : 'info', 8000);
    }, () => this.settings.motionSensitivity);
    // Motion mouse
    this.motionBtn = root.querySelector('#pad-motion-toggle');
    listen(this.motionBtn, 'click', () => this.toggleMotion());

    this.leftClick = root.querySelector('#pad-click-left');
    this.rightClick = root.querySelector('#pad-click-right');
    if (this.leftClick) this.bindClick(this.leftClick, 'left');
    if (this.rightClick) this.bindClick(this.rightClick, 'right');

    listen(root.querySelector('#pad-exit'), 'click', () => this.exit());
    listen(root.querySelector('#pad-settings'), 'click', () => {
      root.querySelector('#pad-panel')?.classList.toggle('open');
    });
    listen(root.querySelector('#pad-center'), 'click', () => this.recenter());

    const sens = root.querySelector('#pad-sens');
    if (sens) {
      sens.value = String(this.settings.motionSensitivity);
      listen(sens, 'input', () => {
        this.settings.motionSensitivity = Number(sens.value);
      });
    }
  }

  bindClick(el, which) {
    bindMouseButton(el, which, msg => this.socket.send(msg), this.abort.signal);
  }

  setTrigger(axis, amount) {
    this.setAxisRaw(axis, Math.round(Math.max(0, Math.min(1, amount)) * 255));
  }

  setAxisRaw(axis, value) {
    if (this.axes[axis] === value) return;
    this.axes[axis] = value;
    this.dirty = true;
  }

  /** Apply deadzone + sensitivity to a stick value (-1..1) → axis units. */
  setAxis(ax, x, ay, y) {
    const dead = this.settings.deadzone;
    const scale = (v) => {
      const mag = Math.hypot(x, y);
      if (mag < dead) return 0;
      const boosted = ((mag - dead) / (1 - dead)) / mag;
      return Math.max(-1, Math.min(1, v * boosted * this.settings.sensitivity));
    };
    this.setAxisRaw(ax, Math.round(scale(x) * 32767));
    this.setAxisRaw(ay, Math.round(scale(y) * 32767));
  }

  /* ---------------- motion (phone as mouse) ---------------- */

  toggleMotion() { return this.motionController.toggle(); }
  stopMotion() { this.motionController.stop(); }
  recenter() { this.motionController.recenter(); this.onToast('Aim re-centred'); }

  releaseAll() {
    this.left.up(); this.right.up(); this.dpad.set(0,0);
    this.padButtons.forEach(b => b.release());
    for(const axis of Object.keys(this.axes)) this.axes[axis]=0;
    for(const key of Object.keys(this.buttons)) this.buttons[key]=0;
    this.socket.send({t:'pad', a:{...this.axes}, b:{...this.buttons}});
    for(const b of ['left','right']) this.socket.send({t:'btn',b,d:0});
    this.root.querySelectorAll('.down').forEach(el=>el.classList.remove('down'));
    this.dirty=false;
  }

  /* ---------------- frame loop ---------------- */

  loop() {
    if (this.dirty) {
      // Send every axis, zeros included. Skipping the zero ones was a trap:
      // letting go of the stick never reached the PC, so it stayed deflected
      // and the character kept walking.
      const a = { ...this.axes };
      this.socket.send({ t: 'pad', a, b: this.buttons });
      this.dirty = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  exit() {
    this.releaseAll();
    this.stopMotion();
    this.abort.abort();
    this.root.querySelectorAll('.pad-stick,.pad-zone-label').forEach(el=>el.remove());
    cancelAnimationFrame(this.raf);
    // Let go of everything on the way out.
    const a = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, dx: 0, dy: 0 };
    const b = {};
    for (const k of Object.keys(this.buttons)) b[k] = 0;
    this.socket.send({ t: 'pad', a, b });
    this.onExit();
  }
}

window.PocketPad = { GamepadScreen, Stick, PadButton, DPad, PAD_DEFAULTS };
