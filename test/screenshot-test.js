#!/usr/bin/env node
const c=require('./cdp');
(async()=>{
 let passed=0;const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);passed++;};
 const browser=await c.launchBrowser(),d=await c.CDP.connect(browser.version.webSocketDebuggerUrl),{sessionId:s}=await c.newPage(d);
 const ev=code=>c.evaluate(d,s,code),click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`),wait=code=>c.waitFor(d,s,code,{timeout:20000});let downloads=0;const errors=[];
 d.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails?.exception?.description),s);d.on('Browser.downloadWillBegin',()=>downloads++);
 await d.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:true});
 const viewport=async(w,h)=>{await d.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true},s);await c.sleep(100);};
 const rect=()=>ev("(()=>{const r=document.querySelector('#shot-stage').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
 const scale=()=>ev("new DOMMatrix(getComputedStyle(document.querySelector('#shot-img')).transform).a");
 const touch=(type,points=[])=>c.sendTouch(d,s,type,points);
 try{
 await viewport(390,844);await d.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},s);
 await d.send('Page.navigate',{url:`http://127.0.0.1:${process.env.PORT||8765}`},s);await wait("!document.querySelector('#screen-login').hidden");
 for(const n of '1234'){await click(`#pinpad [data-key="${n}"]`);await c.sleep(80);}await wait("!document.querySelector('#screen-home').hidden");
 await click('#tile-screenshot');await wait("!document.querySelector('#shot-img').hidden");
 check('actual PC screenshot loads into the in-app viewer',await ev("document.querySelector('#shot-img').naturalWidth>0&&document.querySelector('#shot-img').src.startsWith('blob:')"));
 const base=await scale();await click('[data-shot-view="in"]');check('zoom-in button enlarges screenshot',await scale()>base);
 await click('[data-shot-view="out"]');check('zoom-out returns to fit',Math.abs(await scale()-base)<.001);
 await click('#shot-open');check('Actual size displays native pixels in the same page',Math.abs(await scale()-1)<.001);
 let p=await rect(),before=await ev("document.querySelector('#shot-img').style.transform");
 await touch('touchStart',[{...p,id:1}]);await touch('touchMove',[{x:p.x-70,y:p.y-40,id:1}]);await touch('touchEnd');
 check('one-finger drag pans the enlarged screenshot',await ev(`document.querySelector('#shot-img').style.transform!==${JSON.stringify(before)}`));
 await click('[data-shot-view="fit"]');p=await rect();
 await touch('touchStart',[{x:p.x-35,y:p.y,id:1},{x:p.x+35,y:p.y,id:2}]);await touch('touchMove',[{x:p.x-90,y:p.y,id:1},{x:p.x+90,y:p.y,id:2}]);await touch('touchEnd');
 check('two-finger pinch zooms in',await scale()>base*2);
 await touch('touchStart',[{x:p.x-90,y:p.y,id:1},{x:p.x+90,y:p.y,id:2}]);await touch('touchMove',[{x:p.x-35,y:p.y,id:1},{x:p.x+35,y:p.y,id:2}]);await touch('touchEnd');
 check('reverse pinch zooms out',Math.abs(await scale()-base)<.01);
 for(let i=0;i<2;i++){await touch('touchStart',[{...p,id:1}]);await touch('touchEnd');await c.sleep(60);}
 check('double tap enlarges screenshot',await scale()>base*1.9);
 await click('[data-shot-view="fit"]');
 await ev("document.querySelector('#shot-stage').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:190,clientY:300,cancelable:true,bubbles:true}))");check('mouse wheel zoom is supported',await scale()>base);
 for(const [w,h]of [[320,568],[390,844],[844,390],[568,320]]){
  await viewport(w,h);await click('[data-shot-view="fit"]');
  check(`whole image fits the viewer ${w}x${h}`,await ev("(()=>{const a=document.querySelector('#shot-img').getBoundingClientRect(),b=document.querySelector('#shot-stage').getBoundingClientRect();return a.width<=b.width+1&&a.height<=b.height+1&&a.left>=b.left-1&&a.top>=b.top-1})()"));
  check(`toolbar remains reachable ${w}x${h}`,await ev("[...document.querySelectorAll('#sheet-shot button')].every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})"));
 }
 const oldURL=await ev("document.querySelector('#shot-img').src");await click('#btn-shot-again');await wait("!document.querySelector('#shot-img').hidden");check('Refresh captures a new screenshot',await ev(`document.querySelector('#shot-img').src!==${JSON.stringify(oldURL)}`));
 await click('#sheet-shot [data-close-sheet]');check('close releases image and hides viewer',await ev("document.querySelector('#sheet-shot').hidden&&!document.querySelector('#shot-img').getAttribute('src')"));
 await ev("window.originalFetch=fetch;window.fetch=(url,...args)=>url==='/api/screenshot'?Promise.resolve(new Response(JSON.stringify({error:'Capture unavailable'}),{status:503,headers:{'Content-Type':'application/json'}})):originalFetch(url,...args)");
 await click('#tile-screenshot');await wait("document.querySelector('#shot-msg').textContent==='Capture unavailable'");check('capture failure is visible and zoom controls disabled',await ev("!document.querySelector('#shot-msg').hidden&&document.querySelector('[data-shot-view=in]').disabled"));
 await ev('window.fetch=originalFetch');await click('#btn-shot-again');await wait("!document.querySelector('#shot-img').hidden");check('Refresh recovers after a capture failure',await ev("document.querySelector('#shot-msg').hidden"));
 check('no download triggered',downloads===0&&await ev("!document.querySelector('#sheet-shot a[download]')"));
 check('no browser exceptions',errors.length===0);console.log(`${passed} passed, 0 failed`);
 }finally{d.close();browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
