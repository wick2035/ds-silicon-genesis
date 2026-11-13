'use strict';
Object.assign(PetSprite.prototype, {
  async reportSpace() {
    if (this.spaceReporting || this.ac?.signal.aborted) return;
    const currentScreen = S.screenOfBox(this.throwSpaceOf(), this.pos.x, this.pos.y);
    const report = { surface: 'desktop', areas: AREAS, currentScreen };
    const key = JSON.stringify(report);
    if (this.lastSpaceReport === key) return;
    this.spaceReporting = true;
    try {
      const response = await window.petBridge.reportInteraction('space',report);
      if (response.ok) this.lastSpaceReport = key;
    } catch { /* The existing periodic loop retries failed observations. */ }
    finally { this.spaceReporting = false; }
  },
});
