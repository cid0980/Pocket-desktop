/* Shared controller utilities. No network or third-party dependencies. */
export async function fullscreen(toast) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else throw Error('Fullscreen is unsupported here. Try your browser menu or install the app on a trusted HTTPS connection.');
  } catch (e) { toast(e.message || 'Fullscreen was blocked by this browser.', 'err', 7000); }
}
document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll('[data-fullscreen]').forEach(b => {
    b.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    b.setAttribute('aria-pressed', String(!!document.fullscreenElement));
  });
});

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

export class LayoutEditor {
  constructor(pages, toast) {
    this.pages = pages; this.toast = toast; this.key = 'pd-layouts-v1'; this.saved = this.empty();
    this.nodes = {};
    for (const [page, root] of Object.entries(pages)) {
      this.nodes[page] = {};
      root.querySelectorAll('[data-layout]').forEach(el => { this.nodes[page][el.dataset.layout] = el; });
      root.addEventListener('pointerdown', e => this.down(e,page), true);
      root.addEventListener('pointermove', e => this.move(e), true);
      for (const event of ['pointerup','pointercancel']) root.addEventListener(event, e => {
        if (!this.editing) return; e.stopImmediatePropagation(); e.preventDefault(); this.drag = null;
      }, true);
      root.addEventListener('click', e => { if (this.editing && e.target.closest('[data-layout]')) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    }
    try { const raw = localStorage.getItem(this.key); if (raw) this.saved = this.validate(JSON.parse(raw)); }
    catch { toast('Saved layouts were unreadable or outdated; using defaults.'); }
    this.draft = structuredClone(this.saved);
    this.panel = document.createElement('div'); this.panel.className = 'layout-editor'; this.panel.hidden = true;
    this.panel.innerHTML = '<strong tabindex="0">Layout editor · drag this heading to move toolbar</strong><div><button data-op="save">Save</button><button data-op="cancel">Cancel</button><button data-op="reset">Reset page</button><button data-op="all">Reset all</button><button data-op="export">Export JSON</button><button data-op="import">Import JSON</button></div><input type="file" accept="application/json,.json" hidden><p role="status">Changes are not saved yet.</p>';
    document.body.append(this.panel);
    const heading=this.panel.querySelector('strong'); let toolbarDrag=null;
    heading.style.touchAction='none'; heading.style.cursor='move';
    heading.addEventListener('pointerdown',e=>{ const r=this.panel.getBoundingClientRect(); toolbarDrag={x:e.clientX-r.left,y:e.clientY-r.top}; heading.setPointerCapture(e.pointerId); e.preventDefault(); });
    heading.addEventListener('pointermove',e=>{ if(!toolbarDrag)return; Object.assign(this.panel.style,{transform:'none',left:Math.max(0,Math.min(innerWidth-this.panel.offsetWidth,e.clientX-toolbarDrag.x))+'px',top:Math.max(0,Math.min(innerHeight-this.panel.offsetHeight,e.clientY-toolbarDrag.y))+'px'}); });
    for(const event of ['pointerup','pointercancel'])heading.addEventListener(event,()=>toolbarDrag=null);

    this.panel.addEventListener('click', e => this.action(e.target.dataset.op));
    this.panel.querySelector('input').addEventListener('change', async e => {
      try {
        const file=e.target.files[0]; if (!file) return;
        if(file.size>100000) throw Error('File too large');
        const valid=this.validate(JSON.parse(await file.text()));
        if (!confirm('Replace layout drafts for all pages with this file? Click Save to persist.')) return;
        this.draft=valid; this.apply(); this.message('Imported and validated. Click Save to keep these layouts.');
      } catch(err) { this.message('Import rejected: '+err.message); }
      e.target.value='';
    });
    this.resize = () => this.apply(); window.addEventListener('resize',this.resize);
    window.visualViewport?.addEventListener('resize',this.resize);
    this.apply();
  }
  empty() { return {version:1,pages:{remote:{},pad:{},mouse:{}}}; }
  validate(value) {
    if (!value || value.version!==1 || !value.pages || Object.keys(value.pages).length!==3) throw Error('Expected layout version 1 with remote, pad and mouse pages');
    const out=this.empty();
    for(const page of Object.keys(out.pages)) {
      const entries=value.pages[page];
      if(!entries || typeof entries!=='object' || Array.isArray(entries)) throw Error('Invalid page '+page);
      for(const [id,pos] of Object.entries(entries)) {
        if(!Object.hasOwn(this.nodes[page],id) || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x<0 || pos.x>1 || pos.y<0 || pos.y>1) throw Error('Invalid control position: '+id);
        out.pages[page][id]={x:pos.x,y:pos.y};
      }
    } return out;
  }
  begin(page) {
    this.page=page; this.editing=true; this.draft=structuredClone(this.saved);
    this.panel.hidden=false; this.pages[page].classList.add('layout-editing'); this.message('Changes are not saved yet.');
  }
  message(text) { this.panel.querySelector('p').textContent=text; }
  down(e,page) {
    if(!this.editing || page!==this.page) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const el=e.target.closest('[data-layout]'); if(!el) return;
    const r=el.getBoundingClientRect(); this.drag={el,page,id:el.dataset.layout,pointer:e.pointerId,ox:e.clientX-r.left,oy:e.clientY-r.top};
    el.setPointerCapture(e.pointerId);
  }
  move(e) {
    const d=this.drag; if(!d || e.pointerId!==d.pointer) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const w=innerWidth-d.el.offsetWidth-16,h=innerHeight-d.el.offsetHeight-16;
    this.draft.pages[d.page][d.id]={x:Math.max(0,Math.min(1,(e.clientX-d.ox-8)/Math.max(1,w))),y:Math.max(0,Math.min(1,(e.clientY-d.oy-8)/Math.max(1,h)))};
    this.apply(); this.message('Unsaved changes');
  }
  apply() {
    for(const [page,nodes] of Object.entries(this.nodes)) {
      for(const el of Object.values(nodes)) for(const prop of ['position','left','top','right','bottom','transform','z-index','margin','width','height']) el.style.removeProperty(prop);
      if(this.pages[page].hidden) continue;
      const sizes=Object.fromEntries(Object.entries(nodes).map(([id,el])=>[id,el.getBoundingClientRect()]));
      for(const [id,el] of Object.entries(nodes)) {
        const pos=this.draft.pages[page][id]; if(!pos) continue;
        const size=sizes[id];
        const width=Math.min(size.width,innerWidth-16),height=Math.min(size.height,innerHeight-16);
        Object.assign(el.style,{width:width+'px',height:height+'px',position:'fixed',right:'auto',bottom:'auto',transform:'none',margin:'0',zIndex:'12',left:(8+pos.x*Math.max(0,innerWidth-width-16))+'px',top:(8+pos.y*Math.max(0,innerHeight-height-16))+'px'});
      }
    }
  }
  action(op) {
    if(op==='reset') { this.draft.pages[this.page]={}; this.apply(); this.message('Page reset. Click Save to keep.'); }
    if(op==='all' && confirm('Reset layouts on all three pages?')) { this.draft=this.empty(); this.apply(); this.message('All reset. Click Save to keep.'); }
    if(op==='save') {
      try { const valid=this.validate(this.draft); localStorage.setItem(this.key,JSON.stringify(valid)); this.saved=valid; this.toast('Layouts saved on this browser'); this.finish(); }
      catch(e) { this.message('Could not save: '+e.message); }
    }
    if(op==='cancel') { this.draft=structuredClone(this.saved); this.apply(); this.finish(); }
    if(op==='import') this.panel.querySelector('input').click();
    if(op==='export') {
      const url=URL.createObjectURL(new Blob([JSON.stringify(this.draft,null,2)],{type:'application/json'}));
      const a=document.createElement('a'); a.href=url; a.download='pocket-desktop-layouts.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      this.message('Exported current layout draft.');
    }
  }
  finish() { this.editing=false; this.drag=null; this.panel.hidden=true; Object.values(this.pages).forEach(r=>r.classList.remove('layout-editing')); }
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

export function bindTouchpad(el,send,signal) {
  const points=new Map();
  el.addEventListener('pointerdown',e=>{el.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY});e.preventDefault();},{signal});
  el.addEventListener('pointermove',e=>{
    const p=points.get(e.pointerId);if(!p)return;
    const dx=e.clientX-p.x,dy=e.clientY-p.y; points.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(points.size===1) send({t:'ptr',dx:Math.round(dx*1.5),dy:Math.round(dy*1.5)});
    else if(dy) send({t:'wheel',d:Math.sign(-dy)});
    e.preventDefault();
  },{signal});
  for(const event of ['pointerup','pointercancel','lostpointercapture']) el.addEventListener(event,e=>points.delete(e.pointerId),{signal});
  el.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',d:Math.sign(-e.deltaY)});},{signal,passive:false});
  el.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
}
