'use strict';
/** Standalone X11 keyboard. No shell interpolation, arbitrary key commands,
 * clipboard replacement or saved text. Serialize complete strokes/text batches. */
const vnc = require('./vnc');
const {execFile}=require('child_process');
const path=require('path');
const KEYS = Object.freeze({
  Enter:'Return', Tab:'Tab', Backspace:'BackSpace', Escape:'Escape', Delete:'Delete',
  Space:'space', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right',
  Home:'Home', End:'End', PageUp:'Prior', PageDown:'Next',
  Copy:'ctrl+c', Paste:'ctrl+v', Cut:'ctrl+x', SelectAll:'ctrl+a', Undo:'ctrl+z', Redo:'ctrl+shift+z',
});
let queue=Promise.resolve(), pending=0;
function validate(body) {
  if(!body || typeof body!=='object')throw Error('Keyboard request is required');
  if(body.text!==undefined && (typeof body.text!=='string' || body.text.length>1024 || body.text.includes('\0')))throw Error('Text must be at most 1024 characters and contain no null bytes');
  if(body.key!==undefined && (typeof body.key!=='string'||!Object.hasOwn(KEYS,body.key)))throw Error('Unsupported keyboard key');
  if(!body.text && !body.key)throw Error('Enter text or select a key');
  return {text:body.text||'', key:body.key||null};
}
async function execute(body) {
  const session=vnc.detectSession();
  if(session.wayland)return {ok:false,error:'Standalone keyboard requires an X11 desktop. Wayland injection is not supported.'};
  // Service environments can inherit the POSIX locale, which truncates UTF-8 typing.
  const env={...process.env,DISPLAY:session.display,LC_ALL:'C.UTF-8'};if(session.xauth)env.XAUTHORITY=session.xauth;
  if(body.text){
    let result;
    if(/[^\x00-\x7f]/.test(body.text)){
      // Hold temporary Unicode mappings stable until applications consume them.
      result=await new Promise(resolve=>{
        const child=execFile('python3',[path.join(__dirname,'keyboard-text.py')],{env,timeout:15000,maxBuffer:4096},err=>resolve({ok:!err}));
        child.stdin.on('error',()=>{});child.stdin.end(body.text);
      });
    }else result=await vnc.run('xdotool',['type','--clearmodifiers','--delay','3','--',body.text],{env,timeout:10000});
    if(!result.ok)return {ok:false,error:'Could not finish typing on the X11 desktop. Check xdotool and the desktop session; some text may already have arrived, so check the PC before retrying.'};
  }
  if(body.key){const r=await vnc.run('xdotool',['key','--clearmodifiers',KEYS[body.key]],{env,timeout:4000});if(!r.ok)return {ok:false,error:'Could not send the key. Check xdotool and the desktop session; if text was included, it may already have arrived.'};}
  return {ok:true,characters:body.text.length,key:body.key};
}
function send(body) {
  let clean;try{clean=validate(body);}catch(e){return Promise.resolve({ok:false,status:400,error:e.message});}
  if(pending>=16)return Promise.resolve({ok:false,status:429,error:'Keyboard busy; wait for the current text to finish.'});
  pending++;
  const task=queue.then(()=>execute(clean)).catch(()=>({ok:false,error:'Keyboard input failed; check the desktop session.'}));
  queue=task.finally(()=>pending--);
  return task;
}
module.exports={send,validate,KEYS};
