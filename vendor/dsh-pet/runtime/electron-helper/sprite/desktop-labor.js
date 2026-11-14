'use strict';
(() => {
  const proto=PetSprite.prototype,old=Object.fromEntries(['executeBody','pollBody','fitWindow','reportWindow','dispose','onPointerDown','onPointerMove','onPointerUp'].map(k=>[k,proto[k]]));
  proto.onPointerDown=function(e){this.laborDragStart={x:e.screenX,y:e.screenY,fromX:(this.pos.x+this.halfW)/VIEW.w};this.laborDragKey=null;return old.onPointerDown.call(this,e);};
  proto.onPointerMove=function(e){
    old.onPointerMove.call(this,e);const c=this.laborView?.current;
    if(c?.status!=='working'||!this.dragState.active||!this.laborDragStart||this.laborDragKey||Math.hypot(e.screenX-this.laborDragStart.x,e.screenY-this.laborDragStart.y)<24)return;
    this.laborDragKey=crypto.randomUUID();this.cancelBody?.();
  };
  proto.onPointerUp=function(e){const start=this.laborDragStart,key=this.laborDragKey,c=this.laborView?.current,dragged=this.dragState?.dragging===true;const result=old.onPointerUp.call(this,e);this.laborDragStart=null;this.laborDragKey=null;if(dragged&&e?.type==='pointerup')void window.petBridge.dropInWorksite().then(result=>{if(result?.entered){this.stopThrow();this.stopMove();}}).catch(()=>{});if(key&&c?.status==='working')void window.petBridge.reportInteraction('labor-disturb',{id:c.id,key,fromX:Math.max(0,Math.min(1,start.fromX)),toX:Math.max(0,Math.min(1,(this.pos.x+this.halfW)/VIEW.w))}).then(d=>{if(d.ok)this.laborView=d.labor;}).catch(()=>{});return result;};
  const style=document.createElement('style');style.textContent='.pet-labor-brick{position:absolute;width:30px;height:15px;border-radius:2px;background:#b45a3c;border:1px solid #713b2d;box-shadow:inset 0 3px #d98b66;pointer-events:none}.pet-labor-place{position:absolute;pointer-events:none;color:#f8f5ef;background:#423e38;padding:5px 9px;border-radius:5px;font:12px "Microsoft YaHei",sans-serif;white-space:nowrap}.pet-labor-load{position:absolute;pointer-events:none;width:28px;height:14px;border-radius:2px;background:#b45a3c;border:1px solid #713b2d;box-shadow:inset 0 3px #d98b66}';document.head.append(style);
  style.textContent+='.pet-labor-art{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;opacity:0;transform-origin:50% 90%}.pet-stage.has-labor-art:not(.is-crying):not(.is-using-phone) .pet-labor-art{opacity:1}.pet-stage.has-labor-art:not(.is-crying):not(.is-using-phone) .pet-video{opacity:0}.pet-labor-art[data-pose="carry"]{animation:pet-brick-steps .48s ease-in-out infinite alternate}.pet-labor-art[data-pose="lift"]{animation:pet-brick-lift 1.2s ease-in-out infinite alternate}@keyframes pet-brick-steps{from{transform:translateY(0) rotate(-1deg)}to{transform:translateY(-3px) rotate(1deg)}}@keyframes pet-brick-lift{from{transform:translateY(2px)}to{transform:translateY(-3px)}}@media(prefers-reduced-motion:reduce){.pet-labor-art{animation:none!important}}';
  proto.paintLabor=function(){
    const c=this.laborView?.current, visible=!window.petBridge?.worksiteOnly&&c&&['working','paused','unpaid'].includes(c.status)&&c.surface==='desktop';
    const command=this.laborCommand;const pose=null;
    this.laborArtActive=!!pose;
    if(pose&&this.painStage){if(!this.laborArt){this.laborArt=document.createElement('img');this.laborArt.className='pet-labor-art';this.laborArt.alt='大肥鱼抱着砖认真搬运';this.laborArt.onload=()=>{if(this.laborArtActive)this.painStage?.classList.add('has-labor-art');};this.painStage.append(this.laborArt);}if(this.laborArt.dataset.pose!==pose){this.laborArt.dataset.pose=pose;this.laborArt.src=BASE+'/humanity/labor-'+pose+'.png';}if(this.laborArt.complete&&this.laborArt.naturalWidth)this.painStage.classList.add('has-labor-art');}else this.painStage?.classList.remove('has-labor-art');
    if(!visible){this.laborLayer?.remove();this.laborLayer=null;this.laborPaintKey=null;this.laborCarriedBrick=null;return;}
    if(!this.laborLayer){this.laborLayer=document.createElement('div');this.laborLayer.setAttribute('aria-label','搬砖工地');document.body.append(this.laborLayer);}
    const origin=this.laborOrigin||{x:this.pos.x-this.winOffset.x,y:this.pos.y-this.winOffset.y}, floor=this.laborFloor??this.pos.y+this.height;
    const key=JSON.stringify([c.id,c.done,c.trips,c.carrying,origin.x,origin.y,floor]);
    if(this.laborPaintKey!==key){
      this.laborPaintKey=key;this.laborLayer.replaceChildren();this.laborCarriedBrick=null;
      const brick=(x,y,carry=false)=>{const n=document.createElement('div');n.className=carry?'pet-labor-load':'pet-labor-brick';n.style.left=(x-origin.x-15)+'px';n.style.top=(y-origin.y-15)+'px';this.laborLayer.append(n);return n;};
      for(const [x,count]of [[VIEW.w*.22,c.trips-c.done-(c.carrying?1:0)],[VIEW.w*.78,c.done]]){
        for(let i=0;i<Math.min(count,24);i++)brick(x+(i%4-1.5)*32,floor-Math.floor(i/4)*17);
        const label=document.createElement('div');label.className='pet-labor-place';label.textContent=x<VIEW.w/2?'待搬 '+Math.max(0,count):'已搬 '+count;label.style.left=(x-origin.x-35)+'px';label.style.top=(floor-origin.y+9)+'px';this.laborLayer.append(label);
      }
      if(c.carrying)this.laborCarriedBrick=brick(0,0,true);
    }
    if(this.laborCarriedBrick)this.laborCarriedBrick.style.transform=`translate(${this.pos.x+this.halfW-origin.x}px, ${this.pos.y+this.height*.6-origin.y}px)`;
  };
  proto.pollBody=async function(...args){await old.pollBody.apply(this,args);};
  // The existing poll already reads the authoritative world. Intercept its phone
  // sync to update props without another network loop or a second executor.
  const painSync=proto.syncPainState;
  const continuing=sprite=>sprite.laborView?.current?.status==='working'&&sprite.laborView.current.workPermit===true;
  proto.syncPainState=function(state){if(this.laborExecuting||continuing(this))return;return painSync.call(this,state);};
  const sync=proto.syncPhoneBody;
  proto.syncPhoneBody=function(world){const wasContinuing=continuing(this);this.laborView=world.labor;this.laborCommand=world.command;sync.call(this,world);if(wasContinuing&&!continuing(this)&&!this.laborExecuting&&this.humanity)painSync.call(this,this.humanity);const thought=world.labor?.current?.thought;if(thought&&thought!==this.lastLaborThought){this.lastLaborThought=thought;this.showInnerThought(thought);}this.paintLabor();if(this.pos)this.sendBounds(this.pos.x,this.pos.y);};
  proto.executeBody=async function(c,actions){
    if(c.source!=='labor')return old.executeBody.call(this,c,actions);
    const post=async(status,extra={})=>{const data=await window.petBridge.reportActionReceipt({id:c.id,index:c.index,surface:'desktop',status,...extra});if(!data.ok)throw Error(data.message||'搬砖进度没有保存');if(data.world)this.laborView=data.world.labor;};
    if(this.sleeping||this.frozen||this.phoneUsing||this.dragState.active){await post('interrupted',{reason:'身体暂时不能干活，进度保留'}).catch(()=>{});return;}
    this.bodyExecuting=true;this.bodyCommandId=c.id;this.laborExecuting=true;this.bodyProtected=false;this.painStage?.classList.remove('is-crying');this.stopMove();this.stopThrow();this.laborFloor=this.pos.y+this.height;
    let timer,frame,front,ended,played=false,moveDuration=0;
    try{
      const asset=actions[c.steps[c.index].action][0];
      await new Promise((resolve,reject)=>{
        this.cancelBody=()=>{this.stopMove();reject(Error('这一步被打断，稍后继续'));};timer=setTimeout(()=>reject(Error('动作播放超时，进度保留')),22000);
        if(c.index===0)this.facing=c.labor.x*VIEW.w<this.pos.x+this.halfW?'left':'right';
        this.switchTo(asset,true);
        const watch=()=>{
          if(this.ac.signal.aborted||this.sleeping||this.dragState.active||this.frozen){this.cancelBody();return;}
          const video=this.front===0?this.videoA:this.videoB;
          if(!played&&this.anim===asset&&!this.pending&&video.readyState>=2&&!video.paused){
            played=true;front=video;void post('playing').catch(()=>{});
            const live=this.laborCommand?.id===c.id?this.laborCommand:c,rate=Math.max(.55,Math.min(1.35,live.labor?.pace||1));
            video.playbackRate=rate;
            if(c.index===0){moveDuration=Math.min(5000,Math.max(300,video.duration*600));this.moveToCenter(c.labor.x,(this.pos.y+this.halfH)/VIEW.h,'line',moveDuration/rate);}
            ended=resolve;video.addEventListener('ended',ended,{once:true});
          }
          if(played&&video===front){
            const live=this.laborCommand?.id===c.id?this.laborCommand:c,rate=Math.max(.55,Math.min(1.35,live.labor?.pace||1));
            if(Math.abs(video.playbackRate-rate)>.015){video.playbackRate=rate;
              if(c.index===0){const distance=Math.abs(c.labor.x*VIEW.w-this.pos.x-this.halfW),remaining=Math.max(150,moveDuration*distance/Math.max(1,VIEW.w*.56)/rate);this.moveToCenter(c.labor.x,(this.pos.y+this.halfH)/VIEW.h,'line',remaining);}
            }
          }
          if(played&&(video!==front||this.anim!==asset)){reject(Error('动作被打断，稍后继续'));return;}
          this.paintLabor();frame=requestAnimationFrame(watch);
        };frame=requestAnimationFrame(watch);
      });
      await post('completed',{played,x:(this.pos.x+this.halfW)/VIEW.w});
    }catch(e){await post('interrupted',{reason:e.message}).catch(()=>{});}
    finally{clearTimeout(timer);cancelAnimationFrame(frame);if(front){front.playbackRate=1;if(ended)front.removeEventListener('ended',ended);}this.bodyExecuting=false;this.laborExecuting=false;this.cancelBody=null;if(!continuing(this)&&this.humanity)this.syncPainState(this.humanity);this.paintLabor();if(!continuing(this)&&!this.ac.signal.aborted&&!this.bodyProtected&&!this.sleeping)this.playIdle();}
  };
  proto.fitWindow=function(){
    const c=this.laborView?.current;
    if(window.petBridge?.worksiteOnly||!c||!['working','paused','unpaid'].includes(c.status)||c.surface!=='desktop'){
      const fit=old.fitWindow.call(this);this.laborOrigin={x:fit.x,y:fit.y};return fit;
    }
    // Keep the transparent worksite window fixed while the real sprite moves inside it.
    const next={x:0,y:0,width:VIEW.w,height:VIEW.h,offsetX:this.pos.x,offsetY:this.pos.y};
    this.laborOrigin={x:0,y:0};if(this.tokenOrigin)this.tokenOrigin={x:0,y:0};
    this.applyWinOffset(next.offsetX,next.offsetY);return next;
  };
  proto.reportWindow=function(...args){old.reportWindow.apply(this,args);this.paintLabor();};
  proto.dispose=function(...args){this.laborLayer?.remove();return old.dispose.apply(this,args);};
})();
