#!/usr/bin/env node
/* Practical Chromium checks. Sensor events are simulated, never physical. */
const c=require('./cdp'); const fs=require('fs'); const path=require('path');
let passed=0,failed=0;
const check=(name,ok)=>{ console.log(`${ok?'PASS':'FAIL'} ${name}`); ok?passed++:failed++; };
(async()=>{
const browser=await c.launchBrowser(); const cdp=await c.CDP.connect(browser.version.webSocketDebuggerUrl); const {sessionId:s}=await c.newPage(cdp);
const ev=code=>c.evaluate(cdp,s,code); const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
const wait=code=>c.waitFor(cdp,s,code,{timeout:15000}); const errors=[];
cdp.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text),s);
const port=process.env.PORT||8765;
const viewport=async(w,h)=>cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true},s);
const box=selector=>ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
const touch=async(type,pt)=>c.sendTouch(cdp,s,type,pt?[pt]:[]);
try {
await viewport(390,844); await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},s);
await cdp.send('Page.navigate',{url:`http://127.0.0.1:${port}`},s);
await wait("!document.querySelector('#screen-login').hidden");
for(const d of '1234') {await click(`#pinpad [data-key="${d}"]`);await c.sleep(90);}
await wait("!document.querySelector('#screen-home').hidden");
await ev(`window.sent=[];const original=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{};return original.call(this,data)};`);
await click('#tile-pad'); await wait("!!document.querySelector('#pad-move .pad-stick')");
for(const [w,h] of [[390,844],[360,640],[844,390],[1024,768],[1440,900]]) {
 await viewport(w,h); await c.sleep(100);
 check(`gamepad fits ${w}x${h}`,await ev(`Array.from(document.querySelectorAll('#screen-pad button,#pad-move,#pad-look,#pad-dpad')).filter(el=>el.getBoundingClientRect().width).every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})`));
}
await viewport(390,844); await c.sleep(300); await c.screenshot(cdp,s,path.join(__dirname,'artifacts','49-pad-portrait.png')); await click('#pad-to-mouse'); await wait("!document.querySelector('#screen-mouse').hidden"); await c.sleep(500);
check('gamepad shortcut opens mouse pad',await ev("document.querySelector('#screen-pad').hidden"));
await ev('sent=[]'); let pt=await box('#mouse-surface'); await touch('touchStart',pt); await touch('touchMove',{x:pt.x+30,y:pt.y+20}); await touch('touchEnd');
check('touchpad moves without clicking',await ev("sent.some(m=>m.t==='ptr'&&m.dx>0)&&!sent.some(m=>m.t==='btn')"));
for(const side of ['left','right']) {
 await ev('sent=[]'); pt=await box('#mouse-'+side); await touch('touchStart',pt); await touch('touchEnd');
 check(`mouse ${side} down/up exactly once`,await ev(`sent.filter(m=>m.t==='btn'&&m.b==='${side}'&&m.d===1).length===1&&sent.filter(m=>m.t==='btn'&&m.b==='${side}'&&m.d===0).length===1`));
}
for(const page of ['mouse','pad','remote']) {
 if(page==='pad') {await click('#mouse-back');await wait("!!document.querySelector('#pad-move .pad-stick')");}
 if(page==='remote') {await click('#pad-exit');await ev('window.__pd.openRemote()');await wait("window.__pd.state.session?.connected");}
 const selector=page==='mouse'?'#mouse-left':page==='pad'?'#pad-look':'#remote-dock';
 if(page==='mouse'){await click('#mouse-settings');await click('[data-workspace="layout-mouse"]');}else await click(`[data-edit="${page}"]`); pt=await box(selector);
 await touch('touchStart',pt); await touch('touchMove',{x:pt.x+22,y:pt.y-30});await touch('touchEnd');
 check(page+' layout drag creates separate draft',await ev(`Object.keys(pocketLayouts.draft.pages.${page}).length>0`));
 await ev("pocketLayouts.action('save')");
 check(page+' layout saves locally',await ev(`Object.keys(JSON.parse(localStorage.getItem('pd-layouts-v1')).pages.${page}).length>0`));
 await click(`#screen-${page} [data-fullscreen]`);await c.sleep(150);
 check(page+' enters fullscreen',await ev("document.body.classList.contains('pd-immersive')"));
 await click(`#screen-${page} [data-fullscreen]`);await c.sleep(100);
 check(page+' exits fullscreen',await ev("!document.body.classList.contains('pd-immersive')"));
}
await click('[data-edit="remote"]');pt=await box('#remote-left');await touch('touchStart',pt);await touch('touchMove',{x:150,y:400});await touch('touchEnd');
check('remote click button moves independently in viewport',await ev("(()=>{const r=document.querySelector('#remote-left').getBoundingClientRect();return Math.abs(r.x+r.width/2-150)<3&&Math.abs(r.y+r.height/2-400)<3})()"));
await ev("pocketLayouts.action('save')");
check('layout JSON round trip',await ev(`JSON.stringify(pocketLayouts.validate(JSON.parse(JSON.stringify(pocketLayouts.saved))))===JSON.stringify(pocketLayouts.saved)`));
check('invalid versions / positions rejected without changing saved data',await ev(`(()=>{const before=JSON.stringify(pocketLayouts.saved);let rejected=0;for(const data of [{version:999,pages:{}},{version:1,pages:{pad:{'pad-lt':{x:2,y:0}},mouse:{},remote:{}}},null]){try{pocketLayouts.validate(data)}catch{rejected++}}return rejected===3&&before===JSON.stringify(pocketLayouts.saved)})()`));
// Actual export download event and actual file-input import with acceptance dialog.
await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(__dirname,'artifacts'),eventsEnabled:true});
await ev("pocketLayouts.begin('remote');pocketLayouts.action('export')");await c.sleep(200);
check('JSON export writes file',fs.existsSync(path.join(__dirname,'artifacts','pocket-desktop-layouts.json')));
cdp.on('Page.javascriptDialogOpening',()=>cdp.send('Page.handleJavaScriptDialog',{accept:true},s),s);
const importPath=path.join(__dirname,'artifacts','import-layout.json');fs.writeFileSync(importPath,JSON.stringify({version:1,pages:{pad:{'pad-lt':{x:.1,y:.2}},remote:{},mouse:{left:{x:.2,y:.4}}}}));
const dom=await cdp.send('DOM.getDocument',{},s); const input=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'.layout-editor input'},s);
await cdp.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[importPath]},s);await c.sleep(250);
check('file import accepted into draft only',await ev("pocketLayouts.draft.pages.mouse.left.x===.2&&pocketLayouts.saved.pages.mouse.left.x!==.2"));
fs.writeFileSync(importPath,'{broken json');await cdp.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[importPath]},s);await c.sleep(150);
check('malformed JSON rejected visibly',await ev("document.querySelector('.layout-editor p').textContent.startsWith('Import rejected')&&pocketLayouts.draft.pages.mouse.left.x===.2"));
await ev("pocketLayouts.action('save')");
await cdp.send('Page.reload',{},s);await wait("window.pocketLayouts && !document.querySelector('#screen-home').hidden");
check('layouts restored after reload',await ev("pocketLayouts.saved.pages.mouse.left.x===.2&&pocketLayouts.saved.pages.pad['pad-lt'].y===.2"));
await ev('window.__pd.openRemote()');await wait('window.__pd.state.session?.connected');
// Observe existing RFB pointer path, not a different control channel.
await ev(`window.rfbClicks=[];window.rfbMasks=[];const session=__pd.state.session;const rfb=session.rfb;const originalButton=rfb._handleMouseButton.bind(rfb);rfb._handleMouseButton=(x,y,mask)=>{rfbMasks.push(mask);originalButton(x,y,mask)};session.mouseMove(150,170);const originalClick=session.click.bind(session);session.click=(b,x,y)=>{rfbClicks.push({b,x,y});originalClick(b,x,y);}`);
await click('#remote-left'); await click('#remote-right');
check('remote clicks use last RFB pointer position',await ev("rfbClicks.length===2&&rfbClicks[0].b==='left'&&rfbClicks[1].b==='right'&&rfbClicks.every(c=>c.x===150&&c.y===170)"));
check('remote left and right RFB masks press and release',await ev("JSON.stringify(rfbMasks)===JSON.stringify([1,0,4,0])"));
// Unit scenarios in the actual browser module, using simulated API/permissions.
const motion=await ev(`(async()=>{const {MotionPointer}=await import('/assets/controls.js');let messages=[],moves=[];let m=new MotionPointer(v=>moves.push(v),(text,on)=>messages.push({text,on}));const secure=Object.getOwnPropertyDescriptor(window,'isSecureContext');Object.defineProperty(window,'isSecureContext',{value:false,configurable:true});await m.toggle();const insecure=messages.at(-1).text.includes('insecure HTTP')&&!m.enabled;Object.defineProperty(window,'isSecureContext',secure);const api=window.DeviceOrientationEvent;window.DeviceOrientationEvent={requestPermission:async()=> 'denied'};await m.toggle();const denied=messages.at(-1).text.includes('denied')&&!m.enabled;window.DeviceOrientationEvent=api;await m.toggle();m.read({beta:0,gamma:0});m.last-=17;m.read({beta:15,gamma:20});const simulated=m.active&&moves.length>0;m.stop();const stopped=!m.enabled;window.DeviceOrientationEvent=undefined;await m.toggle();const unsupported=messages.at(-1).text.includes('unavailable');window.DeviceOrientationEvent=api;await m.toggle();await new Promise(r=>setTimeout(r,4200));const timeout=!m.enabled&&messages.at(-1).text.includes('No usable');return {insecure,denied,simulated,stopped,unsupported,timeout};})()`);
for(const [key,ok]of Object.entries(motion))check('motion '+key+' (simulated)',ok);
await click('#btn-remote-back');await wait("!document.querySelector('#screen-home').hidden");await click('#tile-mouse');await c.sleep(350);
for(const [w,h]of [[390,844],[844,390],[1024,768]]) {await viewport(w,h);await c.sleep(100);check(`saved mouse layout fits ${w}x${h}`,await ev("['mouse-left','mouse-right','mouse-surface'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})"));}
await viewport(390,844);await c.screenshot(cdp,s,path.join(__dirname,'artifacts','50-mouse.png'));
await ev("pocketLayouts.begin('mouse');pocketLayouts.action('all')");await c.sleep(100);await ev("pocketLayouts.action('save')");
await c.screenshot(cdp,s,path.join(__dirname,'artifacts','51-mouse-default.png'));
check('reset all saves defaults',await ev("Object.values(pocketLayouts.saved.pages).every(p=>Object.keys(p).length===0)"));
check('no browser exceptions',errors.length===0); if(errors.length)console.log(errors);
}finally{cdp.close();browser.close();}
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exit(2)});
