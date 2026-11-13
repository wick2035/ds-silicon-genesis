// Semantic input only: actual drag threshold crossing and release, never frames.
(() => {
  const proto = PetSprite.prototype;
  const old = Object.fromEntries(['onPointerMove','onPointerUp','startThrow','stopThrow','dragRiceProp','cancelRiceDrag','dispose','onMenuAction'].map(k => [k, proto[k]]));
  proto.lifeEvent = function(action, detail = {}) {
    if (this.ac?.signal.aborted) return;
    // Keep semantic transitions in order even when the network is slower than input.
    this.lifeDelivery = (this.lifeDelivery || Promise.resolve()).then(() => window.petBridge.reportInteraction('semantic',{action,...detail})).then(data=>{if(data?.reaction?.text)this.showInnerThought(data.reaction.text);}).catch(e=>{if(!this.ac?.signal.aborted)console.warn('[大肥鱼回应]',e.message);});
    return this.lifeDelivery;
  };
  proto.startThrow = function(...args) {
    const result = old.startThrow.apply(this, args);
    if (this.throwRef != null) this.lifeEvent('flight-start', { origin: args[4] === 'user-throw' ? 'user-throw' : 'unknown' });
    return result;
  };
  proto.stopThrow = function(...args) {
    const flying = this.throwRef != null;
    const result = old.stopThrow.apply(this, args);
    if (flying) this.lifeEvent('flight-end');
    return result;
  };
  proto.onPointerMove = function(e) {
    const before = this.dragState?.dragging;
    const result = old.onPointerMove.call(this, e);
    if (!before && this.dragState?.dragging) this.lifeEvent('drag-start');
    return result;
  };
  proto.onPointerUp = function(e) {
    const dragged = this.dragState?.dragging;
    const result = old.onPointerUp.call(this, e);
    if (dragged) this.lifeEvent('drag-end');
    return result;
  };
  proto.dragRiceProp = function(e) {
    const before = this.riceMoved;
    const result = old.dragRiceProp.call(this, e);
    if (!before && this.riceMoved) this.lifeEvent('prop-take');
    return result;
  };
  proto.cancelRiceDrag = function(...args) {
    const moved = this.riceDragging && this.riceMoved;
    const result = old.cancelRiceDrag.apply(this, args);
    if (moved) this.lifeEvent('prop-release');
    return result;
  };
  proto.dispose = function(...args) {
    if (this.dragState?.dragging) this.lifeEvent('drag-end');
    if (this.riceDragging && this.riceMoved) this.lifeEvent('prop-release');
    return old.dispose.apply(this, args);
  };
  proto.onMenuAction = function(leaf, keepFacing, fromHost) {
    const allowed = !fromHost && (!this.sleeping || this.frozen || S.isSleepAllowedAction(leaf.action));
    const result = old.onMenuAction.call(this, leaf, keepFacing, fromHost);
    if (allowed) {
      const action = leaf.anim ? 'menu-anim' : ({ home:'go-home', chat:'open-chat', humanity:'open-care', todo:'open-todo', 'show-balance':'show-balance' }[leaf.action]);
      if (action) this.lifeEvent(action);
    }
    return result;
  };
})();
