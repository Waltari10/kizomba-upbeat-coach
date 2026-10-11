// A small built-in Kizomba / ghetto-zouk groove synthesised with Web Audio, for practising
// without external music. Its beat grid is known exactly, so no beat detection is needed.
import { ctxToPerf } from './clock.js';

const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C
  [55, 59, 62], // G
];
const midi = (m) => 440 * 2 ** ((m - 69) / 12);

export class PracticeBeat {
  constructor(ctx, bpm = 90) {
    this.ctx = ctx;
    this.bpm = bpm;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  get period() {
    return 60 / this.bpm;
  }

  start() {
    this.startCtx = this.ctx.currentTime + 0.15;
    this.nextStep = 0; // 16th-note index
    this.timer = setInterval(() => this._schedule(), 25);
    this._schedule();
  }

  stop() {
    clearInterval(this.timer);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  getGrid() {
    return { period: this.period, anchor: ctxToPerf(this.ctx, this.startCtx), bpm: this.bpm, confidence: 1 };
  }

  _schedule() {
    const step = this.period / 4;
    while (this.startCtx + this.nextStep * step < this.ctx.currentTime + 0.2) {
      const i = this.nextStep++;
      const t = this.startCtx + i * step;
      const pos = i % 16; // position within the bar
      const bar = Math.floor(i / 16);
      if (pos % 4 === 0) this._kick(t, pos === 0 || pos === 8 ? 1 : 0.75);
      if (pos === 4 || pos === 12) this._clap(t);
      if (pos % 4 === 2) this._hat(t, 0.25);
      if ([0, 3, 6, 8, 11, 14].includes(pos)) this._rim(t);
      const chord = CHORDS[bar % 4];
      if ([0, 3, 6, 8, 11].includes(pos)) this._bass(t, midi(chord[0] - 24 + (pos === 6 || pos === 11 ? 7 : 0)), step * 2.5);
      if (pos === 0) this._pad(t, chord, this.period * 4);
    }
  }

  _env(t, peak, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    g.connect(this.out);
    return g;
  }

  _kick(t, v) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    o.connect(this._env(t, 0.9 * v, 0.35));
    o.start(t);
    o.stop(t + 0.4);
  }

  _noiseHit(t, peak, decay, type, freq) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    s.connect(f);
    f.connect(this._env(t, peak, decay));
    s.start(t, Math.random() * 0.5);
    s.stop(t + decay + 0.05);
  }

  _clap(t) {
    this._noiseHit(t, 0.35, 0.18, 'bandpass', 1500);
  }

  _hat(t, v) {
    this._noiseHit(t, v, 0.05, 'highpass', 7000);
  }

  _rim(t) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 820;
    o.connect(this._env(t, 0.12, 0.06));
    o.start(t);
    o.stop(t + 0.08);
  }

  _bass(t, f, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    o.connect(lp);
    lp.connect(this._env(t, 0.35, dur));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _pad(t, chord, dur) {
    for (const m of chord) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midi(m);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.04, t + 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.out);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
}
