// Additive expressions on the existing sprite. Rice throwing and pain stay owned
// by their original executors; this layer never handles a prop pointer event.
'use strict';
(() => {
  const proto=PetSprite.prototype, old=Object.fromEntries(['syncPhoneBody','executeBody','dispose','onMouseMove'].map(k=>[k,proto[k]]));
  const poses={sulk_bowl:'bowl',sulk_blanket:'blanket',coax:'coax',tantrum:'bowl',protest:'blanket'};
  proto.paintSoft=function(){
    const s=this.softView?.current,stage=this.painStage;
    if(!stage)return;
    const pose=this.softPlaying || s?.pose;
    const visible=pose && !this.sleeping && !this.bodyProtected && !this.phoneUsing && !this.frozen && !this.dragState.active && !document.hidden && !this.laborArtActive;
    if(!visible){stage.classList.remove('has-soft-art');if(this.softChoices)this.softChoices.hidden=true;return;}
    if(!this.softArt){const art=document.createElement('img');art.className='pet-sulk-art';art.alt='';art.draggable=false;stage.append(art);this.softArt=art;art.onload=()=>{if(this.softArt===art)this.paintSoft();};art.onerror=()=>stage.classList.remove('has-soft-art');}
    const key=poses[pose];if(!key)return;
    if(this.softArt.dataset.pose!==key){stage.classList.remove('has-soft-art');this.softArt.dataset.pose=key;this.softArt.src=BASE+'/humanity/sulk-'+key+'.png';}
    if(this.softArt.complete&&this.softArt.naturalWidth){stage.dataset.softPose=key;stage.classList.add('has-soft-art');}
    // Keep the original bowl/steel basin as the only physical utensil.
    if(key==='bowl' && !this.riceDragging && !this.riceFlying && !this.riceProp?.classList.contains('is-broken') && (!this.riceProp||this.riceProp.hidden))this.showRiceProp?.('bowl');
    if(!this.softChoices){const group=document.createElement('div');group.className='pet-soft-choices';group.setAttribute('aria-label','回应她的小脾气');stage.append(group);this.softChoices=group;}
    const revision=JSON.stringify([s?.id,s?.status,s?.choices]);
    if(revision!==this.softChoicesRevision){this.softChoicesRevision=revision;this.softChoices.replaceChildren();for(const c of s?.choices||[]){const b=document.createElement('button');b.type='button';b.textContent=c.label;b.addEventListener('pointerdown',e=>e.stopPropagation());b.addEventListener('click',e=>{e.stopPropagation();void this.chooseSoft(s.id,c.id);});this.softChoices.append(b);}}
    this.softChoices.hidden=!s?.choices?.length||s.status!=='waiting'||!!this.softChoosing;
    this.syncInputRegions?.();
  };
  proto.chooseSoft=async function(id,choice){
    if(this.softChoosing)return;this.softChoosing=true;this.paintSoft();
    try{if(choice==='feed'&&!await this.feedRice())throw Error('喂饭没有完成');if(choice==='pet'){const care=await window.petBridge.reportInteraction('pet',{});if(!care.ok)throw Error('摸头没有保存');}const r=await fetch(BASE+'/humanity/companion/soft?pet='+encodeURIComponent(this.pet.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'choose',id,choice}),signal:AbortSignal.any([this.ac.signal,AbortSignal.timeout(60000)])});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.message||'这次互动没有完成');this.softView=d.soft;if(d.reaction?.ok===false)this.showInnerThought('互动已经记下，刚才的话没说出来');}
    catch(e){if(!this.ac.signal.aborted){console.warn('[大肥鱼小脾气]',e.message);this.showInnerThought('刚才没接上，过一会儿再试试');}}
    finally{this.softChoosing=false;this.paintSoft();}
  };
  proto.syncPhoneBody=function(world){old.syncPhoneBody.call(this,world);this.softView=world.soft;this.paintSoft();};
  proto.onMouseMove=function(e){old.onMouseMove.call(this,e);if(this.softChoices&&!this.softChoices.hidden){const r=this.softChoices.getBoundingClientRect();if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)this.setInteractive(true);}};
  proto.executeBody=async function(c,actions){
    const action=c.steps[c.index].action;
    if(!poses[action])return old.executeBody.call(this,c,actions);
    const post=async(status,extra={})=>{const r=await fetch(BASE+'/humanity/companion/world?pet='+encodeURIComponent(this.pet.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'receipt',id:c.id,index:c.index,surface:'desktop',status,...extra}),signal:AbortSignal.any([this.ac.signal,AbortSignal.timeout(5000)])});if(!r.ok)throw Error('姿态回执没有送达');};
    const blocked=()=>this.ac.signal.aborted||this.sleeping||this.frozen||this.bodyProtected||this.phoneUsing||this.dragState.active||document.hidden;
    if(blocked()){await post('interrupted',{reason:'睡眠、恢复或爸爸正在互动'}).catch(()=>{});return;}
    this.bodyExecuting=true;this.bodyCommandId=c.id;this.stopMove();this.stopThrow();this.softPlaying=action;this.paintSoft();
    let frame,timer,cancel,played=false;
    try{
      const aborted=new Promise((_,reject)=>{cancel=()=>reject(Error('姿态被新的互动打断'));this.cancelBody=cancel;});
      await Promise.race([this.softArt.decode(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('姿态素材未载入')),8000);})]);
      this.paintSoft();
      await Promise.race([aborted,new Promise((resolve,reject)=>{let began;const tick=now=>{if(blocked()){reject(Error('姿态被打断'));return;}if(!this.painStage.classList.contains('has-soft-art')){reject(Error('姿态没有实际显示'));return;}if(began===undefined){began=now;played=true;void post('playing').catch(()=>{});}if(now-began>=750){resolve();return;}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);})]);
      await post('completed',{played,distance:0});
    }catch(e){await post(played?'interrupted':'failed',{reason:e.message}).catch(()=>{});}
    finally{clearTimeout(timer);cancelAnimationFrame(frame);this.bodyExecuting=false;this.softPlaying=null;if(this.cancelBody===cancel)this.cancelBody=null;this.paintSoft();if(!blocked())this.playIdle();}
  };
  // Moving or hiding the window must not leave a separate floating choice panel.
  const update=proto.updateRiceAnchor;
  proto.updateRiceAnchor=function(){update.call(this);if(this.painStage?.classList.contains('has-soft-art')&&this.riceAttached&&!this.riceHead){const r=this.painStage.getBoundingClientRect(),bowl=this.painStage.dataset.softPose==='bowl';if(!bowl)this.riceProp.style.left=Math.max(0,r.left+r.width*.16)+'px';this.riceProp.style.top=Math.max(0,Math.min(innerHeight-this.riceProp.offsetHeight,r.top+r.height*(bowl?.72:.80)))+'px';}};
  const visibility=()=>{for(const s of globalThis.__softSprites||[])s.paintSoft();};
  globalThis.__softSprites ||= new Set();
  const sync=proto.syncPhoneBody;
  proto.syncPhoneBody=function(w){if(!globalThis.__softSprites.size)document.addEventListener('visibilitychange',visibility);globalThis.__softSprites.add(this);return sync.call(this,w);};
  proto.dispose=function(...args){this.softArt?.remove();this.softChoices?.remove();globalThis.__softSprites.delete(this);if(!globalThis.__softSprites.size)document.removeEventListener('visibilitychange',visibility);return old.dispose.apply(this,args);};
})();
