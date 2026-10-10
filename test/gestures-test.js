#!/usr/bin/env node
// Real Chromium touch events → /wsctl → uinput kernel events on an insecure LAN origin.
const c=require('./cdp'),fs=require('fs');
let passed=0,failed=0;const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);ok?passed++:failed++;};
function nodeFor(name){return fs.readdirSync('/sys/class/input').filter(n=>/^event\d+$/.test(n)&&fs.readFileSync(`/sys/class/input/${n}/device/name`,'utf8').trim()===name).sort((a,b)=>parseInt(b.slice(5))-parseInt(a.slice(5)))[0];}
function drain(fd){let out=[],buf=Buffer.alloc(24*256);try{for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;for(let i=0;i<n;i+=24)out.push({t:buf.readUInt16LE(i+16),c:buf.readUInt16LE(i+18),v:buf.readInt32LE(i+20)});}}catch(e){if(e.code!=='EAGAIN')throw e;}return out;}
const keys=evs=>evs.filter(e=>e.t===1&&[272,273].includes(e.c)).map(e=>[e.c,e.v]);
const equals=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
(async()=>{
 const browser=await c.launchBrowser({extraArgs:['--host-resolver-rules=MAP pocket.test 127.0.0.1','--no-proxy-server']});const cdp=await c.CDP.connect(browser.version.webSocketDebuggerUrl);const {sessionId:s}=await c.newPage(cdp);
 const ev=code=>c.evaluate(cdp,s,code),click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
 const touch=(type,pts=[])=>c.sendTouch(cdp,s,type,pts);const wait=code=>c.waitFor(cdp,s,code,{timeout:15000});
 const box=sel=>ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,id:1}})()`);
 let fd;
 try{
 await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.structuredClone=undefined;window.controlSockets=[];const NativeWS=WebSocket;window.WebSocket=class extends NativeWS{constructor(...args){super(...args);if(String(args[0]).includes('/wsctl'))controlSockets.push(this)}send(data){if(!window.dropControl)super.send(data)}};`},s);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},s);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},s);
 await cdp.send('Page.navigate',{url:`http://pocket.test:${process.env.PORT||8765}`},s);await wait("!document.querySelector('#screen-login').hidden");
 for(const d of '1234'){await click(`#pinpad [data-key="${d}"]`);await c.sleep(80);}await wait("!document.querySelector('#screen-home').hidden");
 console.log('HTTP environment',await ev("({secure:isSecureContext,clone:typeof structuredClone})"));
 check('test uses an insecure HTTP origin',await ev("!isSecureContext"));
 check('shared layout editor initializes on HTTP',await ev('!!window.pocketLayouts'));
 await click('#tile-mouse');await c.sleep(500);
 const device=nodeFor('Pocket Desktop virtual mouse');fd=fs.openSync('/dev/input/'+device,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
 const pt=await box('#mouse-surface');const tap=async()=>{await touch('touchStart',[pt]);await c.sleep(40);await touch('touchEnd');};
 drain(fd);await tap();await c.sleep(390);check('single tap is exactly one real left click',equals(keys(drain(fd)),[[272,1],[272,0]]));
 await tap();await c.sleep(70);await tap();await c.sleep(390);check('double tap is right only, no left click',equals(keys(drain(fd)),[[273,1],[273,0]]));
 await tap();await c.sleep(50);await tap();await c.sleep(50);await tap();await c.sleep(390);check('triple tap is right plus one left',equals(keys(drain(fd)),[[273,1],[273,0],[272,1],[272,0]]));
 await touch('touchStart',[pt]);await touch('touchMove',[{...pt,x:pt.x+35}]);await touch('touchEnd');await c.sleep(390);let out=drain(fd);check('early swipe moves with no click or held button',out.some(e=>e.t===2&&e.c===0&&e.v>0)&&keys(out).length===0);
 await touch('touchStart',[pt]);await c.sleep(430);await touch('touchMove',[{...pt,x:pt.x+40}]);await c.sleep(80);out=drain(fd);check('hold starts real press before movement, no early release',equals(keys(out),[[272,1]])&&out.findIndex(e=>e.t===1)<out.findIndex(e=>e.t===2));
 await touch('touchEnd');await c.sleep(390);check('drag ends with one release, no tap',equals(keys(drain(fd)),[[272,0]]));
 await tap();await c.sleep(50);await touch('touchStart',[pt]);await c.sleep(430);await touch('touchMove',[{...pt,x:pt.x+40}]);await touch('touchEnd');await c.sleep(390);check('drag suppresses earlier pending tap',equals(keys(drain(fd)),[[272,1],[272,0]]));
 await touch('touchStart',[pt]);await c.sleep(430);drain(fd);await touch('touchCancel');await c.sleep(350);check('touch cancellation releases held button',equals(keys(drain(fd)),[[272,0]]));
 await touch('touchStart',[pt]);await c.sleep(430);drain(fd);await touch('touchMove',[{...pt,x:1}]);await touch('touchEnd');await c.sleep(350);check('leaving surface releases held button',equals(keys(drain(fd)),[[272,0]]));
 for(const [side,code]of [['left',272],['right',273]]){
  const button=await box('#mouse-'+side);await touch('touchStart',[button]);await c.sleep(80);check(side+' dedicated button holds (not completed click)',equals(keys(drain(fd)),[[code,1]]));
  await touch('touchStart',[button,{...pt,id:2}]);await touch('touchMove',[button,{...pt,id:2,x:pt.x+35}]);await c.sleep(60);out=drain(fd);check(side+' dedicated hold allows movement without release',out.some(e=>e.t===2)&&keys(out).length===0);
  await touch('touchEnd');await c.sleep(350);check(side+' dedicated drag releases exactly once',equals(keys(drain(fd)),[[code,0]]));
 }
 await tap();await c.sleep(60);let bp=await box('#mouse-right');await touch('touchStart',[bp]);await touch('touchEnd');await c.sleep(390);check('dedicated button cancels pending surface tap',equals(keys(drain(fd)),[[273,1],[273,0]]));


 const setIntervalMs=async value=>ev(`(()=>{const el=document.querySelector('#mouse-tap-interval');el.value=${value};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await setIntervalMs(350);await tap();await c.sleep(310);await tap();await c.sleep(440);
 check('350ms window accepts a slower double tap',equals(keys(drain(fd)),[[273,1],[273,0]]));
 await setIntervalMs(250);await tap();await c.sleep(310);await tap();await c.sleep(400);
 check('250ms window commits two separate left taps',equals(keys(drain(fd)),[[272,1],[272,0],[272,1],[272,0]]));
 await setIntervalMs(300);
 // Scroll and speed are separate paths, measured at the kernel mouse device.
 const changeSpeed=async value=>ev(`(()=>{const el=document.querySelector('#mouse-speed');el.value=${value};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const swipe=async(dx)=>{await touch('touchStart',[pt]);await touch('touchMove',[{...pt,x:pt.x+dx}]);await touch('touchEnd');await c.sleep(120);return drain(fd);};
 await changeSpeed(.2);drain(fd);let slow=await swipe(40);
 check('slow speed sends exactly 8 relative units for 40px',slow.filter(e=>e.t===2&&e.c===0).reduce((n,e)=>n+e.v,0)===8);
 check('speed display changes immediately',await ev("document.querySelector('#mouse-speed-value').textContent==='0.20×'&&document.querySelector('#mouse-preference-status').textContent.includes('Applied now')"));
 await changeSpeed(1.2);let fast=await swipe(40);
 check('live speed change sends exactly 48 units without refresh',fast.filter(e=>e.t===2&&e.c===0).reduce((n,e)=>n+e.v,0)===48);
 await changeSpeed(.2);await touch('touchStart',[pt]);await touch('touchMove',[{...pt,x:pt.x+11}]);
 for(let dx=12;dx<=20;dx++)await touch('touchMove',[{...pt,x:pt.x+dx}]);await touch('touchEnd');await c.sleep(100);
 check('fractional slow deltas accumulate without rounding loss',drain(fd).filter(e=>e.t===2&&e.c===0).reduce((n,e)=>n+e.v,0)===4);
 await touch('touchStart',[pt,{...pt,id:2,x:pt.x+40}]);await touch('touchMove',[{...pt,y:pt.y+40},{...pt,id:2,x:pt.x+40,y:pt.y+40}]);await touch('touchEnd');await c.sleep(450);
 check('two fingers on pad send no scroll, clicks or pointer movement',drain(fd).length===0);
 await ev("document.querySelector('#mouse-surface').dispatchEvent(new WheelEvent('wheel',{deltaY:100,cancelable:true}))");await c.sleep(80);
 check('native pad wheel cannot reintroduce two-finger scroll',drain(fd).length===0);
 const sc=await box('#mouse-scroll');
 for(const [label,dy,sign]of [['up',-54,1],['down',54,-1]]){
  await touch('touchStart',[sc]);await touch('touchMove',[{...sc,y:sc.y+dy}]);await touch('touchEnd');await c.sleep(120);const events=drain(fd);
  check('one-finger strip '+label+' sends correct wheel only',events.some(e=>e.t===2&&e.c===8&&Math.sign(e.v)===sign)&&!events.some(e=>e.t===1||(e.t===2&&e.c!==8)));
 }
 await touch('touchStart',[pt]);await touch('touchMove',[{...pt,x:pt.x+20}]);drain(fd);
 await touch('touchStart',[{...pt,x:pt.x+20},{...sc,id:2}]);await touch('touchMove',[{...pt,x:pt.x+40},{...sc,id:2,y:sc.y+36}]);await touch('touchEnd');await c.sleep(120);const combined=drain(fd);
 check('strip scroll and pad movement work concurrently without click',combined.some(e=>e.t===2&&e.c===0)&&combined.some(e=>e.t===2&&e.c===8)&&!combined.some(e=>e.t===1));
 check('PC acceptance is visible after scroll',await ev("document.querySelector('#mouse-input-status').textContent==='PC accepted scroll'"));

 for(const [w,h]of [[390,844],[360,640],[844,390],[568,320]]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true},s);await c.sleep(100);
  check(`mousepad/strip/clicks do not overlap at ${w}x${h}`,await ev("(()=>{const surface=document.querySelector('#mouse-surface').getBoundingClientRect(),click=document.querySelector('#mouse-left').getBoundingClientRect(),strip=document.querySelector('#mouse-scroll').getBoundingClientRect(),speed=document.querySelector('#mouse-speed').getBoundingClientRect();return surface.bottom<=click.top&&surface.right<strip.left&&strip.right<=innerWidth&&speed.bottom<=innerHeight&&click.bottom<=innerHeight})()"));
 }
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},s);await c.sleep(100);
 await changeSpeed(.75);await click('#mouse-back');await click('#tile-mouse');await c.sleep(350);
 check('speed persists when leaving and reopening',await ev("document.querySelector('#mouse-speed').value==='0.75'&&document.querySelector('#mouse-speed-value').textContent==='0.75×'"));
 drain(fd);const restoredMovement=await swipe(40);check('restored speed actually affects backend movement',restoredMovement.filter(e=>e.t===2&&e.c===0).reduce((n,e)=>n+e.v,0)===30);
 // Mouse desktop drag is immediate once physical-button movement crosses slop.
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pt.x,y:pt.y},s);drain(fd);
 await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:pt.x,y:pt.y,button:'left',buttons:1,clickCount:1},s);
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pt.x+40,y:pt.y,button:'left',buttons:1},s);
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pt.x+40,y:pt.y,button:'left',buttons:0,clickCount:1},s);await c.sleep(350);
 out=drain(fd);check('desktop pressed movement performs real drag',equals(keys(out),[[272,1],[272,0]])&&out.some(e=>e.t===2));
 await touch('touchStart',[pt]);await c.sleep(430);drain(fd);await ev('controlSockets.at(-1).close()');await c.sleep(250);check('socket closure releases real held input',equals(keys(drain(fd)),[[272,0]]));await touch('touchEnd');await c.sleep(1000);drain(fd);
 await touch('touchStart',[pt]);await c.sleep(430);drain(fd);await ev('window.dropControl=true');await c.sleep(4400);check('silent link loss expires input lease and releases',keys(drain(fd)).some(e=>e[0]===272&&e[1]===0));await touch('touchEnd');await ev('window.dropControl=false');await c.sleep(1000);
 await click('#mouse-back');await click('#tile-pad');await wait("!!document.querySelector('#pad-move .pad-stick')");
 await click('#pad-settings');check('settings visibly offers layout customization',await ev("document.querySelector('#pad-panel').classList.contains('open')&&!!document.querySelector('#pad-panel [data-edit=pad]')"));
 await click('#pad-panel [data-edit=pad]');check('settings opens existing edit mode',await ev("pocketLayouts.editing&&document.querySelector('#screen-pad').classList.contains('layout-editing')"));
 let p=await box('#pad-look');await touch('touchStart',[p]);await touch('touchMove',[{...p,x:p.x-25,y:p.y+30}]);await touch('touchEnd');await ev("pocketLayouts.action('save')");
 check('touch drag saves layout on HTTP',await ev("!!JSON.parse(localStorage.getItem('pd-layouts-v1')).pages.pad['pad-look']"));
 await cdp.send('Page.reload',{},s);await wait("window.pocketLayouts&&!document.querySelector('#screen-home').hidden");await click('#tile-pad');await wait("!!document.querySelector('#pad-move .pad-stick')");
 check('mouse speed restores after page reload',await ev("document.querySelector('#mouse-speed').value==='0.75'"));
 check('saved layout is applied after HTTP reload',await ev("document.querySelector('#pad-look').style.position==='fixed'"));
 for(const [w,h]of [[844,390],[360,640],[390,844]]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true},s);await c.sleep(100);
  check(`saved gamepad control stays usable at ${w}x${h}`,await ev("(()=>{const r=document.querySelector('#pad-look').getBoundingClientRect(),head=document.querySelector('.pad-top').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=head.bottom&&r.bottom<=innerHeight})()"));
 }

 await click('#screen-pad > header [data-edit]');await ev("pocketLayouts.action('reset');pocketLayouts.action('cancel')");check('cancel restores saved layout',await ev("document.querySelector('#pad-look').style.position==='fixed'&&!pocketLayouts.editing"));
 await click('#screen-pad > header [data-edit]');await ev("pocketLayouts.action('reset');pocketLayouts.action('save')");check('reset and save restores default',await ev("!document.querySelector('#pad-look').style.position&&Object.keys(pocketLayouts.saved.pages.pad).length===0"));
 check('normal operation no longer edits controls',await ev("!pocketLayouts.editing&&!document.querySelector('#screen-pad').classList.contains('layout-editing')"));
 const padfd=fs.openSync('/dev/input/'+nodeFor('Microsoft X-Box 360 pad'),fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);drain(padfd);
 const a=await box('[data-pad-btn=a]');await touch('touchStart',[a]);await c.sleep(80);const press=drain(padfd);await touch('touchEnd');await c.sleep(80);const release=drain(padfd);fs.closeSync(padfd);
 check('gamepad A still reaches kernel after editing',press.some(e=>e.t===1&&e.c===0x130&&e.v===1)&&release.some(e=>e.t===1&&e.c===0x130&&e.v===0));

 }finally{if(fd)fs.closeSync(fd);cdp.close();browser.close();}
 console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exit(2)});
