/* Local screenshot viewer. Gestures never send desktop input. */
export function screenshotViewer(root) {
  const stage=root.querySelector('#shot-stage'),img=root.querySelector('#shot-img'),label=root.querySelector('#shot-zoom');
  let zoom=1,base=1,x=0,y=0,ready=false,lastTap=null;
  const points=new Map();
  const buttons=[...root.querySelectorAll('[data-shot-view]')];
  const max=()=>Math.max(8,1/base);
  function render(){
    const w=stage.clientWidth,h=stage.clientHeight;
    const bx=Math.max(0,(img.naturalWidth*base*zoom-w)/2),by=Math.max(0,(img.naturalHeight*base*zoom-h)/2);
    x=Math.max(-bx,Math.min(bx,x));y=Math.max(-by,Math.min(by,y));
    img.style.transform=`translate(-50%,-50%) translate(${x}px,${y}px) scale(${base*zoom})`;
    label.textContent=ready?Math.round(base*zoom*100)+'%':'—';
    buttons.forEach(b=>b.disabled=!ready||(b.dataset.shotView==='out'&&zoom<=1)||(b.dataset.shotView==='in'&&zoom>=max()));
    stage.classList.toggle('zoomed',ready&&zoom>1);
  }
  function fit(){zoom=1;x=y=0;lastTap=null;render();}
  function change(value,anchor={x:0,y:0}){
    if(!ready)return;
    const next=Math.max(1,Math.min(max(),value)),ratio=next/zoom;
    x=anchor.x+(x-anchor.x)*ratio;y=anchor.y+(y-anchor.y)*ratio;zoom=next;render();
  }
  function measure(){if(!ready||!stage.clientWidth||!stage.clientHeight)return;base=Math.min(stage.clientWidth/img.naturalWidth,stage.clientHeight/img.naturalHeight,1);render();}
  function local(e){const r=stage.getBoundingClientRect();return{x:e.clientX-r.left-r.width/2,y:e.clientY-r.top-r.height/2};}
  function geometry(){const a=[...points.values()];return {x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2,d:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)};}
  stage.addEventListener('pointerdown',e=>{
    if(!ready||(e.pointerType==='mouse'&&e.button!==0))return;
    const p=local(e);points.set(e.pointerId,{...p,startX:p.x,startY:p.y,moved:false,time:performance.now()});
    if(points.size>1){points.forEach(p=>p.moved=true);lastTap=null;}
    stage.setPointerCapture(e.pointerId);stage.focus({preventScroll:true});e.preventDefault();
  });
  stage.addEventListener('pointermove',e=>{
    const p=points.get(e.pointerId);if(!p)return;e.preventDefault();
    const before=points.size===2?geometry():null,next=local(e),dx=next.x-p.x,dy=next.y-p.y;
    if(Math.hypot(next.x-p.startX,next.y-p.startY)>6)p.moved=true;
    Object.assign(p,next);
    if(points.size===1){x+=dx;y+=dy;render();}
    else if(points.size===2){const after=geometry();if(before.d>1)change(zoom*after.d/before.d,before);x+=after.x-before.x;y+=after.y-before.y;render();}
  });
  function end(e){
    const p=points.get(e.pointerId);if(!p)return;
    if(e.type==='pointerup'&&points.size===1&&!p.moved&&performance.now()-p.time<300){
      const now=performance.now();if(lastTap&&now-lastTap.time<320&&Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<32){zoom>1?fit():change(2,p);lastTap=null;}else lastTap={x:p.x,y:p.y,time:now};
    }else lastTap=null;
    points.delete(e.pointerId);
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,end);
  stage.addEventListener('wheel',e=>{if(!ready)return;e.preventDefault();change(zoom*Math.exp(-Math.max(-100,Math.min(100,e.deltaY))*.005),local(e));},{passive:false});
  stage.addEventListener('keydown',e=>{
    if(!ready)return;
    if(['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))e.preventDefault();
    if(e.key==='+'||e.key==='=')change(zoom*1.5);else if(e.key==='-')change(zoom/1.5);else if(e.key==='0')fit();
    else if(e.key.startsWith('Arrow')){x+=e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0;y+=e.key==='ArrowUp'?40:e.key==='ArrowDown'?-40:0;render();}
  });
  buttons.forEach(b=>b.addEventListener('click',()=>{const action=b.dataset.shotView;if(action==='fit')fit();else change(action==='actual'?1/base:action==='in'?zoom*1.5:zoom/1.5);}));
  root.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();root.querySelector('[data-close-sheet]').click();}
    if(e.key==='Tab'){const items=[...root.querySelectorAll('button,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  });
  img.addEventListener('dragstart',e=>e.preventDefault());stage.addEventListener('contextmenu',e=>e.preventDefault());
  new ResizeObserver(measure).observe(stage);
  window.addEventListener('blur',()=>{points.clear();lastTap=null;});
  render();
  return {loaded(){ready=true;zoom=1;x=y=0;measure();stage.focus({preventScroll:true});},clear(){ready=false;points.clear();lastTap=null;img.hidden=true;img.removeAttribute('src');zoom=1;x=y=0;render();}};
}
