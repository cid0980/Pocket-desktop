#!/usr/bin/env node
/* Requires an Xorg test display configured to read the app's actual uinput mouse
 * through evdev, and a headed Chromium on debug port 9339 showing selection-target.html.
 * Never run this against a user's active desktop. CDP input drives ONLY the phone;
 * desktop selection is caused by kernel mouse events, not DOM/CDP target injection. */
const c=require('./cdp'),{execFileSync}=require('child_process');
(async()=>{
 const version=await c.httpJson('http://127.0.0.1:9339/json/version');const desktop=await c.CDP.connect(version.webSocketDebuggerUrl);
 const {targetInfos}=await desktop.send('Target.getTargets');const target=targetInfos.find(t=>t.url.includes('selection-target.html'));if(!target)throw Error('Selection target not running');
 const {sessionId:ds}=await desktop.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});await desktop.send('Runtime.enable',{},ds);
 const de=code=>c.evaluate(desktop,ds,code);
 const browser=await c.launchBrowser();const phone=await c.CDP.connect(browser.version.webSocketDebuggerUrl);const {sessionId:ps}=await c.newPage(phone);
 const ev=code=>c.evaluate(phone,ps,code),click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`),touch=(type,pts=[])=>c.sendTouch(phone,ps,type,pts);
 let passed=0;function check(name,ok){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);passed++;}
 try{
 await phone.send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true},ps);
 await phone.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},ps);
 await phone.send('Page.navigate',{url:`http://127.0.0.1:${process.env.PORT||8765}`},ps);await c.waitFor(phone,ps,"!document.querySelector('#screen-login').hidden");
 for(const d of '1234'){await click(`#pinpad [data-key="${d}"]`);await c.sleep(80);}await c.waitFor(phone,ps,"!document.querySelector('#screen-home').hidden");
 await click('#tile-mouse');await c.sleep(500);
 const pt=await ev("(()=>{const r=document.querySelector('#mouse-surface').getBoundingClientRect();return{x:r.x+90,y:r.y+r.height/2,id:1}})()");
 const position=async()=>{
  await de('getSelection().removeAllRanges();inputEvents=[]');
  const r=await de("(()=>{const r=document.querySelector('#text').getBoundingClientRect();return{x:r.left+2,y:r.top+r.height/2}})()");
  execFileSync('xdotool',['mousemove',String(Math.round(r.x)),String(Math.round(r.y))],{env:{...process.env,DISPLAY:process.env.SELECTION_DISPLAY||':98'}});
  await c.sleep(100);
 };
 for(const mode of ['surface hold','dedicated hold']){
  await position();let button;
  if(mode==='surface hold'){await touch('touchStart',[pt]);await c.sleep(430);}
  else{
   button=await ev("(()=>{const r=document.querySelector('#mouse-left').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,id:2}})()");
   await touch('touchStart',[button]);await touch('touchStart',[button,pt]);
  }
  for(let dx=20;dx<=170;dx+=20){await touch('touchMove',[...(button?[button]:[]),{...pt,x:pt.x+dx}]);await c.sleep(30);}
  await touch('touchEnd');await c.sleep(350);
  const result=await de("({text:getSelection().toString(),events:inputEvents})");console.log(mode+' selected:',JSON.stringify(result.text));
  check(mode+' selects real text',result.text.length>=10);
  check(mode+' target received trusted held movement then release',result.events.some(e=>e.type==='mousedown'&&e.buttons===1&&e.trusted)&&result.events.some(e=>e.type==='mousemove'&&e.buttons===1&&e.trusted)&&result.events.some(e=>e.type==='mouseup'&&e.buttons===0&&e.trusted));
  await touch('touchStart',[pt]);await touch('touchMove',[{...pt,x:pt.x+30}]);await touch('touchEnd');await c.sleep(350);
  check(mode+' highlight persists after release and free movement',await de(`getSelection().toString()===${JSON.stringify(result.text)}`));
 }
 console.log(`${passed} passed, 0 failed`);
 }finally{phone.close();browser.close();desktop.close();}
})().catch(e=>{console.error(e);process.exit(1)});
