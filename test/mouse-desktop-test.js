#!/usr/bin/env node
/* Requires an Xorg test display configured to read the app's actual uinput mouse
 * through evdev, and a headed Chromium on debug port 9339 showing selection-target.html.
 * Never run this against a user's active desktop. CDP input drives ONLY the phone;
 * desktop selection is caused by kernel mouse events, not DOM/CDP target injection. */
const c=require('./cdp'),{execFileSync}=require('child_process');
(async()=>{
 const version=await c.httpJson('http://127.0.0.1:9339/json/version');const desktop=await c.CDP.connect(version.webSocketDebuggerUrl);
 const {targetInfos}=await desktop.send('Target.getTargets');const target=targetInfos.find(t=>t.url.includes('selection-target.html'));if(!target)throw Error('Selection target not running');
 const {sessionId:ds}=await desktop.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});await desktop.send('Runtime.enable',{},ds);await desktop.send('Page.enable',{},ds);await desktop.send('Page.reload',{},ds);
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

 const place=async(selector)=>{
  const p=await de(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return{x:screenX+(outerWidth-innerWidth)/2+r.x+r.width/2,y:screenY+outerHeight-innerHeight+r.y+r.height/2}})()`);
  execFileSync('xdotool',['mousemove',String(Math.round(p.x)),String(Math.round(p.y))],{env:{...process.env,DISPLAY:':98'}});await c.sleep(80);
 };
 const tap=async()=>{await touch('touchStart',[pt]);await c.sleep(45);await touch('touchEnd');};
 await place('#click-target');await de('clickCounts={left:0,right:0};frameHeld=false;inputEvents=[]');
 await tap();await c.sleep(450);
 let result=await de('({clickCounts,frameHeld,inputEvents})');console.log('Single tap desktop result',JSON.stringify(result));
 if(process.env.BASELINE)return;
 check('single tap activates desktop target exactly once',result.clickCounts.left===1&&result.clickCounts.right===0);
 check('tap remains down across a desktop frame',result.frameHeld);
 check('PC tap press lasts at least 40ms',result.inputEvents.find(e=>e.type==='mouseup').time-result.inputEvents.find(e=>e.type==='mousedown').time>=40);
 await de('clickCounts={left:0,right:0}');await tap();await c.sleep(60);await tap();await c.sleep(450);
 result=await de('clickCounts');check('double tap activates desktop context click only',result.left===0&&result.right===1);
 for(const [side,key]of [['left','left'],['right','right']]){
  await de('clickCounts={left:0,right:0}');const bp=await ev(`(()=>{const r=document.querySelector('#mouse-${side}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,id:2}})()`);
  await touch('touchStart',[bp]);await c.sleep(60);await touch('touchEnd');await c.sleep(120);
  result=await de('clickCounts');check('dedicated '+side+' activates desktop target once',result[key]===1&&result[side==='left'?'right':'left']===0);
 }

 await de("window.wheelEvents=[];window.wheelTrace=e=>wheelEvents.push({dy:e.deltaY,x:e.clientX,y:e.clientY,target:e.target.tagName,trusted:e.isTrusted});document.addEventListener('wheel',window.wheelTrace,{passive:true})");await place('#scroller');await de("document.querySelector('#scroller').scrollTop=800;new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
 const strip=await ev("(()=>{const r=document.querySelector('#mouse-scroll').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,id:2}})()");
 // XTEST placement switches X input devices. Seed the evdev smooth-scroll
 // baseline once before measuring; this rig does not assert that first event.
 await touch('touchStart',[strip]);await touch('touchMove',[{...strip,y:strip.y-20}]);await touch('touchEnd');await c.sleep(180);
 await de("document.querySelector('#scroller').scrollTop=800;wheelEvents=[];new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
 const pointer=()=>execFileSync('xdotool',['getmouselocation','--shell'],{env:{...process.env,DISPLAY:':98'},encoding:'utf8'}).split('SCREEN')[0];
 for(const [name,dy]of [['up',-45],['down',45]]){
  const before=await de("document.querySelector('#scroller').scrollTop"),oldPointer=pointer();
  await touch('touchStart',[strip]);await touch('touchMove',[{...strip,y:strip.y+dy}]);await touch('touchEnd');await c.sleep(350);
  const after=await de("document.querySelector('#scroller').scrollTop");console.log(name+' scroll',before,'→',after,'pointer',pointer(),'strip',strip,'phone',await ev("({input:document.querySelector('#mouse-input-status').textContent,ready:document.querySelector('#screen-mouse').dataset.ready,rect:document.querySelector('#mouse-scroll').getBoundingClientRect().toJSON()})"),'wheel',await de("window.wheelEvents||[]"));
  check('strip '+name+' scrolls actual desktop content',dy<0?after<before:after>before);
  check('strip '+name+' does not move desktop pointer',pointer()===oldPointer);
 }
 await c.screenshot(phone,ps,require('path').join(__dirname,'artifacts','70-mousepad-speed-scroll.png'));
 const position=async()=>{
  await de('getSelection().removeAllRanges();inputEvents=[]');
  const r=await de("(()=>{const r=document.querySelector('#text').getBoundingClientRect();return{x:screenX+(outerWidth-innerWidth)/2+r.left+2,y:screenY+outerHeight-innerHeight+r.top+r.height/2}})()");
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
  for(let dx=20;dx<=380;dx+=20){await touch('touchMove',[...(button?[button]:[]),{...pt,x:pt.x+dx}]);await c.sleep(30);}
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
