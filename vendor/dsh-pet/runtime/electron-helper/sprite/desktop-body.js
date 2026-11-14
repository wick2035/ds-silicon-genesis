// Physical executor for the native desktop sprite. Model output is data only.
'use strict';
(() => {
  const proto=PetSprite.prototype, old={idle:proto.playIdle,switchTo:proto.switchTo,dispose:proto.dispose,whisper:proto.showWhisper};
  // Spoken words live in the serialized chat. The overhead bubble is thought only.
  proto.showWhisper=function(...args){if(this.renderingInnerThought)return old.whisper.apply(this,args);};
  proto.showInnerThought=function(text){this.renderingInnerThought=true;try{return this.showWhisper(text,undefined,undefined,6500,false);}finally{this.renderingInnerThought=false;}};
  proto.playIdle=function(...args){if(this.bodyProtected || this.bodyExecuting || this.phoneUsing)return;if(this.playAffectIdle?.())return;for(const video of [this.videoA,this.videoB])if(video)video.playbackRate=1;return old.idle.apply(this,args);};
  proto.switchTo=function(name,...args){if(this.bodyProtected && name!=='工作状态-垂头叹气冒汗')return;if(this.phoneUsing&&!this.bodyProtected&&name!=='原地小憩沉眠')return;for(const video of [this.videoA,this.videoB])if(video){video.defaultPlaybackRate=this.affectIdleRate||1;video.playbackRate=this.affectIdleRate||1;}return old.switchTo.call(this,name,...args);};
  proto.switchAffectPose=function(name,once,pace){this.affectIdleRate=pace;try{return this.switchTo(name,once);}finally{this.affectIdleRate=null;}};
  proto.playAffectIdle=function(){
    const a=this.liveAffect,w=this.affectWorld;
    if(!a||a.key==='calm'||!w||w.paused||w.sleeping||w.activity||w.soft?.current||w.labor?.current?.status==='working'||
      this.sleeping||this.frozen||this.bodyProtected||this.phoneUsing||this.bodyExecuting||this.dragState.active||this.playback||
      w.command&&['queued','running'].includes(w.command.status))return false;
    const asset=w.actions?.[a.idleAction]?.[0];if(!asset)return false;
    const now=Date.now();
    if(this.lastAffectPose && now-this.lastAffectPose<18000){
      this.stopMove();this.switchAffectPose(a.hardRest?w.actions.rest[0]:(this.animations?.idle?.[0]||w.actions.listen[0]),false,a.pace);return true;
    }
    this.lastAffectPose=now;this.stopMove();
    this.switchAffectPose(asset,true,a.pace);return true;
  };
  proto.syncAffectBody=function(world){
    const changed=this.liveAffect?.key!==world.affect?.key;
    this.liveAffect=world.affect;this.affectWorld=world;
    if(this.bodyExecuting&&world.affect?.hardRest&&this.bodyCommandId===world.command?.id&&world.command?.status==='interrupted')this.cancelBody?.();
    if(changed||Date.now()-(this.lastAffectPose||0)>=18000)this.playAffectIdle();
  };
  proto.syncPhoneBody=function(world){
    const on=world.activity?.kind==='phone'&&!world.sleeping&&world.body?.mobility===1&&!this.sleeping&&!this.frozen&&!this.dragState.active;
    if(on&&!this.phoneArt){const img=document.createElement('img');img.className='pet-phone-art';img.alt='大肥鱼坐下来，双手拿着手机认真看';img.src=BASE+'/humanity/phone.png';img.onload=()=>this.painStage?.classList.add('has-phone-art');this.painStage?.append(img);this.phoneArt=img;}
    if(this.phoneUsing===on)return;
    this.phoneUsing=on;this.painStage?.classList.toggle('is-using-phone',on);
    if(on){this.cancelBody?.();this.stopMove();this.switchTo('原地小憩沉眠',false);this.showInnerThought('这个小问题，我想自己弄明白……');}
    else if(!this.bodyProtected&&!this.sleeping)this.playIdle();
  };
  proto.pollBody=async function(){
    if(this.bodyPolling||this.ac.signal.aborted)return;this.bodyPolling=true;
    try{
      const res=await fetch(BASE+'/humanity/companion/world?pet='+encodeURIComponent(this.pet.id),{cache:'no-store',signal:AbortSignal.any([this.ac.signal,AbortSignal.timeout(5000)])});
      if(!res.ok)return;const data=await res.json(),c=data.world?.command;
      if(data.world)this.syncPhoneBody(data.world);
      if(data.world)this.syncAffectBody(data.world);
      // Rehydrate only a committed sleep state after the helper reconnects.
      if(data.world?.confirmedSleep===true&&!this.sleeping&&!this.bodyExecuting&&!this.sleepReportPending){const set=(this.animations.sleep||[]).find(s=>s?.start?.length&&s?.loop?.length&&s?.end?.length);if(set){this.sleeping=true;this.sleepSet={start:set.start[0],loop:set.loop[0],end:set.end[0]};this.sleepPhase='loop';this.stopMove();this.switchTo(this.sleepSet.loop,false);}}
      const thought=data.world?.body?.phase!=='well'?data.world?.body?.label:c?.source==='curiosity'?data.world.questions.at(-1)?.text:'';
      if(thought && thought!==this.lastInnerThought){this.lastInnerThought=thought;this.showInnerThought(thought);}
      if(c?.source==='silicon-rest' && this.bodySeen!==c.id+':0'){this.bodySeen=c.id+':0';if(!this.bodyExecuting&&!this.dragState.active&&!this.frozen){this.restAction={id:c.id,kind:c.restKind};this.postSleepAction(c.restKind);}return;}
      if(this.bodyExecuting && (!c||c.id!==this.bodyCommandId||!['queued','running'].includes(c.status)))this.cancelBody?.();
      if(!data.ok||!c||c.surface!=='desktop'||!['queued','running'].includes(c.status)||Date.now()>c.expires||this.bodyExecuting||this.bodySeen===c.id+':'+c.index)return;
      this.bodySeen=c.id+':'+c.index;void this.executeBody(c,data.world.actions);
    }catch(e){if(!this.ac.signal.aborted)console.warn('[大肥鱼身体]',e.message);}finally{this.bodyPolling=false;}
  };
  proto.executeBody=async function(c,actions){
    const step=c.steps[c.index],asset=actions[step.action]?.[0];if(!asset){if(c.source==='silicon-eat')await window.petBridge.reportActionReceipt({id:c.id,actionId:c.actionId,itemId:c.itemId,index:c.index,surface:'desktop',status:'interrupted',reason:'照料动画素材不可用'}).catch(()=>{});return;}
    const post=(status,extra={})=>c.source==='silicon-eat'
      ? window.petBridge.reportActionReceipt({id:c.id,actionId:c.actionId,itemId:c.itemId,index:c.index,surface:'desktop',status:status==='failed'?'interrupted':status,...extra})
      : fetch(BASE+'/humanity/companion/world?pet='+encodeURIComponent(this.pet.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'receipt',id:c.id,index:c.index,surface:'desktop',status,...extra}),signal:AbortSignal.any([this.ac.signal,AbortSignal.timeout(5000)])}).catch(()=>{});
    const gentleCare=c.source==='silicon-eat'&&['eat','drink','pet','soothe','accompany'].includes(step.action);
    if(this.sleeping||this.frozen||(this.bodyProtected&&!gentleCare)||this.phoneUsing||this.dragState.active){await post('interrupted',{reason:'睡眠、恢复、学习或爸爸正在互动'});return;}
    this.bodyExecuting=true;this.bodyCommandId=c.id;this.careVisual=gentleCare;
    if(gentleCare){this.bodyProtected=false;this.painStage?.classList.remove('is-crying');this.paintSoft?.();}
    this.stopMove();
    if(step.action==='beg')this.showRiceProp?.('bowl');
    const from={...this.pos};let cancelled=false,played=false,video,frame,timer;
    try{
      const done=new Promise((resolve,reject)=>{
        this.cancelBody=()=>{cancelled=true;this.stopMove();reject(Error('爸爸的互动或新动作打断了这次尝试'));};
        timer=setTimeout(()=>reject(Error('动作素材播放超时')),22000);
        this.switchTo(asset,true);
        const watch=()=>{
          if(this.ac.signal.aborted||this.sleeping||this.bodyProtected||this.dragState.active||this.frozen){this.cancelBody();return;}
          const front=this.front===0?this.videoA:this.videoB;
          if(this.anim===asset && !this.pending && front.readyState>=2 && !front.paused){
            if(!played){played=true;video=front;front.playbackRate=Math.max(.55,Math.min(1.12,c.affect?.pace||1));void post('playing');
              if(['walk','approach'].includes(step.action)){
                const screen=S.screenOfBox(this.throwSpaceOf(),this.pos.x,this.pos.y),area=AREAS[screen]||AREAS[0];
                let x=step.target==='left'?area.x+area.width*.22:step.target==='right'||step.target==='edge'?area.x+area.width*.78:area.x+area.width*.5;
                if(Math.abs(x-this.pos.x-this.halfW)<8)x=area.x+area.width*((x-area.x)/area.width<.5?.65:.35);
                this.facing=x<this.pos.x+this.halfW?'left':'right';
                this.moveToCenter(x/VIEW.w,(this.pos.y+this.halfH)/VIEW.h,'line',Math.min(6500,Math.max(1600,front.duration*600))/front.playbackRate);
              }
              front.addEventListener('ended',()=>resolve(),{once:true});
            }
          }
          if(played && (front!==video || this.anim!==asset)){reject(Error('动作被其他互动打断'));return;}
          frame=requestAnimationFrame(watch);
        };frame=requestAnimationFrame(watch);
      });
      await done;
      await post('completed',{played,distance:Math.hypot(this.pos.x-from.x,this.pos.y-from.y)});
    }catch(e){await post(cancelled?'interrupted':'failed',{reason:e.message});}
    finally{clearTimeout(timer);cancelAnimationFrame(frame);if(video)video.playbackRate=1;this.bodyExecuting=false;this.cancelBody=null;this.careVisual=false;if(gentleCare&&this.humanity)this.syncPainState(this.humanity);this.paintSoft?.();if(!this.ac.signal.aborted&&!this.bodyProtected&&!this.sleeping)this.playIdle();}
  };
  proto.dispose=function(...args){this.cancelBody?.();return old.dispose.apply(this,args);};
})();
