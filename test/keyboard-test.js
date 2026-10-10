#!/usr/bin/env node
/* Controlled X11 keyboard integration. Requires a headed Chromium on :99,
 * CDP 9340, showing keyboard-target.html. Do not run against a user's desktop. */
const c=require('./cdp'),{execFileSync}=require('child_process');
const PORT=process.env.PORT||8765;
(async()=>{
 let passed=0;const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);passed++;};
 const unauth=await fetch(`http://127.0.0.1:${PORT}/api/keyboard`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'Enter'})});check('keyboard endpoint requires authentication',unauth.status===401);
 const version=await c.httpJson('http://127.0.0.1:9340/json/version'),desktop=await c.CDP.connect(version.webSocketDebuggerUrl);
 const {targetInfos}=await desktop.send('Target.getTargets'),target=targetInfos.find(t=>t.url.includes('keyboard-target.html'));if(!target)throw Error('Keyboard target missing');
 const {sessionId:ds}=await desktop.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});await desktop.send('Runtime.enable',{},ds);
 const de=code=>c.evaluate(desktop,ds,code);
 const win=execFileSync('xdotool',['search','--name','Keyboard verification target'],{env:{...process.env,DISPLAY:':99'},encoding:'utf8'}).trim().split('\n').at(-1);execFileSync('xdotool',['windowfocus','--sync',win],{env:{...process.env,DISPLAY:':99'}});
 const browser=await c.launchBrowser(),phone=await c.CDP.connect(browser.version.webSocketDebuggerUrl),{sessionId:s}=await c.newPage(phone);
 const ev=code=>c.evaluate(phone,s,code),click=sel=>ev(`document.querySelector(${JSON.stringify(sel)}).click()`),wait=code=>c.waitFor(phone,s,code,{timeout:15000});const errors=[];phone.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails?.exception?.description),s);
 try{
 await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},s);await phone.send('Page.navigate',{url:`http://127.0.0.1:${PORT}`},s);await wait("!document.querySelector('#screen-login').hidden");
 for(const d of '1234'){await click(`#pinpad [data-key="${d}"]`);await c.sleep(80);}await wait("!document.querySelector('#screen-home').hidden");await click('#tile-keyboard');
 check('standalone keyboard opens without a remote-screen session',await ev("!document.querySelector('#screen-keyboard').hidden&&!window.__pd.state.session"));
 const request=body=>ev(`fetch('/api/keyboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,data:await r.json()}))`);
 for(const body of [{},{text:4},{text:'x'.repeat(1025)},{text:'a\0b'},{key:'exec'},{key:['Enter']}]){const r=await request(body);check('rejects invalid keyboard payload '+JSON.stringify(body).slice(0,35),r.status===400);}
 await de('clearTarget()');
 const text='Hello PC — café தமிழ் 😀';
 await ev(`document.querySelector('#keyboard-draft').value=${JSON.stringify(text)};document.querySelector('#keyboard-draft').dispatchEvent(new Event('input'))`);
 check('character count follows draft',await ev(`document.querySelector('#keyboard-count').textContent.startsWith('${text.length} /')`));
 await click('#keyboard-send');await wait("!document.querySelector('#keyboard-send').disabled");await c.sleep(200);
 console.log('Actual desktop text:',await de("document.querySelector('#text').value"));
 check('phone draft produces exact Latin and Tamil text on X11 desktop',await de(`document.querySelector('#text').value===${JSON.stringify(text)}`));
 check('desktop receives trusted native key events',await de('keyEvents.length>0&&keyEvents.every(e=>e.trusted)'));
 check('successful send clears the draft',await ev("document.querySelector('#keyboard-draft').value===''") );
 check('draft is not saved to localStorage',await ev(`!Object.values(localStorage).some(v=>v.includes(${JSON.stringify(text)}))`));
 await ev("document.querySelector('#keyboard-draft').value='finished';document.querySelector('#keyboard-draft').dispatchEvent(new CompositionEvent('compositionstart'))");await click('#keyboard-send');
 check('IME composition is not submitted prematurely',await ev("document.querySelector('#keyboard-status').textContent.includes('Finish composing')"));
 await ev("document.querySelector('#keyboard-draft').dispatchEvent(new CompositionEvent('compositionend'))");await click('#keyboard-send-enter');await wait("!document.querySelector('#keyboard-send-enter').disabled");await c.sleep(150);
 check('Send + Enter types the text then native newline',await de(`document.querySelector('#text').value===${JSON.stringify(text+'finished\n')}`));
 await click('[data-key-group="shortcuts"]');await click('[data-remote-key="SelectAll"]');await c.sleep(180);
 check('Select all selects actual desktop text',await de("document.querySelector('#text').selectionStart===0&&document.querySelector('#text').selectionEnd===document.querySelector('#text').value.length"));
 await click('[data-key-group="essentials"]');await click('[data-remote-key="Backspace"]');await c.sleep(160);
 check('Backspace deletes native selection',await de("document.querySelector('#text').value===''") );
 const literal='--help $(not-a-command); "quoted"';await request({text:literal});
 check('shell-looking text is typed literally, not executed',await de(`document.querySelector('#text').value===${JSON.stringify(literal)}`));
 await de('clearTarget()');await ev("Promise.all(['one','two','three'].map(text=>fetch('/api/keyboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})})))");
 check('concurrent keyboard requests do not interleave characters',await de("document.querySelector('#text').value==='onetwothree'"));
 await click('#keyboard-back');await click('#tile-mouse');await wait("document.querySelector('#screen-mouse').dataset.ready==='true'");await de("document.querySelector('#enter-target').focus();activations=0;keyEvents=[]");await click('#mouse-enter');await wait("!document.querySelector('#mouse-enter').disabled");await c.sleep(120);
 check('mousepad Enter actually activates focused desktop button',await de("activations===1&&keyEvents.some(e=>e.key==='Enter'&&e.trusted)"));
 await click('#mouse-keyboard');await click('#keyboard-back');await wait("document.querySelector('#screen-mouse').dataset.ready==='true'");check('keyboard returns to connected mousepad',await ev("!document.querySelector('#screen-mouse').hidden"));
 await click('#mouse-back');await ev('window.__pd.openRemote()');await wait('window.__pd.state.session?.connected');
 await ev("window.rfbKeys=[];const original=__pd.state.session.rfb.sendKey.bind(__pd.state.session.rfb);__pd.state.session.rfb.sendKey=(...args)=>{rfbKeys.push(args);return original(...args)}");
 await click('#btn-more');await click('[data-action="keyboard-page"]');await ev("rfbKeys=[];document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',bubbles:true}));document.body.dispatchEvent(new KeyboardEvent('keyup',{key:'z',code:'KeyZ',bubbles:true}))");
 check('hidden remote session does not forward keyboard-workspace keys',await ev('rfbKeys.length===0'));
 await ev("document.querySelector('#keyboard-draft').value='keep me';window.realFetch=fetch;window.fetch=(url,...args)=>url==='/api/keyboard'?Promise.resolve(new Response(JSON.stringify({ok:false,error:'Test unavailable'}),{status:503,headers:{'Content-Type':'application/json'}})):realFetch(url,...args)");await click('#keyboard-send');await wait("!document.querySelector('#keyboard-send').disabled");
 check('failed submission keeps draft and explains failure',await ev("document.querySelector('#keyboard-draft').value==='keep me'&&document.querySelector('#keyboard-status').textContent.includes('kept')"));await ev('window.fetch=realFetch');
 check('no browser exceptions',errors.length===0);console.log(`${passed} passed, 0 failed`);
 }finally{phone.close();browser.close();desktop.close();}
})().catch(e=>{console.error(e);process.exit(1)});
