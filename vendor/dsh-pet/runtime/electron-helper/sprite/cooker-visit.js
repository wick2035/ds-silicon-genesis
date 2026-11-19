'use strict';

Object.assign(PetSprite.prototype, {
  attachRiceCooker() {
    this.cookerAttached = true;
    const bridge = window.petBridge;
    const unsubscribe = bridge.onRiceCookerUpdate(({ visit, reply }) => {
      if (visit) this.visitRiceCooker(visit);
      if (reply) void this.replyToRiceServing(reply);
    });
    this.ac.signal.addEventListener('abort', unsubscribe, { once: true });
    bridge.attachRiceCooker({
      x: toScreen(VIEW.x + this.pos.x + this.halfW),
      y: toScreen(VIEW.y + this.pos.y + this.bottomPad + this.height * S.FEET_Y / S.CANVAS_H),
      // The open pot's visible silhouette is 94% of its square artwork.
      size: this.hitRect.h / .94,
    });
  },

  visitRiceCooker({ id, x, y, width, height, area }) {
    if (this.cookerBatch === id || this.dragState.active || this.sleeping || this.frozen
      || this.bodyExecuting || this.bodyProtected || this.phoneUsing || this.throwRef !== null
      || this.menuOpen || this.todoOpen || this.chatOpen) return;

    const left = toLocal(x) - VIEW.x, right = toLocal(x + width) - VIEW.x;
    const floor = toLocal(y + height) - VIEW.y;
    const screenLeft = toLocal(area.x) - VIEW.x, screenRight = toLocal(area.x + area.width) - VIEW.x;
    const screenTop = toLocal(area.y) - VIEW.y, screenBottom = toLocal(area.y + area.height) - VIEW.y;
    const cx = this.pos.x + this.halfW, cy = this.pos.y + this.halfH;
    const gap = 8, halfBody = this.hitRect.w / 2;
    const footOffset = this.bottomPad + this.height * S.FEET_Y / S.CANVAS_H - this.halfH;
    const sideY = Math.max(screenTop + this.halfH - this.hitRect.y,
      Math.min(screenBottom - footOffset, floor - footOffset));
    const targets = [left - gap - halfBody, right + gap + halfBody]
      .filter(target => target - halfBody >= screenLeft && target + halfBody <= screenRight)
      .map(target => ({ x: target, y: sideY }));
    if (!targets.length) {
      const above = toLocal(y) - VIEW.y - gap - footOffset;
      const below = floor + gap + this.halfH - this.hitRect.y;
      targets.push({ x: (left + right) / 2, y: above + this.hitRect.y - this.halfH >= screenTop
        ? above : Math.min(below, screenBottom - footOffset) });
    }
    const distance = target => Math.hypot(target.x - cx, target.y - cy);
    targets.sort((a, b) => distance(a) - distance(b));
    const target = targets[0];
    this.cookerBatch = id;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const travel = distance(target);
    if (travel < 8) return;
    this.facing = target.x < cx ? 'left' : 'right';
    const run = this.animations.baifan?.[1] || this.animations.moves?.actions[0]?.name;
    if (!reduced && run) this.switchTo(run, false);
    this.moveToCenter(target.x / VIEW.w, target.y / VIEW.h, reduced ? 'instant' : 'line',
      Math.min(3400, Math.max(450, travel / Math.max(1, this.hitRect.h) * 440)));
    if (reduced || !run) return;
    const token = this.posFollowToken;
    const finish = () => {
      if (this.ac.signal.aborted || token !== this.posFollowToken) return;
      if (this.posFollow !== null) { requestAnimationFrame(finish); return; }
      if (this.anim === run) {
        this.facing = (left + right) / 2 < target.x ? 'left' : 'right';
        this.playOnce(S.pick(this.animations.idle, run));
      }
    };
    requestAnimationFrame(finish);
  },

  async replyToRiceServing(reply) {
    const now = Date.now();
    if (this.cookerAcking || document.hidden || this.sleeping || this.todoOpen || now < (this.cookerReplyAfter ?? 0)) return;
    if (this.cookerSpoken !== reply.id) {
      if (now < (this.careBubbleUntil ?? 0)) return;
      this.showCareReaction(reply.remaining === 0
        ? `爸盛走了${reply.bowls}碗，锅都空啦`
        : `爸盛走了${reply.bowls}碗，剩的${reply.remaining}碗给本鱼留着嘛`, 6500);
      this.cookerSpoken = reply.id;
    }
    this.cookerAcking = true;
    try {
      const result = await window.petBridge.acknowledgeRiceCookerReply(reply.id);
      if (result.ok !== false) this.cookerReplyAfter = Date.now() + 6500;
    } catch {
      // The host keeps the reply pending until the desktop can acknowledge it.
    } finally {
      this.cookerAcking = false;
    }
  },
});
