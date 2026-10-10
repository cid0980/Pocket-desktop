/* Navigation/presentation only. Mouse and gamepad input stay in their existing modules. */
export function settingsNavigation({onAction,onClose}) {
  const $=s=>document.querySelector(s), root=$('#sheet-settings');
  const names={display:'Remote screen',mouse:'Mouse pad',gamepad:'Gamepad',keyboard:'Keyboard & voice',motion:'Phone motion',device:'This device',connection:'Privacy & access',help:'Help & diagnostics'};
  // Keep original control IDs/listeners when moving advanced options into categories.
  $('#mouse-timing-settings').append($('#mouse-tap-interval').closest('label'),$('#mouse-preference-status'));
  const motion=$('.mouse-motion-settings');motion.open=true;$('#motion-settings-content').append(motion);
  $('#gamepad-aim-settings').append($('#pad-sens').closest('label'));
  $('#pad-panel')?.remove();
  const speedLabel=document.createElement('label');speedLabel.className='field';
  speedLabel.innerHTML='<span>Pointer speed <output id="settings-speed-value"></output></span><input id="settings-mouse-speed" type="range" min="0.2" max="2" step="0.05"><small>Slow 0.20× · Fast 2.00×. Scroll speed is separate.</small>';
  $('#mouse-speed-settings').append(speedLabel);
  const source=$('#mouse-speed'),mirror=$('#settings-mouse-speed');
  const sync=()=>{mirror.value=source.value;$('#settings-speed-value').textContent=Number(source.value).toFixed(2)+'×';};
  source.addEventListener('input',sync);mirror.addEventListener('input',()=>{source.value=mirror.value;source.dispatchEvent(new Event('input',{bubbles:true}));});sync();
  function select(category=null) {
    if(category&&!Object.hasOwn(names,category))category=null;
    $('#settings-heading').textContent=names[category]||'Settings';
    $('#settings-categories').hidden=!!category;$('#settings-back').hidden=!category;
    root.querySelectorAll('[data-category-panel]').forEach(el=>el.hidden=el.dataset.categoryPanel!==category);
    $('#settings-save-bar').hidden=!['display','keyboard','device','connection'].includes(category);
    root.dataset.category=category||'index';sync();
    root.querySelector('.settings-body').scrollTop=0;
    requestAnimationFrame(()=>{if(!root.hidden)(category?$('#settings-back'):root.querySelector('[data-category]')).focus({preventScroll:true});});
  }
  root.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>select(b.dataset.category)));
  $('#settings-back').addEventListener('click',()=>select());
  root.querySelectorAll('[data-workspace]').forEach(b=>b.addEventListener('click',()=>onAction(b.dataset.workspace)));
  root.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(root.dataset.category!=='index')select();else onClose();}
    if(e.key!=='Tab')return;
    const focusable=[...root.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
    if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
  return {select};
}

export function keyboardWorkspace({send,onBack,onSettings}) {
  const $=s=>document.querySelector(s),draft=$('#keyboard-draft'),status=$('#keyboard-status');let composing=false;
  const count=()=>$('#keyboard-count').textContent=`${draft.value.length} / 1024`;
  draft.addEventListener('input',count);draft.addEventListener('compositionstart',()=>composing=true);draft.addEventListener('compositionend',()=>{composing=false;count();});
  async function submit(enter) {
    if(composing){status.textContent='Finish composing your text before sending.';return;}
    const text=draft.value;if(!text){status.textContent='Type something first, or use an individual key below.';draft.focus();return;}
    const buttons=[$('#keyboard-send'),$('#keyboard-send-enter')];buttons.forEach(b=>b.disabled=true);status.textContent='Sending text to the PC…';
    try {
      await send({text,...(enter?{key:'Enter'}:{})});
      if(draft.value===text)draft.value='';else if(draft.value.startsWith(text))draft.value=draft.value.slice(text.length);
      count();status.textContent=`Sent ${text.length} characters${enter?' + Enter':''}.`;
    }catch(e){status.textContent=e.message+' Your draft has been kept.';}
    finally{buttons.forEach(b=>b.disabled=false);}
  }
  $('#keyboard-send').addEventListener('click',()=>submit(false));$('#keyboard-send-enter').addEventListener('click',()=>submit(true));
  $('#keyboard-back').addEventListener('click',onBack);$('#keyboard-settings').addEventListener('click',onSettings);
  document.querySelectorAll('[data-remote-key]').forEach(button=>button.addEventListener('click',async()=>{
    button.disabled=true;try{await send({key:button.dataset.remoteKey});status.textContent=button.textContent.trim()+' sent to PC';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}
  }));
  const tabs=[...document.querySelectorAll('[data-key-group]')];
  const select=button=>{tabs.forEach(b=>{b.setAttribute('aria-selected',String(b===button));b.tabIndex=b===button?0:-1;});document.querySelectorAll('[data-key-panel]').forEach(p=>p.hidden=p.dataset.keyPanel!==button.dataset.keyGroup);};
  tabs.forEach((b,i)=>{b.addEventListener('click',()=>select(b));b.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];select(next);next.focus();});});select(tabs[0]);
}
