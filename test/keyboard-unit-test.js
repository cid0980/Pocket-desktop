#!/usr/bin/env node
// Backend failure/queue tests with a fake xdotool runner; no desktop input.
const assert=require('assert/strict'),vnc=require('../lib/vnc'),keyboard=require('../lib/keyboard');
(async()=>{
 let passed=0;const check=(name,ok)=>{assert.ok(ok,name);console.log('PASS '+name);passed++;};
 const original={detect:vnc.detectSession,run:vnc.run};let calls=[],active=0,maxActive=0;
 vnc.detectSession=()=>({display:':99',wayland:false});
 vnc.run=async(cmd,args,options)=>{active++;maxActive=Math.max(maxActive,active);calls.push({cmd,args,options});await new Promise(r=>setTimeout(r,2));active--;return {ok:true};};
 try{
 const literal='--help $(literal); "quotes"';let r=await keyboard.send({text:literal,key:'Enter'});
 check('literal text and Enter succeed',r.ok&&r.characters===literal.length);
 check('literal text is one execFile argument after --',calls[0].args.at(-1)===literal&&calls[0].args.at(-2)==='--');
 check('Enter is a separate ordered allowlisted command',calls[1].args.join(' ')==='key --clearmodifiers Return');
 check('service locale explicitly supports UTF-8',calls[0].options.env.LC_ALL==='C.UTF-8');
 calls=[];const jobs=Array.from({length:16},()=>keyboard.send({key:'ArrowLeft'}));r=await keyboard.send({key:'Enter'});
 check('request queue has a bounded limit',!r.ok&&r.status===429);await Promise.all(jobs);
 check('keyboard requests execute serially',maxActive===1&&calls.length===16);
 r=await keyboard.send({key:'Escape'});check('queue recovers after draining',r.ok);
 calls=[];vnc.detectSession=()=>({wayland:true});r=await keyboard.send({key:'Enter'});check('Wayland fails clearly without invoking tools',!r.ok&&r.error.includes('X11')&&!calls.length);
 vnc.detectSession=()=>({display:':99',wayland:false});vnc.run=async()=>({ok:false});r=await keyboard.send({text:'private draft',key:'Enter'});check('tool failure exposes no submitted text',!r.ok&&!r.error.includes('private draft')&&r.error.includes('check the PC'));
 console.log(`${passed} passed, 0 failed`);
 }finally{vnc.detectSession=original.detect;vnc.run=original.run;}
})().catch(e=>{console.error(e);process.exit(1)});
