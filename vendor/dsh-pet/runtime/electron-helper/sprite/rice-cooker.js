'use strict';

const COOKER_ASSETS = '../../assets/rice-cooker/';

class DesktopRiceCooker {
  constructor(root, source) {
    this.root = root;
    this.source = source;
    this.count = 1;
    this.generation = 0;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.launcher = document.createElement('button');
    this.launcher.type = 'button';
    this.launcher.className = 'rice-cooker-launcher';
    this.launcher.setAttribute('aria-controls', 'rice-cooker-details');
    this.launcher.setAttribute('aria-label', '电饭锅');
    this.launcher.innerHTML = `
      <span class="rice-cooker-art">
        <img class="rice-cooker-body" alt="" draggable="false">
        <span class="rice-cooker-fill" aria-hidden="true" hidden><img class="rice-cooker-mound" alt=""></span>
        <span class="rice-cooker-steam" aria-hidden="true"><i></i><i></i></span>
      </span>
      <span class="rice-cooker-caption"></span>`;
    this.image = this.launcher.querySelector('.rice-cooker-body');
    this.art = this.launcher.querySelector('.rice-cooker-art');
    this.fill = this.launcher.querySelector('.rice-cooker-fill');
    this.mound = this.fill.querySelector('img');
    this.mound.src = COOKER_ASSETS+'mound.png';
    this.caption = this.launcher.querySelector('.rice-cooker-caption');
    this.panel = document.createElement('section');
    this.panel.id = 'rice-cooker-details';
    this.panel.className = 'rice-cooker-panel';
    this.panel.setAttribute('aria-labelledby', 'rice-cooker-title');
    this.panel.innerHTML = `
      <div class="rice-cooker-header">
        <h2 id="rice-cooker-title">大肥鱼的电饭锅</h2>
        <button type="button" class="rice-cooker-close" aria-label="收起电饭锅详情"></button>
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
    this.launcher.addEventListener('click', event => {
      if (event.detail && this.suppressClick) return;
      if (this.expanded) this.close();
      else this.open();
    });
    this.closeButton.addEventListener('click', () => this.close());
    this.launcher.addEventListener('pointerdown', event => this.startDrag(event));
    this.launcher.addEventListener('pointermove', event => this.moveDrag(event));
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.launcher.addEventListener(name, event => this.endDrag(event));
    }
    root.addEventListener('pointermove', () => this.source.pointer());
    this.quantity.addEventListener('click', event => {
      if (!event.target.dataset.step) return;
      this.count += Number(event.target.dataset.step);
      this.paint();
    });
    this.submit.addEventListener('click', () => void this.act());
    source.onOpen(() => this.open());
    source.onPanelSide(below => {
      if (this.panelBelow === below) return;
      this.panelBelow = below;
      root.classList.toggle('panel-below', below);
      this.layout();
    });
    for (const element of [this.launcher,this.panel]) {
      element.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !this.expanded) return;
        event.stopPropagation();
        this.close();
      });
    }
    this.launcher.hidden = this.panel.hidden = true;
    root.append(this.panel, this.launcher);
    const artSize = Number(new URLSearchParams(location.search).get('size'));
    this.launcher.style.width = (artSize > 0 ? artSize : 150) + 'px';
    this.layout();
    setInterval(() => void this.poll(), 1250);
    setInterval(() => this.paintClock(), 250);
    void this.poll();
  }

  startDrag(event) {
    if (event.button !== 0 || this.drag) return;
    this.suppressClick = false;
    this.drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
    this.launcher.setPointerCapture(event.pointerId);
    this.source.drag('start', event.screenX, event.screenY);
  }

  moveDrag(event) {
    const drag = this.drag;
    if (drag?.id !== event.pointerId) return;
    if (!this.suppressClick && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < 4) return;
    this.suppressClick = true;
    this.launcher.classList.add('is-dragging');
    this.source.drag('move', event.screenX, event.screenY);
  }

  endDrag(event) {
    if (this.drag?.id !== event.pointerId) return;
    this.drag = null;
    this.launcher.classList.remove('is-dragging');
    this.source.drag('end', event.screenX, event.screenY);
  }

  open() {
    this.manual = !this.hasFood();
    this.expanded = true;
    this.feedback('');
    this.paint();
    this.source.focus();
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
      const state = await this.source.request({action:'snapshot'});
      if (generation === this.generation) this.accept(state);
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
    if (finished && !this.reduceMotion.matches) {
      this.lidOpensAt = performance.now()+550;
      this.steamUntil = this.lidOpensAt+1450;
    }
    if (this.hasFood()) this.manual = false;
    if (!this.hasFood() && !this.manual) this.expanded = false;
    this.paint();
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
      const send = () => this.source.request(request);
      const state = await send().catch(send);
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
      this.paint();
      void this.poll();
    }
  }

  feedback(text) {
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  paintClock() {
    const {batch,remaining,reserved} = this.state??{};
    const now = performance.now();
    const showingSteam = !this.reduceMotion.matches && (Boolean(batch) || Boolean(remaining) && now<(this.steamUntil??0));
    const closed = Boolean(batch) || (showingSteam && now<(this.lidOpensAt??0));
    const asset = closed?'closed.png':'empty.png';
    this.launcher.dataset.steaming = String(showingSteam);
    this.fill.hidden = closed || !remaining;
    if (remaining && this.moundBowls!==remaining) {
      const amount = Math.min(remaining,6)/6;
      this.moundBowls = remaining;
      this.mound.style.setProperty('--rice-width',String(.66+.34*amount));
      this.mound.style.setProperty('--rice-height',String(.23+.77*amount));
    }
    const artChanged = this.asset !== asset;
    if (artChanged) {
      this.asset = asset;
      this.image.src = COOKER_ASSETS+asset;
      this.launcher.dataset.lidClosed = String(closed);
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
    const captionChanged = this.caption.textContent !== caption;
    if (captionChanged) this.caption.textContent = caption;
    if (this.status.textContent !== status) this.status.textContent = status;
    this.launcher.setAttribute('aria-label',batch?`电饭锅，正在煮 ${batch.bowls} 碗`:`电饭锅，${caption}`);
    if (artChanged || captionChanged) this.layout();
  }

  paint() {
    const {availableIds=[],maxBowls,reminderId,batch,remaining,raw} = this.state??{};
    this.launcher.hidden = !this.hasFood() && !this.manual;
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
  }

  layout() {
    let layout = { visible: false };
    if (!this.launcher.hidden) {
      const measure = element => element.getBoundingClientRect().toJSON();
      const { width, height } = measure(this.root);
      const art = measure(this.art);
      // Match the clickable area to the opaque portion of the cooker artwork.
      const grip = { x: art.x + art.width * .12, y: art.y + art.width * .025,
        width: art.width * .76, height: art.height - art.width * .06 };
      layout = { visible: true, width, height, art, grip, launcher: measure(this.launcher),
        caption: measure(this.caption), panel: this.panel.hidden ? null : measure(this.panel),
        panelBelow: Boolean(this.panelBelow) };
    }
    const key = JSON.stringify(layout);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.source.layout(layout);
  }
}

const cooker = new DesktopRiceCooker(document.querySelector('#cooker'), window.cookerBridge);
