// Ambiance sonore 100 % procédurale (Web Audio, aucun fichier) : drone grave, vent, craquements lointains,
// battements de cœur et sons d'interface. Démarre au premier geste du joueur (règle d'autoplay des navigateurs).
import { onSettings } from './settings';

class Sound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private sfx!: GainNode;
  private verb!: ConvolverNode;
  private noise!: AudioBuffer;
  private vols = { master: 0.8, music: 0.7, sfx: 0.8 };
  private duck = 1; // ambiance baissée en partie
  private eventTimer = 0;

  constructor() {
    onSettings((s) => { this.vols = { master: s.master, music: s.music, sfx: s.sfx }; this.applyVolumes(); });
    const start = () => { this.start(); removeEventListener('pointerdown', start); removeEventListener('keydown', start); };
    addEventListener('pointerdown', start);
    addEventListener('keydown', start);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else this.ctx.resume();
    });
  }

  start() {
    if (this.ctx) return;
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.music = ctx.createGain(); this.music.connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.applyVolumes(0);

    // bruit blanc partagé + réverbération (réponse impulsionnelle générée : 3,5 s de queue)
    const n = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const len = ctx.sampleRate * 3.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    this.verb = ctx.createConvolver(); this.verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.5;
    this.verb.connect(wet).connect(this.music);

    this.drone();
    this.wind();
    this.scheduleEvent();
  }

  private applyVolumes(ramp = 0.4) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vols.master, t, ramp / 3 || 0.001);
    this.music.gain.setTargetAtTime(this.vols.music * this.duck, t, ramp / 3 || 0.001);
    this.sfx.gain.setTargetAtTime(this.vols.sfx, t, ramp / 3 || 0.001);
  }

  /** Ambiance pleine au menu, discrète en partie. */
  setInGame(on: boolean) { this.duck = on ? 0.3 : 1; this.applyVolumes(2); }

  private lfo(freq: number, depth: number, target: AudioParam) {
    const ctx = this.ctx!, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = depth;
    o.connect(g).connect(target); o.start();
  }

  private drone() {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 6;
    const g = ctx.createGain(); g.gain.value = 0.0;
    g.gain.setTargetAtTime(0.11, ctx.currentTime, 3);
    lp.connect(g); g.connect(this.music); g.connect(this.verb);
    this.lfo(0.05, 90, lp.frequency); // le filtre « respire »
    for (const [f, type] of [[43.65, 'sawtooth'], [43.9, 'sawtooth'], [65.4, 'triangle'], [92.5, 'sine']] as const) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      this.lfo(0.07 + Math.random() * 0.05, 0.6, o.detune);
      o.connect(lp); o.start();
    }
  }

  private wind() {
    const ctx = this.ctx!, src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0.05;
    this.lfo(0.09, 300, bp.frequency);
    this.lfo(0.13, 0.035, g.gain);
    src.connect(bp).connect(g).connect(this.music);
    src.start();
  }

  // Événements aléatoires : craquement de bois, battements de cœur, souffle
  private scheduleEvent() {
    clearTimeout(this.eventTimer);
    this.eventTimer = window.setTimeout(() => {
      if (this.ctx?.state === 'running') [() => this.creak(), () => this.heartbeat(), () => this.breath()][Math.floor(Math.random() * 3)]();
      this.scheduleEvent();
    }, 7000 + Math.random() * 12000);
  }

  private creak() {
    const ctx = this.ctx!, t = ctx.currentTime, o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70 + Math.random() * 40, t);
    o.frequency.linearRampToValueAtTime(140 + Math.random() * 80, t + 0.9);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 12;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 9; i++) g.gain.linearRampToValueAtTime(Math.random() * 0.12, t + i * 0.1); // grain irrégulier
    g.gain.linearRampToValueAtTime(0, t + 1);
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
    o.connect(bp).connect(g).connect(pan); pan.connect(this.verb); pan.connect(this.music);
    o.start(t); o.stop(t + 1.1);
  }

  private heartbeat() {
    const ctx = this.ctx!, t0 = ctx.currentTime;
    for (let b = 0; b < 4; b++) for (const off of [0, 0.28]) {
      const t = t0 + b * 0.95 + off, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(62, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(off ? 0.22 : 0.3, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.3);
    }
  }

  private breath() {
    const ctx = this.ctx!, t = ctx.currentTime, src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(700, t); bp.frequency.linearRampToValueAtTime(1300, t + 1.6);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.8); g.gain.linearRampToValueAtTime(0, t + 1.8);
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() < 0.5 ? -0.8 : 0.8;
    src.connect(bp).connect(g).connect(pan); pan.connect(this.verb); pan.connect(this.music);
    src.start(t, Math.random()); src.stop(t + 2);
  }

  // --- Interface
  private blip(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', to = freq) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfx); g.connect(this.verb);
    o.start(t); o.stop(t + dur + 0.02);
  }
  hover() { this.blip(1900, 0.05, 0.025, 'triangle', 1500); }
  click() { this.blip(180, 0.35, 0.22, 'sine', 55); this.blip(1240, 0.12, 0.03, 'square', 900); }
  back() { this.blip(420, 0.22, 0.08, 'triangle', 160); }
  error() { this.blip(110, 0.4, 0.12, 'sawtooth', 98); this.blip(116.5, 0.4, 0.1, 'sawtooth', 104); }
  success() { this.blip(392, 0.6, 0.05, 'sine', 392); setTimeout(() => this.blip(587, 0.9, 0.05, 'sine', 587), 120); }
  /** Coup sourd + montée : transition vers la partie, sortie. */
  stinger() {
    if (!this.ctx) return;
    this.blip(90, 1.6, 0.35, 'sine', 30);
    const ctx = this.ctx, t = ctx.currentTime, src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(200, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 1.2);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 1.1); g.gain.linearRampToValueAtTime(0, t + 1.3);
    src.connect(lp).connect(g).connect(this.verb); src.start(t); src.stop(t + 1.4);
  }
  fadeOut() { if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); }
  fadeIn() { this.applyVolumes(1); }
}

export const sound = new Sound();
