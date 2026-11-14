/* Actual boundary contacts drive this visual; it never modifies the physics trajectory. */
'use strict';
Object.assign(PetSprite.prototype, {
  initPainVisual(stage) {
    this.painStage = stage;
    const layer = document.createElement('div');
    layer.className = 'pet-pain';
    layer.setAttribute('aria-hidden', 'true');
    const portrait = document.createElement('img');
    portrait.className = 'pet-pain-portrait';
    portrait.alt = '';
    portrait.draggable = false;
    portrait.addEventListener('load', () => stage.classList.add('has-pain-art'));
    portrait.src = BASE + '/humanity/curled.png';
    layer.appendChild(portrait);
    for (let i = 0; i < 4; i++) {
      const drop = document.createElement('i');
      drop.className = 'pet-pain-drop';
      drop.style.setProperty('--drop-side', i % 2 ? '55%' : '44%');
      drop.style.setProperty('--drop-delay', (i * -.29) + 's');
      layer.appendChild(drop);
    }
    stage.appendChild(layer);
  },

  reportBoundaryPain(hit, origin = 'unknown') {
    // Normal speed BEFORE restitution: a fast glide along the floor is not an impact.
    // Lower the threshold so moderate knocks register; only a gentle settle stays silent.
    if (!hit || hit.speed < 200) return;
    const now = performance.now();
    // Debounce only rapid duplicates of the *same* frame's rebound, not distinct
    // walls hit in quick succession. A shorter window means four walls hit one
    // after another each leave their own pain instead of being swallowed.
    if ((this.lastPainContact ?? -Infinity) + 60 > now) return;
    this.lastPainContact = now;
    if (!this.sleeping) this.showPainReaction(hit.speed);
    window.petBridge.reportInteraction('collision',{edge:hit.edge,speed:hit.speed,origin}).then(async (data) => {
      if (!data.ok) throw new Error(data.message || '碰撞状态未保存');
      this.humanity = data.state;
      this.syncPainState(data.state);
    }).catch(error => console.warn('[dsh-pet] 碰撞状态未同步', error));
  },

  showPainReaction(speed, duration) {
    if (!this.painStage || this.sleeping || document.hidden) return;
    this.painStage.classList.add('is-crying');
    this.painStage.dataset.bodyPhase = 'startled';
    this.bodyProtected = true;
    this.stopMove();
    if (this.anim !== '工作状态-垂头叹气冒汗') this.switchTo('工作状态-垂头叹气冒汗', false);
    this.painStage.dataset.cry = speed >= 1200 ? 'loud' : 'soft';
    this.painUntil = performance.now() + (duration ?? Math.min(12000, 4500 + speed * 2));
    if (this.painTimer) clearTimeout(this.painTimer);
    // A local impact gets a protective pose immediately. Only a real state sample
    // releases it; an expired cry sound must never restore cheerful idle.
    this.painTimer = setTimeout(() => {
      if (this.humanity) this.syncPainState(this.humanity);
    }, Math.max(1000, this.painUntil - performance.now()));
    this.playSobSound();
  },

  syncPainState(state) {
    // A care animation can proceed while an existing injury remains recorded.
    // A new impact still interrupts it through showPainReaction.
    if (this.careVisual) return;
    if (this.sleeping) { this.stopPainReaction(); return; }
    if (!state.body) {
      const remaining=state.cryingUntil-Date.now();
      if (!state.crying || !Number.isFinite(remaining) || remaining<=0) { this.stopPainReaction(); return; }
      this.showPainReaction(state.collision?.speed || 550, remaining);return;
    }
    const phase = state.body?.phase || (state.crying ? 'curled' : 'well');
    if (phase === 'well') { this.stopPainReaction(); return; }
    const changed = this.painStage?.dataset.bodyPhase !== phase;
    this.bodyProtected = phase !== 'recovering';
    this.stopMove();
    this.painStage?.classList.add('is-crying');
    if (this.painStage) this.painStage.dataset.bodyPhase = phase;
    if (changed && (phase === 'startled' || phase === 'curled') && state.crying) this.playSobSound();
    // Keep the actual video underneath in a quiet recovery pose, never a random dance.
    const quiet = '工作状态-垂头叹气冒汗';
    if (phase !== 'curled' && this.anim !== quiet) this.switchTo(quiet, false);
  },

  stopPainReaction() {
    const wasProtected=this.bodyProtected;
    if (this.painTimer) clearTimeout(this.painTimer);
    this.painTimer = null;
    this.painUntil = 0;
    this.painStage?.classList.remove('is-crying');
    if (this.painStage) delete this.painStage.dataset.bodyPhase;
    this.bodyProtected = false;
    if(wasProtected&&!this.sleeping&&!this.ac?.signal.aborted)this.playIdle?.();
    if (this.sobTimer) clearTimeout(this.sobTimer);
    this.sobTimer = null;
    if (this.sobContext) { void this.sobContext.close().catch(() => {}); this.sobContext = null; }
  },

  playSobSound() {
    // A short toy-like vowel wail. Follow the existing sound-effects switch and volume.
    if (!config?.clickSoundEnabled || document.hidden || this.sobContext) return;
    const now = performance.now();
    if ((this.lastSobAt ?? -Infinity) + 6000 > now) return;
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    if (!AudioEngine) return;
    try {
      this.lastSobAt = now;
      const ctx = new AudioEngine();
      this.sobContext = ctx;
      const volume = ctx.createGain();
      volume.gain.value = .11 * Math.max(0, Math.min(1, Number.isFinite(config.voiceVolume) ? config.voiceVolume : 1));
      volume.connect(ctx.destination);
      for (const offset of [0, 1.05, 2.15]) {
        const start = ctx.currentTime + offset;
        const voice = ctx.createOscillator();
        voice.type = 'sawtooth';
        voice.frequency.setValueAtTime(470, start);
        voice.frequency.exponentialRampToValueAtTime(660, start + .18);
        voice.frequency.exponentialRampToValueAtTime(330, start + .82);
        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(.7, start + .09);
        envelope.gain.exponentialRampToValueAtTime(.001, start + .9);
        for (const [frequency, gain] of [[800, 1], [1250, .45]]) {
          const formant = ctx.createBiquadFilter();
          formant.type = 'bandpass'; formant.frequency.value = frequency; formant.Q.value = 3;
          const mix = ctx.createGain(); mix.gain.value = gain;
          voice.connect(formant); formant.connect(mix); mix.connect(envelope);
        }
        envelope.connect(volume); voice.start(start); voice.stop(start + .92);
      }
      void ctx.resume().catch(() => {});
      const close = () => { if (this.sobContext === ctx) this.sobContext = null; if (ctx.state !== 'closed') void ctx.close().catch(() => {}); };
      this.sobTimer = setTimeout(close, 3300);
    } catch (error) { console.warn('[dsh-pet] 哭泣音效暂不可用', error.message); }
  },
});
