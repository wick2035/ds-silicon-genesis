'use strict';
(() => {
  const proto=PetSprite.prototype;
  let nextSpaceWatch=0;
  const old=Object.fromEntries(['bindEvents','onPointerDown','onPointerMove','onPointerUp','onClick','fitWindow','reportWindow','dispose','executeBody','playIdle'].map(k=>[k,proto[k]]));
  const style=document.createElement('style');style.textContent=PET_TOKEN_CSS+`
    .pet-token-native .pet-token-layer{z-index:2147483000}
    .pet-token-crawl{position:absolute;inset:0;pointer-events:none;display:none;z-index:5;transform:scaleX(var(--token-facing,1))}
    .pet-token-crawl img{position:absolute;left:6%;bottom:0;width:55%;height:100%;object-fit:contain;object-position:center bottom;transform-origin:55% 88%}
    .pet-stage.is-token-crawling .pet-token-crawl{display:block}
    .pet-stage.is-token-crawling .pet-video,.pet-stage.is-token-crawling .pet-pain,.pet-stage.is-token-crawling .pet-phone-art{visibility:hidden}
    .pet-stage.is-token-crawling .pet-token-crawl img{animation:token-crawl-reach 1100ms ease-in-out infinite}
    .pet-stage.is-token-picking .pet-token-crawl img{animation:token-pick-reach 900ms ease-in-out both}
    @keyframes token-crawl-reach{0%,100%{transform:translateY(0) rotate(-1deg)}45%{transform:translate(3px,-2px) rotate(1deg)}70%{transform:translateY(1px) rotate(0)}}
    @keyframes token-pick-reach{0%,100%{transform:rotate(0)}50%{transform:translate(7px,3px) rotate(3deg) scaleX(1.03)}}
    @media(prefers-reduced-motion:reduce){.pet-stage.is-token-crawling .pet-token-crawl img{animation:none}}
  `;document.head.append(style);document.body.classList.add('pet-token-native');
  proto.bindEvents=function(...args){
    const result=old.bindEvents.apply(this,args);
    this.tokenScene=createTokenScene({host:document.body,petId:this.pet.id,base:BASE,surface:'desktop',
      viewport:()=>({w:VIEW.w,h:VIEW.h}),workAreas:()=>WORK_AREAS.length?WORK_AREAS:AREAS,
      point:(x,y)=>({x:x*VIEW.w-(this.tokenOrigin?.x??this.pos.x-this.winOffset.x),y:y*VIEW.h-(this.tokenOrigin?.y??this.pos.y-this.winOffset.y)}),
      geometry:()=>{const area=S.resolveRect(WORK_AREAS.length?WORK_AREAS:AREAS,this.pos.x+this.halfW,this.pos.y+this.halfH);return{x:(this.pos.x+this.halfW)/VIEW.w,y:(this.pos.y+this.height*.65)/VIEW.h,floorY:Math.max(.02,Math.min(.98,(area.y+area.height-28)/VIEW.h))};},
      onLayout:()=>{if(this.pos)this.sendBounds(this.pos.x,this.pos.y);},
      overlayArea:()=>{const a=S.resolveRect(WORK_AREAS.length?WORK_AREAS:AREAS,this.pos.x+this.halfW,this.pos.y+this.halfH),o=this.tokenOrigin||{x:this.pos.x-this.winOffset.x,y:this.pos.y-this.winOffset.y};return{x:a.x-o.x,y:a.y-o.y,width:a.width,height:a.height};},
      overlayAnchor:()=>{const o=this.tokenOrigin||{x:this.pos.x-this.winOffset.x,y:this.pos.y-this.winOffset.y};return{x:this.pos.x+this.halfW-o.x,y:this.pos.y-o.y};},
      onOverlay:()=>this.syncInputRegions?.(),
      onCollect:id=>{if(this.pickupCoinId===id)this.cancelBody?.();},
      onHold:held=>this.painStage?.classList.toggle('pet-token-held',held),isHovered:()=>this.hoverBody,
    });
    this.unsubscribeTokenSpace=window.petBridge?.onTokenSpace?.((id,pressed)=>{
      if(id!==this.tokenSpaceWatch||!this.dragState.active)return;
      this.tokenScene.setNativeSpace(pressed);
      this.startTokenGrab();
    });
    return result;
  };
  proto.startTokenGrab=function(){
    if(!this.tokenPointer||this.tokenGrab||!this.tokenScene.space||this.sleeping)return;
    this.cancelBody?.();
    this.tokenGrab=true;
    this.dragState.sling=false;
    this.tokenScene.begin(...this.tokenPointer);
  };
  proto.stopTokenSpaceWatch=function(){
    if(this.tokenSpaceWatch===undefined)return;
    window.petBridge?.watchTokenSpace?.(this.tokenSpaceWatch,false);
    this.tokenSpaceWatch=undefined;
    this.tokenPointer=null;
    this.tokenScene.setNativeSpace(undefined);
  };
  proto.onPointerDown=function(e){
    old.onPointerDown.call(this,e);
    if(e.button!==0||!this.dragState.active||this.sleeping)return;
    this.tokenPointer=[toLocal(e.screenX),toLocal(e.screenY)];
    this.tokenSpaceWatch=++nextSpaceWatch;
    window.petBridge?.watchTokenSpace?.(this.tokenSpaceWatch,true);
    this.startTokenGrab();
  };
  proto.onPointerMove=function(e){
    old.onPointerMove.call(this,e);
    if(!this.dragState.active||!this.tokenPointer)return;
    this.tokenPointer=[toLocal(e.screenX),toLocal(e.screenY)];
    this.startTokenGrab();
    if(this.tokenGrab){
      for(const point of e.getCoalescedEvents?.()||[])this.tokenScene.sample(toLocal(point.screenX),toLocal(point.screenY));
      this.tokenScene.sample(...this.tokenPointer);
    }
  };
  proto.pollTokenSoon=function(){for(const delay of [200,600,1200])setTimeout(()=>{if(!this.ac.signal.aborted)void this.pollBody();},delay);};
  proto.onPointerUp=function(e){
    this.stopTokenSpaceWatch();
    if(!this.tokenGrab)return old.onPointerUp.call(this,e);
    this.tokenGrab=false;this.stopThrow();this.dragTrail=[];this.dragState.sling=false;this.tokenJustDragged=true;
    clearTimeout(this.tokenClickTimer);this.tokenClickTimer=setTimeout(()=>this.tokenJustDragged=false,400);
    const result=old.onPointerUp.call(this,e);
    this.tokenScene.release();this.pollTokenSoon();return result;
  };
  proto.onClick=function(e){if(this.tokenJustDragged)return;return old.onClick.call(this,e);};
  proto.playIdle=function(...args){if(this.tokenScene?.dragging)return;return old.playIdle.apply(this,args);};
  proto.crawlForToken=async function(c,post){
    if(!this.tokenCrawlArt){
      const layer=document.createElement('div'),img=document.createElement('img');layer.className='pet-token-crawl';img.alt='大肥鱼低伏着慢慢爬近饭钱，伸手捡起';img.src=new URL('../../assets/token-crawl.png',document.baseURI).href;layer.append(img);this.painStage.append(layer);this.tokenCrawlArt={layer,img};
    }
    const {layer,img}=this.tokenCrawlArt;let frame,timer;
    // The legacy video's foot padding is specific to its standing canvas.
    // This sprite already includes its own transparent floor margin.
    layer.style.translate='0 '+(-this.bottomPad)+'px';
    try{
      await img.decode();this.ac.signal.throwIfAborted();
      layer.style.setProperty('--token-facing',c.coin.x*VIEW.w<this.pos.x+this.halfW?'-1':'1');
      this.painStage.classList.add('is-token-crawling');this.painStage.classList.toggle('is-token-picking',c.index===1);
      await post('playing');
      const from={...this.pos},target={x:c.coin.x*VIEW.w-this.halfW,y:c.coin.y*VIEW.h-this.height};
      const distance=Math.abs(target.x-from.x),settle=Math.abs(target.y-from.y)>4?600:0,duration=c.index===0?settle+Math.max(1800,Math.min(13400,distance/55*1000)):1000;
      await new Promise((resolve,reject)=>{
        this.cancelBody=()=>reject(Error('爸爸抓住了身体或改变了动作'));
        timer=setTimeout(()=>reject(Error('爬行被打断，松手后继续捡')),duration+3000);let start;
        const move=now=>{
          if(this.ac.signal.aborted||this.sleeping||this.frozen||this.dragState.active||this.tokenScene?.dragging){this.cancelBody();return;}
          start??=now;const progress=Math.min(1,(now-start)/duration);
          if(c.index===0){const elapsed=now-start;
            if(elapsed<settle){const p=1-Math.pow(1-elapsed/settle,3);this.sendBounds(from.x,from.y+(target.y-from.y)*p);}
            else{const travel=(elapsed-settle)/(duration-settle),strides=(duration-settle)/1100,step=travel*strides,part=step%1,eased=(Math.floor(step)+(part<.72?(1-Math.cos(part/.72*Math.PI))/2:1))/strides,p=Math.min(1,eased);this.sendBounds(from.x+(target.x-from.x)*p,target.y);}
          }
          if(progress>=1){if(c.index===0)this.sendBounds(target.x,target.y);resolve();return;}
          frame=requestAnimationFrame(move);
        };frame=requestAnimationFrame(move);
      });
      await post('completed',{played:true,x:(this.pos.x+this.halfW)/VIEW.w,y:(this.pos.y+this.height)/VIEW.h});
    }finally{clearTimeout(timer);cancelAnimationFrame(frame);this.painStage.classList.remove('is-token-crawling','is-token-picking');}
  };
  proto.executeBody=async function(c,actions){
    if(c.source!=='tokens')return old.executeBody.call(this,c,actions);
    const post=async(status,extra={})=>{
      if(status!=='interrupted' && this.tokenScene && !this.tokenScene.canPickUp(c.coinId))throw Error('这片饭钱已收起');
      const data=await window.petBridge.reportActionReceipt({id:c.id,actionId:c.actionId,coinId:c.coinId,index:c.index,surface:'desktop',status:status==='failed'?'interrupted':status,...extra});if(!data.ok)throw Error(data.message||'拾取未能保存');
    };
    if(this.sleeping||this.frozen||this.phoneUsing||this.dragState.active||this.tokenScene?.dragging){await post('interrupted',{reason:'身体被抓住、入睡或正在占用'}).catch(()=>{});return;}
    if(this.tokenScene && !this.tokenScene.canPickUp(c.coinId)){await post('interrupted').catch(()=>{});return;}
    this.bodyExecuting=true;this.bodyCommandId=c.id;this.pickupCoinId=c.coinId;this.stopMove();this.stopThrow();
    let timer,frame,played=false,front,ended;
    try{
      const asset=actions?.[c.steps[c.index].action]?.[0];
      if(!asset||c.locomotion==='crawl'||this.bodyProtected||this.humanity?.body?.phase==='recovering'){await this.crawlForToken(c,post);return;}
      await new Promise((resolve,reject)=>{
        this.cancelBody=()=>{this.stopMove();reject(Error('爸爸抓住了身体或改变了动作'));};
        timer=setTimeout(()=>reject(Error('拾取动作播放超时，可重试')),22000);
        this.switchTo(asset,true);
        const watch=()=>{
          if(this.ac.signal.aborted||this.sleeping||this.bodyProtected||this.dragState.active||this.tokenScene?.dragging){this.cancelBody();return;}
          const video=this.front===0?this.videoA:this.videoB;
          if(!played&&this.anim===asset&&!this.pending&&video.readyState>=2&&!video.paused){
            played=true;front=video;void post('playing').catch(()=>{});
            if(c.index===0){this.facing=c.coin.x*VIEW.w<this.pos.x+this.halfW?'left':'right';this.moveToCenter(c.coin.x,(c.coin.y*VIEW.h-this.height+this.halfH)/VIEW.h,'line',Math.min(6000,Math.max(300,video.duration*600)));}
            ended=()=>resolve();video.addEventListener('ended',ended,{once:true});
          }
          if(played&&(video!==front||this.anim!==asset)){reject(Error('拾取动作被打断'));return;}
          frame=requestAnimationFrame(watch);
        };frame=requestAnimationFrame(watch);
      });
      await post('completed',{played,x:(this.pos.x+this.halfW)/VIEW.w,y:(this.pos.y+this.height)/VIEW.h});
    }catch(e){if(!this.ac.signal.aborted&&!/爸爸抓住|身体被抓住|已收起/.test(e.message))this.tokenScene?.announce(e.message);await post('interrupted',{reason:e.message}).catch(()=>{});}
    finally{clearTimeout(timer);cancelAnimationFrame(frame);if(front&&ended)front.removeEventListener('ended',ended);this.bodyExecuting=false;this.pickupCoinId=null;this.cancelBody=null;if(!this.ac.signal.aborted){this.pollTokenSoon();if(!this.bodyProtected&&!this.sleeping)this.playIdle();}}
  };
  // A stable desktop canvas: only the character moves inside it. The floor layer
  // never inherits a moving OS window origin. Transparent regions still pass through.
  proto.fitWindow=function(){
    if(CONFIG.fixedDesktopCanvas){
      this.tokenOrigin={x:0,y:0};
      this.applyWinOffset(this.pos.x,this.pos.y);
      return {x:0,y:0,width:VIEW.w,height:VIEW.h,offsetX:this.pos.x,offsetY:this.pos.y};
    }
    const fit=old.fitWindow.call(this),coins=this.tokenScene?.tokens?.coins.filter(c=>c.surface==='desktop')||[];
    if(!coins.length){this.tokenOrigin={x:fit.x,y:fit.y};return fit;}
    const next={x:0,y:0,width:VIEW.w,height:VIEW.h,offsetX:fit.x+fit.offsetX,offsetY:fit.y+fit.offsetY};this.tokenOrigin={x:0,y:0};this.applyWinOffset(next.offsetX,next.offsetY);return next;
  };
  proto.reportWindow=function(fit){old.reportWindow.call(this,fit);this.tokenScene?.paint();if(this.inputRegionElements)this.syncInputRegions();};
  proto.dispose=function(...args){clearTimeout(this.tokenClickTimer);this.stopTokenSpaceWatch();this.unsubscribeTokenSpace?.();this.tokenScene?.dispose();return old.dispose.apply(this,args);};
})();
