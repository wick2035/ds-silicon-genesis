// Web pet adapter: real animation/movement receipts, live emotional idle poses.
// React/card drivers remain the owners of playback and geometry.
export function startWebAffect({get,base,pet}) {
  const lifetime=new AbortController();
  let timer,world,running,seen='',lastIdle=0,lastKey='',art,poseRate;
  const boundVideos=new Map();
  function bindPlayback() {
    const x=get();
    for(const video of [x.videoA(),x.videoB()])if(video&&!boundVideos.has(video)){
      const apply=()=>{const frame=get(),pace=poseRate?.asset===frame.card.animRef.current&&!frame.ownAnim.playingPlayback()?poseRate.pace:1;video.defaultPlaybackRate=pace;video.playbackRate=pace;};
      video.addEventListener('loadeddata',apply);video.addEventListener('playing',apply);boundVideos.set(video,apply);
    }
  }
  const request=async body=>{
    const r=await fetch(base+'/humanity/companion/world?pet='+encodeURIComponent(pet),{cache:'no-store',signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(5000)]),
      ...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await r.json();if(!r.ok||!data.ok)throw Error(data.message||'身体状态暂未连上');return data.world;
  };
  const blocked=()=>{const x=get();return document.hidden||x.drag.isActive()||x.ownAnim.isFrozen()||x.flow.sleeping()||world?.sleeping||world?.paused;};
  function pose(action,pace=1) {
    const x=get(),asset=world?.actions?.[action]?.[0];if(!asset)return false;
    poseRate={asset,pace};bindPlayback();
    for(const video of [x.videoA(),x.videoB()])if(video){video.defaultPlaybackRate=pace;video.playbackRate=pace;}
    x.motion.stopMove();x.actions.setAnim(asset);x.actions.setOnce(true);x.actions.bumpSeq();
    return true;
  }
  function protect() {
    const x=get(),stage=x.stage();if(!stage)return;
    const collecting=world.command?.source==='tokens'&&['queued','running'].includes(world.command.status);
    const hurt=world?.body?.mobility===0 && !world.sleeping && !x.flow.sleeping()&&!collecting;
    const curled=hurt&&world.body.phase==='curled';
    if(curled&&!art){art=document.createElement('img');art.src=base+'/humanity/curled.png';art.alt='疼得厉害，抱紧膝盖缓一缓';
      Object.assign(art.style,{position:'absolute',inset:'0',width:'100%',height:'100%',objectFit:'contain',pointerEvents:'none'});stage.append(art);}
    if(art)art.hidden=!curled;
    for(const video of [x.videoA(),x.videoB()])if(video)video.style.visibility=curled?'hidden':'';
    if(hurt){x.motion.stopMove();x.motion.flight.stop();if(x.card.animRef.current!==world.actions.protest[0])pose('protest',.7);}
  }
  function idle() {
    if(!world||blocked())return false;
    if(running||world.body?.mobility===0)return true;
    if(world.activity||world.soft?.current||world.labor?.current?.status==='working'||get().ownAnim.playingPlayback())return false;
    if(['queued','running'].includes(world.command?.status))return true;
    const a=world.affect;if(!a||a.key==='calm'){
      poseRate=null;for(const video of [get().videoA(),get().videoB()])if(video){video.defaultPlaybackRate=1;video.playbackRate=1;}
      return false;
    }
    const now=Date.now(), expressive=now-lastIdle>=18000;
    // Between emotional expressions, return control to the normal idle/walk lottery.
    // A hard-rest state must keep its resting pose until the body can move again.
    if(!expressive&&!a.hardRest){
      poseRate=null;for(const video of [get().videoA(),get().videoB()])if(video){video.defaultPlaybackRate=1;video.playbackRate=1;}
      return false;
    }
    if(expressive)lastIdle=now;
    lastKey=a.key;
    return pose(expressive?a.idleAction:a.hardRest?'rest':'listen',a.pace);
  }
  async function execute(c) {
    const controller=new AbortController(),step=c.steps[c.index],x=get(),asset=world.actions?.[step.action]?.[0];
    if(!asset)return;
    running={controller,id:c.id};let frame,deadline,front,from=x.motion.center(),played=false;
    const post=(status,extra={})=>request({action:'receipt',id:c.id,index:c.index,surface:'web',status,...extra});
    try {
      if(blocked()||world.body.mobility===0)throw Error('此刻需要休息或正在互动');
      pose(step.action,c.affect?.pace||1);
      await new Promise((resolve,reject)=>{
        deadline=setTimeout(()=>reject(Error('动作素材播放超时')),22000);
        controller.signal.addEventListener('abort',()=>reject(Error('身体状态或爸爸的互动改变了动作')),{once:true});
        const watch=()=>{
          if(lifetime.signal.aborted||blocked()||world?.body?.mobility===0||world?.command?.id!==c.id||!['queued','running'].includes(world?.command?.status)){
            controller.abort();return;
          }
          const latest=get(),v=latest.ownAnim.frontVideo();
          if(!played&&latest.card.animRef.current===asset&&v?.readyState>=2&&!v.paused){
            played=true;front=v;v.playbackRate=Math.max(.55,Math.min(1.12,c.affect?.pace||1));void post('playing').catch(()=>{});
            if(['walk','approach'].includes(step.action)){
              const metrics=latest.motion.metrics(),margin=Math.min(.45,metrics.halfW/innerWidth);
              let target=step.target==='left'?.22:step.target==='right'||step.target==='edge'?.78:.5;
              if(Math.abs(target*innerWidth-from.x)<8)target=target<.5?.65:.35;
              target=Math.max(margin,Math.min(1-margin,target));latest.actions.setFacing(target*innerWidth<from.x?'left':'right');
              latest.motion.posFollow.apply(target,from.y/innerHeight,'line',Math.min(5000,Math.max(1200,v.duration*600))/v.playbackRate);
            }
            v.addEventListener('ended',resolve,{once:true,signal:controller.signal});
          }
          if(played&&(v!==front||latest.card.animRef.current!==asset)){reject(Error('动作被其他互动打断'));return;}
          frame=requestAnimationFrame(watch);
        };frame=requestAnimationFrame(watch);
      });
      const to=get().motion.center(),fresh=await post('completed',{played,distance:Math.hypot(to.x-from.x,to.y-from.y)});
      if(world?.command?.id===c.id)world=fresh;
    }catch(error){if(!lifetime.signal.aborted)await post('interrupted',{reason:error.message}).catch(()=>{});}
    finally{clearTimeout(deadline);cancelAnimationFrame(frame);controller.abort();if(front)front.playbackRate=1;if(['walk','approach'].includes(step.action))get().motion.stopMove();if(running?.id===c.id)running=null;
      // The ended callback was held while this command owned the body.
      if(!lifetime.signal.aborted&&front?.ended&&!blocked()&&world.body.mobility===1&&!idle())get().flow.pickNext?.();}
  }
  async function poll() {
    clearTimeout(timer);if(lifetime.signal.aborted)return;
    try {
      if(!document.hidden){
        world=await request();if(lifetime.signal.aborted)return;
        protect();
        const c=world.command;
        if(running&&(!c||c.id!==running.id||!['queued','running'].includes(c.status)||blocked()||world.body.mobility===0))running.controller.abort();
        // Work and token collection have their own executors and receipt contracts.
        if(!running&&!blocked()&&c&&c.surface==='web'&&!['labor','labor-mood','tokens'].includes(c.source)&&['queued','running'].includes(c.status)&&Date.now()<=c.expires&&seen!==c.id+':'+c.index){
          seen=c.id+':'+c.index;void execute(c);
        }else if(!running&&!blocked()&&world.body.mobility===1&&!world.activity&&!world.soft?.current&&world.labor?.current?.status!=='working'&&
          !['queued','running'].includes(c?.status)&&!get().ownAnim.playingPlayback()&&world.affect?.key!=='calm'&&
          (world.affect?.key!==lastKey||Date.now()-lastIdle>=18000)&&Date.now()-lastIdle>=8000){
          idle();
        }
      }
    }catch(error){if(!lifetime.signal.aborted)console.warn('[大肥鱼感受]',error.message);}
    finally{if(!lifetime.signal.aborted)timer=setTimeout(poll,1000);}
  }
  const hidden=()=>{if(document.hidden)running?.controller.abort();else if(!timer)void poll();};
  document.addEventListener('visibilitychange',hidden);void poll();
  const cleanup=()=>{lifetime.abort();running?.controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',hidden);art?.remove();
    for(const [video,apply]of boundVideos){video.removeEventListener('loadeddata',apply);video.removeEventListener('playing',apply);}boundVideos.clear();
    const x=get();x.motion.stopMove();for(const video of [x.videoA(),x.videoB()])if(video){video.defaultPlaybackRate=1;video.playbackRate=1;video.style.visibility='';}};
  cleanup.idle=idle;
  return cleanup;
}
