'use strict';
(() => {
  const $=id=>document.getElementById(id),worker=$('worker'),art=$('work-art'),idle=$('idle'),scene=$('scene');
  let latest=null,position=.5,running=null,lastAttempt,drag=null,stopped=false,forcing=false,releasing=false;
  const clamp=n=>Math.max(.08,Math.min(.92,n));
  function place(){worker.style.left=(position*100)+'%';}
  function bricks(id,n){const root=$(id),count=Math.min(12,Math.max(0,n));if(root.childElementCount===count)return;root.replaceChildren();for(let i=0;i<count;i++){const b=document.createElement('i');b.className='brick';root.append(b);}}
  function render(s){
    const wasInside=latest?.location?.inside===true;latest=s;const c=s.labor?.current,inside=s.location?.inside===true;
    if(inside&&!wasInside)$('feedback').textContent='';
    const speech=s.location?.speech,showSpeech=inside&&['enter-forced','force-work','touch','drag'].includes(speech?.action)&&Date.now()-speech.at<12000;$('speech').hidden=!showSpeech;if(showSpeech)$('speech').textContent=speech.text;
    worker.hidden=!inside;$('release').hidden=!inside;$('retry-unconfirmed').hidden=!inside||!s.waitingForReceipt;$('resume-work').hidden=!inside||s.location?.workState!=='stopped'||s.waitingForReceipt;
    $('force-work').disabled=forcing;$('force-work').textContent=forcing?'正在开工…':c?.forced?'强制继续':'强制开工';$('force-work-hint').textContent='立即进工地，强制搬运';
    $('state').textContent=inside?(s.location.forced?'爸爸把她放进来了，等爸爸接她出去':'她自己走进了工地'):'工地空着，等她来';
    $('headline').textContent=!inside?'工地已经打开':s.waitingForReceipt?'这一趟的结果待确认':s.location?.workState==='stopped'?'她在工地停工了':c?.status==='working'?'她正在安排自己的工作':c?.status==='paused'?'她在工地歇一会儿':c?.status==='unpaid'?'砖都搬好了':'她在工地里';
    $('detail').textContent=!inside?'可以从桌面把她拖到这个窗口；她也会自己决定来工作。':s.waitingForReceipt?'没有确认放好，不会计入进度；你可以选择重新搬这趟。':s.location.forced?'你可以拖动她，或者点“接她出去”。':c?.status==='unpaid'?'等爸爸手动结算工钱。':'拖动她会打断当前动作，她会记得你的操作。';
    const total=c?.trips||0,done=c?.done||0;$('remaining').textContent=total?Math.max(0,total-done-(c.carrying?1:0)):'—';$('done').textContent=total?done:'—';$('count').textContent=total?`已放好 ${done} / ${total} 趟`:'等待工作约定';$('progress').max=total||1;$('progress').value=done;
    bricks('left-bricks',total-done-(c?.carrying?1:0));bricks('right-bricks',done);
    if(!running&&!drag){art.hidden=!c?.carrying;idle.hidden=!!c?.carrying;if(c?.carrying)art.src='../../assets/labor-carry.png';}
    place();
  }
  function stop(){if(running)running.abort.abort();}
  function valid(cmd){const w=latest?.world?.command;return !stopped&&!document.hidden&&latest?.location?.inside&&w?.id===cmd.id&&w.index===cmd.index&&['queued','running'].includes(w.status)&&!drag;}
  function startNext(){
    const cmd=latest?.world?.command;
    if(running||forcing||releasing||cmd?.source!=='labor'||cmd.surface!=='web'||cmd.status!=='queued'||!valid(cmd))return;
    const key=`${cmd.id}:${cmd.index}`;
    if(key!==lastAttempt){lastAttempt=key;void execute(cmd);}
  }
  function receive(s){
    render(s);
    if(running&&!valid(running.cmd))stop();
    startNext();
  }
  async function execute(cmd){
    const task={abort:new AbortController(),cmd};running=task;
    let frame,worksiteX=position,effortSeconds=0;
    const post=(status,extra={})=>window.worksite.receipt({id:cmd.id,index:cmd.index,surface:'web',status,...extra});
    const canPlay=()=>valid(cmd)&&!task.abort.signal.aborted;
    try{
      const hasArt=cmd.index===1||cmd.labor?.leg==='deliver';
      art.hidden=!hasArt;idle.hidden=hasArt;
      if(hasArt){art.src=cmd.index===1?'../../assets/labor-lift.png':'../../assets/labor-carry.png';await art.decode();if(!art.naturalWidth)throw Error('工地动作未显示');}
      else {await idle.play();if(idle.readyState<2)throw Error('工地动作未显示');}
      if(!canPlay())throw Error('工地动作未显示');
      await post('playing',{worksiteX});
      if(!canPlay())throw Error('工地动作已中断');
      worker.classList.add('walking');
      await new Promise((resolve,reject)=>{
        const from=worksiteX,to=cmd.index===0?cmd.labor.x:from,duration=cmd.index===0?1400:900,start=performance.now();
        task.abort.signal.addEventListener('abort',()=>reject(Error('动作被打断')),{once:true});
        const tick=now=>{
          if(!canPlay()){reject(Error('工地动作已中断'));return;}
          const elapsed=Math.max(0,now-start),t=Math.min(1,elapsed/duration);
          effortSeconds=elapsed/1000;position=worksiteX=from+(to-from)*t;place();
          if(t===1)resolve();else frame=requestAnimationFrame(tick);
        };
        frame=requestAnimationFrame(tick);
      });
      const area=scene.getBoundingClientRect(),body=worker.getBoundingClientRect();if(!canPlay()||area.width<=0)throw Error('工地不可见');
      await post('completed',{played:true,x:(body.left+body.width/2-area.left)/area.width,worksiteX,effortSeconds});
    }catch(e){await post('interrupted',{reason:e.message,worksiteX,effortSeconds}).catch(()=>{});}
    finally{cancelAnimationFrame(frame);worker.classList.remove('walking');running=null;startNext();}
  }
  worker.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,moved:false};worker.setPointerCapture(e.pointerId);});
  function showError(error){$('feedback').textContent=error.message;}
  worker.addEventListener('pointermove',e=>{if(!drag)return;if(!drag.moved&&Math.abs(e.clientX-drag.x)>8){drag.moved=true;stop();worker.classList.add('dragging');void window.worksite.action('drag').catch(showError);}if(drag.moved){const r=scene.getBoundingClientRect();position=clamp((e.clientX-r.left)/r.width);place();}});
  worker.addEventListener('pointerup',()=>{if(!drag)return;const moved=drag.moved;drag=null;worker.classList.remove('dragging');if(!moved)void window.worksite.action('touch').catch(showError);startNext();});
  worker.addEventListener('pointercancel',()=>{drag=null;worker.classList.remove('dragging');startNext();});
  worker.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void window.worksite.action('touch').catch(showError);}});
  $('release').addEventListener('click',async()=>{const button=$('release');releasing=true;button.disabled=true;stop();try{await window.worksite.action('release');$('feedback').textContent='她已经回到桌面。';}catch(e){showError(e);}finally{releasing=false;button.disabled=false;startNext();}});
  $('retry-unconfirmed').addEventListener('click',async()=>{const button=$('retry-unconfirmed');button.disabled=true;try{await window.worksite.action('retry-unconfirmed');$('feedback').textContent='未确认的动作未计数，将重新搬这趟。';}catch(e){showError(e);}finally{button.disabled=false;}});
  $('resume-work').addEventListener('click',async()=>{const button=$('resume-work');button.disabled=true;try{await window.worksite.action('resume-work');$('feedback').textContent='普通工作已恢复。';}catch(e){showError(e);}finally{button.disabled=false;}});
  $('force-work').addEventListener('click',async()=>{if(forcing||$('force-work').disabled)return;forcing=true;const button=$('force-work');button.disabled=true;stop();try{await window.worksite.action('force-work');$('feedback').textContent='已经强行让她继续搬砖。';}catch(e){showError(e);}finally{forcing=false;if(latest)render(latest);startNext();}});
  window.worksite.state(receive);
  window.worksite.notice(text=>{$('feedback').textContent=text;});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else void window.worksite.snapshot().catch(showError);});
  window.addEventListener('pagehide',()=>{stopped=true;stop();});
  void window.worksite.snapshot().catch(showError);
})();
