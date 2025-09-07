/* ...existing code... */
export class AudioEngine {
  constructor(reportFn = () => {}) {
    this.ctx = null;
    this.master = null; // user volume
    this.bus = null;    // session fade bus
    this.files = [];
    this.current = null;
    this.nextTimer = null;
    this.scrubTimer = null;
    this.playing = false;
    this.silence = 0.2;
    this.hr = 80;
    this.motion = 0;
    this.report = reportFn;
    this.minSegment = 0.8;
    this.explore = false; this.lockedTrack = null; this.lockUntil = 0;
    this.totalTime = 0; this.silentTime = 0;
    this.layers = []; this.space = 0.2; this._lastScrubAt = 0; this.userVol = 0.8;
  }

  async ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = this.userVol; this.master.connect(this.ctx.destination);
      this.bus = this.ctx.createGain(); this.bus.gain.value = 0; this.bus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setVolume(v) {
    this.userVol = Math.max(0, Math.min(1, v || 0));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.userVol, this.ctx.currentTime, 0.15);
  }

  async loadFiles(files) {
    await this.ensureCtx();
    const loaded = [];
    for (const f of files) {
      const ab = await f.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      loaded.push({ name: f.name, buffer: buf, duration: buf.duration });
    }
    this.files = loaded;
    return loaded;
  }

  setSilence(v) {
    this.space = Math.max(0, Math.min(1, v));
  }

  setMinSegment(v) {
    this.minSegment = Math.max(0.05, v || 0.5);
  }

  setExploreMode(v) {
    this.explore = !!v;
    if (!this.explore) { this.lockedTrack = null; this.lockUntil = 0; this.report('Explore mode off'); }
    else {
      const now = this.ctx ? this.ctx.currentTime : 0;
      if (this.current?.track) { this.lockedTrack = this.current.track; this.lockUntil = now + this._exploreHold(); }
      this.report('Explore mode on: focusing on one track for longer windows');
    }
  }

  async start() {
    if (!this.files.length) throw new Error('No files loaded.');
    await this.ensureCtx();
    this.playing = true;
    const now = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setValueAtTime(this.bus.gain.value || 0, now);
    this.bus.gain.linearRampToValueAtTime(1, now + 1.8);
    this._playNewSegment(true);
    this._startScrubLoop();
    this.totalTime = 0; this.silentTime = 0;
  }

  stop() {
    this.playing = false;
    const now = this.ctx?.currentTime || 0;
    if (this.bus) this.bus.gain.linearRampToValueAtTime(0, now + 2.0);
    setTimeout(() => { this._stopCurrent(); this.layers.forEach(l=>{try{l.src.stop();}catch{}}); this.layers=[]; }, 2100);
    clearTimeout(this.nextTimer);
    clearInterval(this.scrubTimer);
    this.lockedTrack = null; this.lockUntil = 0;
  }

  updateHeartRate(bpm = 80) {
    this.hr = bpm || 80;
    const rate = this._rateFromHR(this.hr);
    if (this.current?.src && Math.abs(this.current.src.playbackRate.value - rate) > 0.01) this.current.src.playbackRate.value = rate;
    this.layers.forEach(l => { if (l.src && Math.abs(l.src.playbackRate.value - rate) > 0.01) l.src.playbackRate.value = rate; });
    this.report(`Heart rate ${this.hr} bpm: playback ${rate.toFixed(2)}x`);
  }

  updateMotion(g = 0) {
    this.motion = g;
    // messaging handled in scrub loop to avoid spam
  }

  _rateFromHR(bpm) {
    const min=50, max=140, clamped = Math.min(max, Math.max(min, bpm));
    return 0.85 + (clamped - min) / (max - min) * (1.15 - 0.85);
  }

  _activity(){ const hrN=Math.min(1,Math.max(0,(this.hr-50)/90)); const gN=Math.min(1,this.motion/1.0); return 0.6*hrN+0.4*gN; }

  _pickTrack() {
    const now = this.ctx?.currentTime || 0;
    if (this.explore && this.lockedTrack && now < this.lockUntil) return this.lockedTrack;
    const t = this.files[Math.floor(Math.random() * this.files.length)];
    if (this.explore) {
      this.lockedTrack = t; this.lockUntil = now + this._exploreHold();
      this.report(`Exploring "${t.name}" for ~${Math.round(this.lockUntil - now)}s`);
    }
    return t;
  }

  _exploreHold() { return 20 + Math.random() * 50; } // 20–70s hold

  _stopCurrent() {
    if (this.current?.src) {
      try { this.current.src.stop(); } catch {}
    }
    this.current = null;
  }

  _startScrubLoop() {
    clearInterval(this.scrubTimer);
    let lastMsgAt = 0;
    this.scrubTimer = setInterval(() => {
      if (!this.playing || !this.current) return;
      const g = this.motion, now = this.ctx.currentTime;
      const intensity = Math.min(1, Math.max(0, (g - 0.05) / 0.95));
      if (intensity > 0.05 && (performance.now() - this._lastScrubAt) > 500) {
        const buf = this.current.track.buffer;
        const scrub = Math.min(3, Math.max(0.3, 0.3 + 2.7*intensity));
        const newOffset = Math.min(buf.duration - 0.05, (this.current.offset || 0) + scrub);
        this._restartAt(newOffset); this._lastScrubAt = performance.now();
        if (now - lastMsgAt > 1.0) { this.report(`Motion ${g.toFixed(2)}g: scrub +${Math.round(scrub*1000)}ms`); lastMsgAt = now; }
      }
      this._updateLayers();
    }, 250);
  }

  _updateLayers() {
    if (!this.playing || !this.files.length) return;
    const hr = this.hr, g = this.motion;
    const strength = (hr>100?1:0) + (g>0.2?1:0) + ((hr>120||g>0.6)?1:0);
    const density = (1 - this.space);
    const desired = Math.max(0, Math.min(3, Math.floor(strength * density * density)));
    if (Math.random() < (this.space < 0.85 ? this.space : 0.985)) return; // aggressive throttle when space is very high
    while (this.layers.length < desired) {
      const t = this.files[Math.floor(Math.random()*this.files.length)];
      const off = Math.random()*Math.max(0, t.duration-1);
      const dur = Math.min(8, Math.max(this.minSegment, 3 + Math.random()*4));
      const now = this.ctx.currentTime, endAt = now + dur;
      const gNode = this.ctx.createGain(); gNode.gain.setValueAtTime(0, now); gNode.connect(this.bus);
      const s = this.ctx.createBufferSource(); s.buffer = t.buffer; s.playbackRate.value = this._rateFromHR(this.hr); s.connect(gNode);
      gNode.gain.linearRampToValueAtTime(1.0, now + Math.min(4, dur*0.3)); gNode.gain.setValueAtTime(1.0, endAt - Math.min(4, dur*0.3)); gNode.gain.linearRampToValueAtTime(0, endAt);
      try { s.start(now, off); s.stop(endAt); } catch {}
      this.layers.push({ src: s, track: t, gainNode: gNode, endAt });
      this.report(`Layer + "${t.name}" for ${Math.round(dur*1000)}ms`);
    }
  }

  _restartAt(offset) {
    if (!this.current) return;
    const xf = 0.6, now = this.ctx.currentTime;
    const old = this.current, oldGain = old.gainNode;
    const newGain = this.ctx.createGain(); newGain.gain.setValueAtTime(0, now); newGain.connect(this.bus);
    const src = this.ctx.createBufferSource(); src.buffer = old.track.buffer; src.playbackRate.value = this._rateFromHR(this.hr); src.connect(newGain);
    try { oldGain.gain.cancelScheduledValues(now); } catch {}
    oldGain.gain.setValueAtTime(oldGain.gain.value, now); oldGain.gain.linearRampToValueAtTime(0, now + xf);
    newGain.gain.linearRampToValueAtTime(1, now + xf);
    try { src.start(now + 0.005, offset); old.src.stop(now + xf + 0.01); } catch {}
    this.current = { src, track: old.track, gainNode: newGain, offset };
  }

  _playNewSegment(first = false) {
    if (!this.playing) return;
    /* skip starting bed when space is high and activity is low */
    const act = this._activity();
    if (this.space > 0.5 && act < (0.35 + 0.5*(1 - this.space))) {
      clearTimeout(this.nextTimer);
      const delay = this._spaceGap();
      this.report(`Space ${Math.round(this.space*100)}%: pausing ~${Math.round(delay)}s (activity ${act.toFixed(2)})`);
      this.nextTimer = setTimeout(() => this._playNewSegment(), delay * 1000);
      return;
    }
    const segDur = this._segmentDuration();
    const track = this.lockedTrack || this._pickTrack();
    const offset = Math.random() * Math.max(0, track.duration - 1);
    const gainNode = this.ctx.createGain(); gainNode.connect(this.bus);
    const src = this.ctx.createBufferSource(); src.buffer = track.buffer;
    src.playbackRate.value = this._rateFromHR(this.hr); src.connect(gainNode);
    const now2 = this.ctx.currentTime; // bed track (quiet)
    gainNode.gain.setValueAtTime(0, now2); gainNode.gain.linearRampToValueAtTime(0.45, now2 + 1.5);
    const endAt = now2 + segDur; gainNode.gain.setValueAtTime(0.45, endAt - 1.5); gainNode.gain.linearRampToValueAtTime(0, endAt);
    try { src.start(now2, offset); } catch {}
    this.current = { src, track, gainNode, offset };
    this.report(`Bed "${track.name}" @ ${src.playbackRate.value.toFixed(2)}x from ${Math.round(offset)}s for ${Math.round(segDur*1000)}ms`);
    clearTimeout(this.nextTimer);
    const enforcedGap = this.space > 0.5 ? Math.max(this._spaceGap(), segDur * this.space) * (this.space >= 0.9 ? 2.5 : 1) : this._spaceGap();
    this.nextTimer = setTimeout(() => this._playNewSegment(), (segDur + enforcedGap) * 1000);
  }

  _segmentDuration() {
    // 6–18s base varying with HR, then shorten as space increases
    const t = 1 - (Math.min(140, Math.max(50, this.hr)) - 50) / 90;
    const base = Math.max(this.minSegment, 6 + t * 12); // 6..18s
    const spaceFactor = 1 - 0.65 * this.space;         // more space => shorter segments
    return Math.max(this.minSegment, base * spaceFactor);
  }

  _spaceGap() {
    // Much longer gaps when space is high; also longer when ring activity is low
    const f = this.space;
    if (f < 0.25) return 0;
    const base = Math.max(0, (f - 0.25) / 0.75); // 0..1
    let gap = 3 + base * 32 * (0.7 + Math.random()*0.6); // ~3..35s
    const act = this._activity();
    gap *= (0.7 + (1 - act) * 0.9); // up to ~1.6x longer when very low activity
    if (this.space >= 0.9) gap *= 2.5; // much longer gaps at 90%+
    return gap;
  }
}