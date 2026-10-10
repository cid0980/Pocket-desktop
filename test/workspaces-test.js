#!/usr/bin/env node
/* Chromium geometry/navigation checks; not a substitute for a physical phone. */
const c=require('./cdp'),path=require('path');
(async()=>{
 let passed=0,failed=0;const check=(name,ok,extra='')=>{console.log(`${ok?'PASS':'FAIL'} ${name}${extra?' '+JSON.stringify(extra):''}`);ok?passed++:failed++;};
 const browser=await c.launchBrowser(),cdp=await c.CDP.connect(browser.version.webSocketDebuggerUrl),{sessionId:s}=await c.newPage(cdp);
 const ev=code=>c.evaluate(cdp,s,code),click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`),wait=code=>c.waitFor(cdp,s,code,{timeout:15000});const errors=[];
 cdp.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text),s);
 const viewport=async(w,h)=>{await cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true},s);await c.sleep(100);};
 const viewports=[[390,844],[360,640],[320,568],[844,390],[568,320],[1024,768]];
 const geometry=selector=>ev(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length),rects=els.map(e=>({id:e.id||e.textContent.trim(),r:e.getBoundingClientRect()}));const bad=rects.filter(({r})=>r.width<43.5||r.height<43.5||r.left<-.5||r.right>innerWidth+.5||r.top<-.5||r.bottom>innerHeight+.5).map(({id,r})=>({id,w:r.width,h:r.height,x:r.x,y:r.y}));const overlaps=[];for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1)overlaps.push([a.id,b.id]);}return {bad,overlaps};})()`);
 try{
 await viewport(390,844);await cdp.send('Page.navigate',{url:`http://127.0.0.1:${process.env.PORT||8765}`},s);await wait("!document.querySelector('#screen-login').hidden");
 for(const d of '1234'){await click(`#pinpad [data-key="${d}"]`);await c.sleep(80);}await wait("!document.querySelector('#screen-home').hidden");
 check('every element ID is unique',await ev("(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return new Set(ids).size===ids.length})()"));
 await click('#tile-settings');await wait("!document.querySelector('#btn-save-settings').disabled");
 check('settings starts with categories, not a long form',await ev("!document.querySelector('#settings-categories').hidden&&[...document.querySelectorAll('[data-category-panel]')].every(e=>e.hidden)"));
 for(const name of ['display','mouse','gamepad','keyboard','motion','device','connection','help']){
  await click(`[data-category="${name}"]`);check('only '+name+' category is visible',await ev(`document.querySelector('#settings-categories').hidden&&[...document.querySelectorAll('[data-category-panel]')].filter(e=>!e.hidden).length===1&&!document.querySelector('[data-category-panel=${name}]').hidden`));
  await click('#settings-back');
 }
 await click('[data-category="mouse"]');await ev("document.querySelector('#settings-mouse-speed').value='.85';document.querySelector('#settings-mouse-speed').dispatchEvent(new Event('input',{bubbles:true}))");
 check('category speed updates live mousepad control and persistence',await ev("document.querySelector('#mouse-speed').value==='0.85'&&JSON.parse(localStorage.getItem('pd-mouse-preferences-v1')).speed===.85"));
 await click('#settings-back');await c.screenshot(cdp,s,path.join(__dirname,'artifacts','80-settings-categories.png'));
 await click('[data-category="device"]');await ev("document.querySelector('#set-name').value='Unsaved test name'");await click('#settings-back');await click('[data-category="device"]');check('category navigation retains unsaved PC edits',await ev("document.querySelector('#set-name').value==='Unsaved test name'"));
 await click('#sheet-settings [data-close-sheet]');await click('#tile-settings');await wait("!document.querySelector('#btn-save-settings').disabled");check('reopening discards unsaved PC edits',await ev("document.querySelector('#set-name').value!=='Unsaved test name'"));
 await click('#sheet-settings [data-close-sheet]');await click('#tile-mouse');await wait("document.querySelector('#screen-mouse').dataset.ready==='true'");
 for(const [w,h]of viewports){await viewport(w,h);const g=await geometry('#screen-mouse button,#mouse-surface,#mouse-scroll');check(`mouse buttons/surface fit without overlap ${w}x${h}`,!g.bad.length&&!g.overlaps.length,g.bad.length||g.overlaps.length?g:'');}
 await viewport(390,844);await c.screenshot(cdp,s,path.join(__dirname,'artifacts','81-mouse-workspace.png'));
 await click('#mouse-settings');await wait("!document.querySelector('#btn-save-settings').disabled");check('mouse gear opens mouse category',await ev("!document.querySelector('[data-category-panel=mouse]').hidden"));await click('#sheet-settings [data-close-sheet]');
 await click('#mouse-keyboard');for(const [w,h]of viewports){await viewport(w,h);check(`keyboard has no horizontal overflow ${w}x${h}`,await ev("document.querySelector('.keyboard-body').scrollWidth<=innerWidth"));}
 await viewport(390,844);await ev("document.querySelector('.keyboard-body').scrollTop=0");await c.screenshot(cdp,s,path.join(__dirname,'artifacts','82-keyboard-workspace.png'));let g=await geometry('#screen-keyboard button');check('keyboard touch buttons are 44px+ and separate',!g.bad.length&&!g.overlaps.length,g);
 await click('#keyboard-back');await click('#mouse-back');await click('#tile-pad');await wait("!!document.querySelector('#pad-move .pad-stick')");
 for(const [w,h]of viewports){await viewport(w,h);g=await geometry('#screen-pad button,#pad-move,#pad-look,#pad-dpad');check(`gamepad touch targets fit without overlap ${w}x${h}`,!g.bad.length&&!g.overlaps.length,g.bad.length||g.overlaps.length?g:'');}
 await viewport(844,390);await c.screenshot(cdp,s,path.join(__dirname,'artifacts','83-gamepad-landscape.png'));
 await ev("window.sent=[];const original=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{}return original.call(this,data)}");
 const pt=await ev("(()=>{const r=document.querySelector('#pad-lt').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pt},s);await c.sleep(80);await click('#pad-settings');await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pt},s);
 check('opening settings releases a held gamepad trigger',await ev("!document.querySelector('#pad-lt').classList.contains('down')&&sent.some(m=>m.t==='pad'&&m.a.lt===255)&&sent.filter(m=>m.t==='pad').at(-1)?.a.lt===0"));
 await click('#sheet-settings [data-close-sheet]');await click('#pad-exit');await ev('window.__pd.openRemote()');await wait('window.__pd.state.session?.connected');
 for(const [w,h]of viewports){await viewport(w,h);g=await geometry('.pillbar button,#remote-bar button');check(`remote main controls fit and do not overlap ${w}x${h}`,!g.bad.length&&!g.overlaps.length,g.bad.length||g.overlaps.length?g:'');check(`remote stage stays clear of dock ${w}x${h}`,await ev("document.querySelector('#remote-stage').getBoundingClientRect().bottom<=document.querySelector('#remote-dock').getBoundingClientRect().top+1"));}
 await viewport(390,844);await c.screenshot(cdp,s,path.join(__dirname,'artifacts','84-remote-workspace.png'));
 await click('#btn-more');await click('[data-action="settings-page"]');check('remote menu opens screen category',await ev("!document.querySelector('[data-category-panel=display]').hidden"));
 check('no browser exceptions',errors.length===0,errors);console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
 }finally{cdp.close();browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
