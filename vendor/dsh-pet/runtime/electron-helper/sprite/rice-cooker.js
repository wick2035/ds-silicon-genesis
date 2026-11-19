'use strict';

const COOKER_ASSETS = '../../assets/rice-cooker/';

class DesktopRiceCooker {
  constructor(pet) {
    this.pet = pet;
    this.source = window.petBridge;
    this.count = 1;
    this.generation = 0;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.launcher = document.createElement('button');
    this.launcher.type = 'button';
    this.launcher.className = 'rice-cooker-launcher';
    this.launcher.setAttribute('aria-controls', 'rice-cooker-details');
    this.launcher.setAttribute('aria-label', '电饭锅');
    this.launcher.innerHTML = '<span class="rice-cooker-art"><img alt=""><span class="rice-cooker-steam" aria-hidden="true"><i></i><i></i></span></span><span class="rice-cooker-caption"></span>';
    this.image = this.launcher.querySelector('img');
    this.caption = this.launcher.querySelector('.rice-cooker-caption');
    this.panel = document.createElement('section');
    this.panel.id = 'rice-cooker-details';
    this.panel.className = 'rice-cooker-panel';
    this.panel.setAttribute('aria-labelledby', 'rice-cooker-title');
    this.panel.innerHTML = `
      <div class="rice-cooker-header">
        <h2 id="rice-cooker-title">大肥鱼的电饭锅</h2>
        <button type="button" class="rice-cooker-close" aria-label="收起电饭锅详情">×</button>
      </div>
      <div class="rice-cooker-facts">
        <strong class="rice-cooker-status" role="status"></strong>
        <span class="rice-cooker-raw"></span>
      </div>
      <div class="rice-cooker-actions">
        <div class="rice-cooker-quantity" role="group" aria-label="盛饭碗数">
          <button type="button" data-step="-1" aria-label="少盛一碗">−</button>
          <output aria-live="polite"></output>
          <button type="button" data-step="1" aria-label="多盛一碗">+</button>
        </div>
        <button type="button" class="rice-cooker-submit"></button>
      </div>
      <p class="rice-cooker-message" role="status" hidden></p>`;
    this.status = this.panel.querySelector('.rice-cooker-status');
    this.raw = this.panel.querySelector('.rice-cooker-raw');
    this.quantity = this.panel.querySelector('.rice-cooker-quantity');
    this.output = this.quantity.querySelector('output');
    this.submit = this.panel.querySelector('.rice-cooker-submit');
    this.closeButton = this.panel.querySelector('.rice-cooker-close');
    this.message = this.panel.querySelector('.rice-cooker-message');
    [this.minus,this.plus] = this.quantity.querySelectorAll('button');
    const {signal} = pet.ac;
    this.launcher.addEventListener('click', () => this.expanded ? this.close() : this.open(), {signal});
    this.closeButton.addEventListener('click', () => this.close(), {signal});
    this.quantity.addEventListener('click', event => {
      if (!event.target.dataset.step) return;
      this.count += Number(event.target.dataset.step);
      this.paint();
    }, {signal});
    this.submit.addEventListener('click', () => void this.act(), {signal});
    window.addEventListener('resize', () => {
      this.layout();
      this.pet.syncInputRegions();
    }, {signal});
    for (const element of [this.launcher,this.panel]) {
      element.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !this.expanded) return;
        event.stopPropagation();
        this.close();
      }, {signal});
    }
    this.launcher.hidden = this.panel.hidden = true;
    pet.el.append(this.launcher,this.panel);
    this.pollTimer = setInterval(() => void this.poll(), 1250);
    this.clockTimer = setInterval(() => this.paintClock(), 250);
    void this.poll();
  }

  dispose() {
    clearInterval(this.pollTimer);
    clearInterval(this.clockTimer);
    this.launcher.remove();
    this.panel.remove();
  }

  open() {
    this.manual = !this.hasFood();
    this.expanded = true;
    this.feedback('');
    this.paint();
    this.source.requestKeyboardFocus();
    this.closeButton.focus({preventScroll:true});
    void this.poll();
  }

  close() {
    this.expanded = this.manual = false;
    this.paint();
    if (!this.launcher.hidden) this.launcher.focus({preventScroll:true});
  }

  hasFood() {
    return Boolean(this.state?.batch || this.state?.remaining);
  }

  async poll() {
    if (this.busy || this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      const state = await this.source.riceCooker({action:'snapshot'});
      if (generation === this.generation && !this.pet.ac.signal.aborted) this.accept(state);
    } catch {
      if (generation === this.generation) {
        this.connected = false;
        this.paint();
      }
    } finally {
      this.polling = false;
    }
  }

  accept(state) {
    if (!Array.isArray(state?.availableIds)) {
      this.connected = false;
      this.paint();
      return;
    }
    const finished = this.state?.batch && !state.batch && state.remaining>0;
    this.state = state;
    this.connected = true;
    this.clockOffset = state.now-Date.now();
    if (finished && !this.reduceMotion.matches) this.revealUntil = performance.now()+2000;
    if (this.hasFood()) this.manual = false;
    if (!this.hasFood() && !this.manual) this.expanded = false;
    this.paint();
    void this.reply();
  }

  async act() {
    if (!this.connected || this.busy || this.submit.disabled) return;
    const take = this.state.availableIds.length>0;
    const request = {action:take?'take':'remind',requestId:crypto.randomUUID(),
      ...(take?{expectedIds:[...this.state.availableIds],bowls:this.count}:{})};
    this.generation++;
    this.busy = true;
    this.feedback('');
    this.paint();
    try {
      // Reuse the request ID if the helper disconnected after committing.
      const send = () => this.source.riceCooker(request);
      const state = await send().catch(send);
      if (this.pet.ac.signal.aborted) return;
      if (state.ok === false) this.feedback(state.message);
      else {
        this.count = 1;
        this.accept(state);
        if (!take) this.feedback('已经提醒大肥鱼。');
      }
    } catch {
      this.feedback('刚才没连上电饭锅，请稍后再试。');
    } finally {
      this.busy = false;
      if (!this.pet.ac.signal.aborted) {
        this.paint();
        void this.poll();
      }
    }
  }

  feedback(text) {
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  async reply() {
    const reply = this.state.replies?.[0], now=Date.now();
    if (!reply || this.acking || document.hidden || this.pet.sleeping || this.pet.todoOpen || now<(this.replyAfter??0)) return;
    if (this.lastSpokenId!==reply.id) {
      if (now<(this.pet.careBubbleUntil??0)) return;
      const text = reply.remaining===0
        ? `爸盛走了${reply.bowls}碗，锅都空啦`
        : `爸盛走了${reply.bowls}碗，剩的${reply.remaining}碗给本鱼留着嘛`;
      this.pet.showCareReaction(text,6500);
      this.lastSpokenId = reply.id;
    }
    this.acking = true;
    try {
      const result=await this.source.riceCooker({action:'ack',requestId:reply.id});
      if (result.ok!==false) this.replyAfter = Date.now()+6500;
    } catch {
      // Keep the durable reply pending until the desktop is available again.
    } finally {
      this.acking = false;
    }
  }

  paintClock() {
    const {batch,remaining,reserved} = this.state??{};
    const revealing = !this.reduceMotion.matches && performance.now()<(this.revealUntil??0);
    const asset = revealing?'ready.gif':batch?'closed.png':remaining?'full.png':'empty.png';
    if (this.asset !== asset) {
      this.asset = asset;
      this.image.src = COOKER_ASSETS+asset;
    }
    let caption = '空锅', status = caption;
    if (batch) {
      const seconds = Math.max(0,Math.ceil((batch.readyAt-Date.now()-(this.clockOffset??0))/1000));
      const time = [Math.floor(seconds/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
      caption = seconds ? `煮 ${batch.bowls} 碗 · ${time}` : '正在确认出锅';
      status = `正在煮 ${batch.bowls} 碗${remaining?` · 另有 ${remaining} 碗熟饭`:''}`;
    } else if (remaining) {
      caption = `锅里还有 ${remaining} 碗`;
      status = reserved ? `${caption} · ${reserved} 碗在吃` : caption;
    }
    if (!this.connected) status = '电饭锅暂未连接';
    if (this.caption.textContent !== caption) this.caption.textContent = caption;
    if (this.status.textContent !== status) this.status.textContent = status;
    this.launcher.setAttribute('aria-label',batch?`电饭锅，正在煮 ${batch.bowls} 碗`:`电饭锅，${caption}`);
  }

  paint() {
    const {availableIds=[],maxBowls,reminderId,batch,remaining,raw} = this.state??{};
    this.launcher.hidden = !this.hasFood() && !this.manual;
    this.launcher.dataset.cooking = String(Boolean(batch));
    this.panel.hidden = !this.expanded;
    this.launcher.setAttribute('aria-expanded',String(Boolean(this.expanded)));
    const count = availableIds.length;
    this.count = Math.max(1,Math.min(count,this.count));
    this.raw.textContent = raw===undefined?'':`米缸 ${raw} 碗生米`;
    this.quantity.hidden = !count;
    this.output.value = String(this.count);
    this.minus.disabled = this.busy || !this.connected || this.count<=1;
    this.plus.disabled = this.busy || !this.connected || this.count>=count;
    this.submit.hidden = !count && Boolean(batch||remaining);
    this.submit.disabled = this.busy || !this.connected || (!count && (!maxBowls||Boolean(reminderId)));
    this.submit.textContent = count?`盛走 ${this.count} 碗`:reminderId?'已提醒':'提醒煮饭';
    this.paintClock();
    this.layout();
    this.pet.syncInputRegions();
  }

  layout() {
    if (this.launcher.hidden) return;
    const pet = this.pet, clamp = pet.visibleClampRect();
    if (!clamp) return;
    const {x:ox,y:oy} = pet.winOffset;
    const left = clamp.x-ox, right = left+clamp.w, top = clamp.y-oy, bottom = top+clamp.h;
    const width = Math.min(clamp.w,Math.max(88,Math.min(122,pet.size*.29)));
    const artHeight = this.state?.batch ? width*.66 : width;
    const height = artHeight+24, foot = pet.bottomPad+pet.height*S.FEET_Y/S.CANVAS_H;
    const besideRight = pet.hitRect.x+pet.hitRect.w+4, besideLeft = pet.hitRect.x-width-4;
    const rightRoom = right-besideRight, leftRoom = besideLeft+width-left;
    const preferred = rightRoom>=width || leftRoom<width && rightRoom>=leftRoom ? besideRight : besideLeft;
    const fit = (value,min,max) => Math.min(Math.max(min,max),Math.max(min,value));
    const x = fit(preferred,left,right-width), y = fit(foot-artHeight,top,bottom-height);
    const placement = [x,y,width].join(',');
    if (placement!==this.placement) {
      this.placement = placement;
      Object.assign(this.launcher.style,{left:x+'px',top:y+'px',width:width+'px'});
    }
    if (this.panel.hidden) return;
    const panelWidth = Math.min(236,clamp.w-8);
    const panelX = fit(x+(width-panelWidth)/2,left+4,right-panelWidth-4);
    this.panel.style.width = panelWidth+'px';
    const panelHeight = this.panel.offsetHeight;
    const panelY = fit(y-8-panelHeight>=top?y-8-panelHeight:y+height+8,top+4,bottom-panelHeight-4);
    Object.assign(this.panel.style,{left:panelX+'px',top:panelY+'px'});
  }
}
