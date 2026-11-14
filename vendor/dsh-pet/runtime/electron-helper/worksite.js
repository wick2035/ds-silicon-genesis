'use strict';
(() => {
  const $=id=>document.getElementById(id),worker=$('worker'),art=$('work-art'),idle=$('idle'),scene=$('scene');
  let latest=null,position=.5,running=null,drag=null,polling=false,stopped=false;
  const clamp=n=>Math.max(.08,Math.min(.92,n));
  function place(){worker.style.left=(position*100)+'%';}
  function bricks(id,n){const root=$(id);root.replaceChildren();for(let i=0;i<Math.min(12,Math.max(0,n));i++){const b=document.createElement('i');b.className='brick';root.append(b);}}
  function render(s){
    const wasInside=latest?.location?.inside===true;latest=s;const c=s.labor?.current,inside=s.location?.inside===true;
    if(inside&&!wasInside)$('feedback').textContent='';
    const speech=s.location?.speech,showSpeech=inside&&speech?.action==='enter-forced'&&Date.now()-speech.at<12000;$('speech').hidden=!showSpeech;if(showSpeech)$('speech').textContent=speech.text;
    worker.hidden=!inside;$('release').hidden=!inside;
    $('state').textContent=inside?(s.location.forced?'爸爸把她放进来了，等爸爸接她出去':'她自己走进了工地'):'工地空着，等她来';
    $('headline').textContent=!inside?'工地已经打开':c?.status==='working'?'她正在安排自己的工作':c?.status==='paused'?'她在工地歇一会儿':c?.status==='unpaid'?'砖都搬好了':'她在工地里';
    $('detail').textContent=!inside?'可以从桌面把她拖到这个窗口；她也会自己决定来工作。':s.location.forced?'你可以拖动她，或者点“接她出去”。':c?.status==='unpaid'?'等爸爸手动结算工钱。':'拖动她会打断当前动作，她会记得你的操作。';
    const total=c?.trips||0,done=c?.done||0;$('remaining').textContent=total?Math.max(0,total-done-(c.carrying?1:0)):'—';$('done').textContent=total?done:'—';$('count').textContent=total?`已放好 ${done} / ${total} 趟`:'等待工作约定';$('progress').max=total||1;$('progress').value=done;
    bricks('left-bricks',total-done-(c?.carrying?1:0));bricks('right-bricks',done);
    if(!running&&!drag){art.hidden=!c?.carrying;idle.hidden=!!c?.carrying;if(c?.carrying)art.src='../../assets/labor-carry.png';}
    place();
  }
  function stop(){if(running)running.abort.abort();}
  function valid(cmd){const w=latest?.world?.command;return !stopped&&!document.hidden&&latest?.location?.inside&&w?.id===cmd.id&&w.index===cmd.index&&['queued','running'].includes(w.status)&&!drag;}
  async function execute(cmd){
    const task={abort:new AbortController(),cmd};running=task;let frame;
    const post=(status,extra={})=>window.worksite.receipt({id:cmd.id,index:cmd.index,surface:'web',status,...extra});
    try{
      const hasArt=cmd.index===1||latest?.labor?.current?.carrying===true;
      art.hidden=!hasArt;idle.hidden=hasArt;
      if(hasArt){art.src=cmd.index===1?'../../assets/labor-lift.png':'../../assets/labor-carry.png';await art.decode();if(!art.naturalWidth)throw Error('工地动作未显示');}
      else {await idle.play();if(idle.readyState<2)throw Error('工地动作未显示');}
      if(!valid(cmd))throw Error('工地动作未显示');
      await post('playing');worker.classList.add('walking');
      await new Promise((resolve,reject)=>{
        const from=position,to=cmd.index===0?cmd.labor.x:position,duration=cmd.index===0?Math.max(1000,Math.abs(to-from)*4000):900,start=performance.now();
        task.abort.signal.addEventListener('abort',()=>reject(Error('动作被打断')),{once:true});
        const tick=now=>{if(!valid(cmd)){reject(Error('工地动作已中断'));return;}const t=Math.min(1,(now-start)/duration);position=from+(to-from)*t;place();if(t===1)resolve();else frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
      });
      const area=scene.getBoundingClientRect(),body=worker.getBoundingClientRect();if(!valid(cmd)||area.width<=0)throw Error('工地不可见');
      await post('completed',{played:true,x:(body.left+body.width/2-area.left)/area.width});
    }catch(e){await post('interrupted',{reason:e.message}).catch(()=>{});}
    finally{cancelAnimationFrame(frame);worker.classList.remove('walking');if(running===task)running=null;}
  }
  async function poll(){if(stopped||polling)return;polling=true;try{const s=await window.worksite.snapshot();render(s);if(running&&!valid(running.cmd))stop();const c=s.world?.command;if(!running&&c?.source==='labor'&&c.surface==='web'&&['queued','running'].includes(c.status)&&valid(c))void execute(c);}catch(e){$('feedback').textContent=e.message;stop();}finally{polling=false;if(!stopped)setTimeout(poll,700);}}
  worker.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,moved:false};worker.setPointerCapture(e.pointerId);});
  worker.addEventListener('pointermove',e=>{if(!drag)return;if(!drag.moved&&Math.abs(e.clientX-drag.x)>8){drag.moved=true;stop();worker.classList.add('dragging');void window.worksite.action('drag').then(render).catch(e=>{$('feedback').textContent=e.message;});}if(drag.moved){const r=scene.getBoundingClientRect();position=clamp((e.clientX-r.left)/r.width);place();}});
  worker.addEventListener('pointerup',()=>{if(!drag)return;const moved=drag.moved;drag=null;worker.classList.remove('dragging');if(!moved)void window.worksite.action('touch').then(render).catch(e=>{$('feedback').textContent=e.message;});});
  worker.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void window.worksite.action('touch').then(render).catch(e=>{$('feedback').textContent=e.message;});}});
  $('release').addEventListener('click',async()=>{const button=$('release');button.disabled=true;stop();try{render(await window.worksite.action('release'));$('feedback').textContent='她已经回到桌面。';}catch(e){$('feedback').textContent=e.message;}finally{button.disabled=false;}});
  window.worksite.notice(text=>{$('feedback').textContent=text;});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('pagehide',()=>{stopped=true;stop();});void poll();
})();
