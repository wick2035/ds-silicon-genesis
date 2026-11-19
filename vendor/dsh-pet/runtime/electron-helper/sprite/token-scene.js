// Shared rendering and gesture recognition for the home stage and native desktop.
function tokenShakeSample(s, x, y, now) {
  if (!s) return {startX:x,startY:y,peakX:x,peakY:y,peakAt:now,drop:false};
  const dx=s.peakX-s.startX,dy=s.peakY-s.startY,length=Math.hypot(dx,dy);
  const backtrack=length ? ((s.peakX-x)*dx+(s.peakY-y)*dy)/length : 0;
  if(length>=24 && backtrack>=7)
    return {startX:s.peakX,startY:s.peakY,peakX:x,peakY:y,peakAt:now,drop:now-s.peakAt<450};
  if(Math.hypot(x-s.startX,y-s.startY)>=length)
    return {...s,peakX:x,peakY:y,peakAt:now,drop:false};
  return {...s,drop:false};
}
// Desktop coordinates, independent of the pet's position and transform.
function tokenFloorLayout(coins, areas, view) {
  const placed=[],gap=54,pad=28,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  return coins.map(coin=>{
    const px=coin.x*view.w,py=coin.y*view.h;
    const area=areas.reduce((best,a)=>{const distance=Math.hypot(px-clamp(px,a.x,a.x+a.width),py-clamp(py,a.y,a.y+a.height));return !best||distance<best.distance?{...a,distance}:best;},null);
    const left=area.x+pad,right=Math.max(left,area.x+area.width-pad),top=area.y+pad,bottom=Math.max(top,area.y+area.height-pad);
    const anchor=clamp(px,left,right),ground=clamp(py,top,bottom);let point;
    const columns=Math.max(1,Math.floor((right-left)/gap)+1),rows=Math.max(1,Math.floor((bottom-top)/gap)+1),candidates=[];
    candidates.push({x:anchor,y:ground});
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++)candidates.push({x:left+column*gap,y:bottom-row*gap});
    candidates.sort((a,b)=>Math.hypot(a.x-anchor,a.y-ground)-Math.hypot(b.x-anchor,b.y-ground));
    point=candidates.find(p=>placed.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>=gap-1))||candidates[0];placed.push(point);
    return {id:coin.id,x:point.x/view.w,y:point.y/view.h};
  });
}
function createTokenScene(options) {
  const host=options.host, nodes=new Map(), abort=new AbortController(),native=options.surface==='desktop';
  let overlayTimer,noteTimer,noticeUntil=0,lastAnnouncement='';
  let stopped=false, timer, heartbeat, sample, lastDrop=-Infinity, queue=[], processing=false, mutations=0, tokens=null, dragging=false, space=false,readEpoch=0,lastError='';
  let nativeSpace,fallFrame,droppedAtGrab;
  const layer=document.createElement('div');layer.className='pet-token-layer';layer.setAttribute('aria-label','地上的饭钱');host.append(layer);
  const status=document.createElement('div');status.className='pet-token-status';status.hidden=native;
  const balance=document.createElement('span'), hint=document.createElement('span'), retry=document.createElement('button');
  balance.className='pet-token-balance';hint.className='pet-token-hint';hint.textContent='空格 + 拖动晃出饭钱 · 每片 100';retry.type='button';retry.textContent='去捡回来';retry.hidden=true;
  status.append(balance,hint,retry);host.append(status);
  const note=document.createElement('p');note.className='pet-token-note';note.setAttribute('role','status');host.append(note);
  const url=options.base+'/humanity/companion/tokens?pet='+encodeURIComponent(options.petId);
  const scene={get tokens(){return tokens;},get dragging(){return dragging;},get space(){return nativeSpace??space;},nodes};
  function updateSpace(pressed, physical=false) {
    const wasPressed=scene.space;
    if(physical)nativeSpace=pressed;
    else space=pressed;
    if(wasPressed!==scene.space)sample=null;
    paintOverlay();
  }
  scene.setNativeSpace=pressed=>updateSpace(pressed,true);
  function paintOverlay(){
    if(!native||stopped)return;
    const wasHidden=status.hidden;
    status.hidden=!(dragging||scene.space&&options.isHovered?.()||Date.now()<noticeUntil||status.contains(document.activeElement)&&document.activeElement.matches(':focus-visible'));
    if(status.hidden&&!note.textContent){if(!wasHidden)options.onOverlay?.();return;}
    const area=options.overlayArea?.()||{x:0,y:0,width:innerWidth,height:innerHeight};
    const left=Math.max(0,area.x)+8,top=Math.max(0,area.y)+8,right=Math.min(innerWidth,area.x+area.width)-8,bottom=Math.min(innerHeight,area.y+area.height)-8;
    const fits=right-left>=144&&bottom-top>=64;note.hidden=!fits;
    if(!fits){status.hidden=true;options.onOverlay?.();return;}
    const anchor=options.overlayAnchor?.()||{x:(left+right)/2,y:bottom};
    for(const el of [status,note]){el.style.maxWidth=Math.min(420,right-left)+'px';el.style.maxHeight=(bottom-top)+'px';}
    const statusHeight=status.hidden?0:status.offsetHeight,gap=statusHeight&&note.textContent?6:0;
    note.style.maxHeight=Math.max(0,Math.min(96,bottom-top-statusHeight-gap))+'px';
    const total=statusHeight+gap+(note.textContent?note.offsetHeight:0),y=Math.max(top,Math.min(bottom-total,anchor.y-total-10));
    const place=(el,y)=>{el.style.left=Math.max(left,Math.min(right-el.offsetWidth,anchor.x-el.offsetWidth/2))+'px';el.style.top=y+'px';};
    if(!status.hidden)place(status,y);
    if(note.textContent)place(note,y+statusHeight+gap);
    if(wasHidden!==status.hidden)options.onOverlay?.();
  }
  function flash(){if(!native||stopped)return;noticeUntil=Date.now()+4000;clearTimeout(overlayTimer);overlayTimer=setTimeout(paintOverlay,4050);paintOverlay();}
  const announce=text=>{
    if(native&&text===lastAnnouncement)return;lastAnnouncement=text;clearTimeout(noteTimer);note.textContent=text;
    if(native&&text){flash();noteTimer=setTimeout(()=>{note.textContent='';paintOverlay();},4000);}paintOverlay();
  };
  function paint() {
    const now=performance.now();
    let falling=false;
    for(const entry of nodes.values()) {
      const p=options.point(entry.coin.x,entry.coin.y);entry.el.style.left=p.x+'px';entry.el.style.top=p.y+'px';
      if(entry.fallStart!==undefined){
        const t=Math.min(1,(now-entry.fallStart)/620);
        const from=options.point(entry.coin.fromX,entry.coin.fromY);
        entry.el.style.transform=t<1?`translate(${(from.x-p.x)*(1-t)}px,${(from.y-p.y)*(1-t*t)}px)`:'';
        if(t<1)falling=true;else delete entry.fallStart;
      }
    }
    if(falling && fallFrame===undefined)fallFrame=requestAnimationFrame(()=>{fallFrame=undefined;paint();options.onOverlay?.();});
    paintOverlay();
  }
  function sync(data) {
    if(stopped||data.version<tokens?.version)return;
    const previous=tokens;
    const previousFloor=previous?.coins.filter(c=>c.surface===options.surface).length||0;tokens=data;options.onState?.(data);
    balance.textContent='饭钱 '+(data.balance||0).toLocaleString('zh-CN')+' token';
    hint.textContent=dragging&&data.dropped>droppedAtGrab?'钱掉出来了，松手让她去捡':data.thinking?'正在想办法捡回来…':'空格 + 拖动晃出饭钱 · 每片 100';
    retry.hidden=!data.coins.some(c=>c.surface===options.surface)||data.thinking||dragging;
    if(data.error&&data.error!==lastError){announce(data.error);lastError=data.error;}else if(!data.error&&lastError){announce('');lastError='';}
    const floor=data.coins.filter(c=>c.surface===options.surface).map(c=>({...c}));
    if(previousFloor!==floor.length)flash();
    const view=options.viewport?.()||{w:innerWidth,h:innerHeight};
    const layout=tokenFloorLayout(floor,options.workAreas?.()||[{x:0,y:0,width:view.w,height:view.h}],view);
    const changed=layout.filter(p=>{const c=floor.find(c=>c.id===p.id);return Math.abs(c.x-p.x)>.0001||Math.abs(c.y-p.y)>.0001;});
    if(changed.length){for(const p of changed)Object.assign(floor.find(c=>c.id===p.id),p);void safePost('layout',{positions:changed});}
    for(const [id,entry] of nodes)if(!floor.some(c=>c.id===id)){entry.el.remove();nodes.delete(id);}
    for(const coin of floor) {
      if(nodes.has(coin.id)){nodes.get(coin.id).coin=coin;continue;}
      const el=document.createElement('button');el.type='button';el.className='pet-token-coin';el.dataset.coin=coin.id;el.title='收走 100 token';el.setAttribute('aria-label','收走这片 100 token，饭钱归爸爸');
      const face=document.createElement('span');face.className='pet-token-face';face.textContent='100';el.append(face);layer.append(el);nodes.set(coin.id,{el,coin});
      const collect=async e=>{
        e.stopPropagation();if(e.type==='pointerdown'&&e.button!==0||el.disabled)return;el.disabled=true;el.style.visibility='hidden';options.onOverlay?.();
        try{const d=await post('collect',{id:coin.id});announce(d.result?.status==='collected'?'已收走 100 token':'这片钱已经被她捡回了');}
        catch(error){el.disabled=false;el.style.visibility='';announce(error.message);}
        finally{if(tokens)sync(tokens);}
      };
      // Take the coin on press; a pet/window move between down and up cannot eat the click.
      el.addEventListener('pointerdown',collect);el.addEventListener('click',collect);
      if((previous||Date.now()-coin.ts<1800)&&Number.isFinite(coin.fromX)&&Number.isFinite(coin.fromY)&&!matchMedia('(prefers-reduced-motion: reduce)').matches)
        nodes.get(coin.id).fallStart=performance.now();
    }
    paint();options.onLayout?.();options.onOverlay?.();
  }
  async function request(body) {
    const epoch=readEpoch;
    if(body && options.surface==='desktop'){const d=await window.petBridge.reportInteraction('tokens',{...body,surface:'desktop'});if(!d.ok)throw Error(d.message||'饭钱未能同步，请重试');sync(d.tokens);return d;}
    const r=await fetch(url,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,surface:options.surface})}:{}),cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(35000)])});
    const d=await r.json();if(!r.ok||!d.ok)throw Error(d.message||'饭钱未能同步，请重试');
    if(body||Number.isSafeInteger(d.tokens?.version)||epoch===readEpoch)sync(d.tokens);
    return d;
  }
  async function drain() {
    if(processing)return;processing=true;
    try{while(queue.length){const item=queue.shift();try{if(stopped)throw Error('活动空间已关闭');item.resolve(await request({action:item.action,...item.body}));}catch(error){item.reject(error);}finally{mutations--;}}}
    finally{processing=false;}
  }
  function post(action,body={}) {
    mutations++;readEpoch++;
    const pending=new Promise((resolve,reject)=>{const item={action,body,resolve,reject};if(action==='collect')queue.unshift(item);else queue.push(item);});
    void drain();return pending;
  }
  const safePost=(action,body)=>post(action,body).catch(e=>{if(!stopped)announce(e.message);});
  scene.begin=(x,y)=>{
    if(dragging)return;dragging=true;droppedAtGrab=tokens?.dropped??0;sample=tokenShakeSample(null,x,y,performance.now());announce('');flash();
    void safePost('hold');heartbeat=setInterval(()=>void safePost('hold'),2000);options.onHold?.(true);
  };
  scene.sample=(x,y)=>{
    if(!dragging||!scene.space)return;const now=performance.now();sample=tokenShakeSample(sample,x,y,now);
    if(sample.drop&&now-lastDrop>260){lastDrop=now;const g=options.geometry();
      const spread=(Math.random()-.5)*.22,fromX=Math.max(.03,Math.min(.97,g.x)),fromY=Math.max(.03,Math.min(.97,g.y));
      void safePost('drop',{key:crypto.randomUUID(),x:Math.max(.045,Math.min(.955,fromX+spread)),y:g.floorY,fromX,fromY});
    }
  };
  scene.release=()=>{if(!dragging)return;dragging=false;sample=null;clearInterval(heartbeat);options.onHold?.(false);flash();void safePost('release');};
  scene.post=post;scene.paint=paint;scene.announce=announce;
  retry.addEventListener('click',()=>{retry.disabled=true;void post('recover').catch(e=>announce(e.message)).finally(()=>retry.disabled=false);});
  const typing=e=>e.target?.closest?.('input,textarea,[contenteditable=true]');
  window.addEventListener('keydown',e=>{if(e.code==='Space'&&!typing(e)){updateSpace(true);if(dragging||options.isHovered?.())e.preventDefault();}},{signal:abort.signal});
  window.addEventListener('keyup',e=>{if(e.code==='Space')updateSpace(false);},{signal:abort.signal});
  window.addEventListener('blur',()=>{updateSpace(false);if(!native){scene.setNativeSpace(undefined);scene.release();}},{signal:abort.signal});
  window.addEventListener('resize',paint,{signal:abort.signal});
  // A committed drop can be read even while its IPC reply is delayed.
  async function poll(){try{if(native||!mutations)await request();}catch(e){if(!stopped)announce(e.message);}finally{if(!stopped)timer=setTimeout(poll,900);}}
  void poll();
  status.addEventListener('focusout',()=>queueMicrotask(()=>{flash();}));
  scene.dispose=()=>{if(stopped)return;if(dragging)void fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'release',surface:options.surface}),keepalive:true}).catch(()=>{});stopped=true;abort.abort();cancelAnimationFrame(fallFrame);clearTimeout(timer);clearTimeout(overlayTimer);clearTimeout(noteTimer);clearInterval(heartbeat);layer.remove();status.remove();note.remove();nodes.clear();};
  return scene;
}
const PET_TOKEN_CSS=`
.pet-token-layer{position:absolute;inset:0;z-index:8;pointer-events:none;overflow:visible}
.pet-token-coin{position:absolute;display:grid;place-items:center;width:52px;height:52px;margin:-26px 0 0 -26px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;touch-action:manipulation}
.pet-token-face{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;border:2px solid #174f86;background:#b9e4ff;color:#123d6a;font:700 10px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:inset 0 0 0 2px #e6f6ff,0 3px 0 #407ab0,0 5px 5px #122d4d30;transition:filter 120ms,scale 120ms}
.pet-token-coin:hover .pet-token-face{filter:brightness(1.12);scale:1.1}.pet-token-coin:active .pet-token-face{scale:.9}.pet-token-coin:focus-visible{outline:2px solid #1764a5;outline-offset:1px;border-radius:50%}.pet-token-coin:disabled{cursor:wait;opacity:.55}
.pet-token-status{position:absolute;z-index:10;bottom:42px;left:12px;display:flex;align-items:center;gap:9px;max-width:calc(100% - 24px);padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#19334b);font:11px/1.5 system-ui,'Microsoft YaHei',sans-serif;pointer-events:none}
.pet-token-balance{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.pet-token-hint{color:var(--dsw-alias-label-secondary,#52647c)}
.pet-token-status button{pointer-events:auto;font:inherit;color:inherit;border:0;border-radius:4px;padding:3px 7px;background:var(--dsw-alias-bg-multi-select,#e6edf7);cursor:pointer;white-space:nowrap}.pet-token-status button:hover{background:#c8e1f5}.pet-token-status button:focus-visible{outline:2px solid #1764a5;outline-offset:2px}.pet-token-status button:disabled{opacity:.5;cursor:wait}.pet-token-status button[hidden]{display:none}
.pet-token-note{position:absolute;z-index:11;top:48px;right:12px;max-width:48%;font:11px/1.5 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#19334b);background:var(--dsw-alias-bg-base,#fff);border-radius:6px;padding:5px 8px;pointer-events:none}.pet-token-note:empty{display:none}
.pet-token-grip{position:absolute;z-index:6;left:35%;width:30%;top:9%;bottom:0;border:0;background:transparent;cursor:grab;touch-action:none}.pet-token-grip:focus-visible{outline:2px solid #1764a5;outline-offset:4px;border-radius:12px}.pet-token-held{rotate:180deg;cursor:grabbing}
.pet-token-native .pet-token-layer{position:fixed;overflow:hidden}.pet-token-native .pet-token-status,.pet-token-native .pet-token-note{position:absolute;top:0;bottom:auto;left:0;right:auto;box-sizing:border-box;overflow:hidden;overflow-wrap:anywhere;margin:0}.pet-token-native .pet-token-status{flex-wrap:wrap;white-space:normal}.pet-token-native .pet-token-status[hidden]{display:none!important}.pet-token-native .pet-token-note{max-width:420px}.pet-token-native .pet-token-note:empty{display:none}
@media(max-width:680px){.pet-token-hint{display:none}.pet-token-status{bottom:39px;left:8px;padding:3px 6px}.pet-token-note{top:42px;max-width:65%}}
@media(prefers-reduced-motion:reduce){.pet-token-held{rotate:0deg}.pet-token-face{transition:filter 100ms}}
`;
