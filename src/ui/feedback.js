// Audio feedback: short tones and/or spoken coaching. Tones are kept above ~600 Hz so that,
// when the music is picked up by the microphone, they do not disturb the (bass-weighted)
// beat detection.
import { perfToCtx } from '../audio/clock.js';

const PHRASES = {
  up: ['Nice, that\'s the up-beat', 'Good, keep rising on the beat', 'Yes! Up on the beat'],
  down: ['Rise on the beat', 'You\'re on the down-beat. Go up on the beat', 'Lift on the beat, sink on the and'],
  still: ['Bend your knees a little more', 'Add a small bounce'],
  halftime: ['Add a small lift on every beat', 'Bounce on every beat, not every other'],
  irregular: ['Keep a steady pulse', 'Find the pulse of the music'],
};

export class AudioFeedback {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'tones'; // 'off' | 'tones' | 'voice'
    this.beatClick = false;
    this.lastSpoken = 0;
    this.lastSpokenStatus = null;
    this.out = ctx.createGain();
    this.out.gain.value = 0.6;
    this.out.connect(ctx.destination);
    this.lastClickBeat = null;
  }

  _tone(freq, start, dur, peak = 0.25, type = 'sine', toFreq) {
    const t = start ?? this.ctx.currentTime + 0.01;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  good() {
    const t = this.ctx.currentTime + 0.01;
    this._tone(1319, t, 0.12, 0.18);
    this._tone(1760, t + 0.09, 0.2, 0.18);
  }

  bad() {
    const t = this.ctx.currentTime + 0.01;
    this._tone(740, t, 0.22, 0.2, 'triangle', 560);
  }

  // Called once per judged beat. `streak` = consecutive judgements with the same status.
  onJudgement(status, streak) {
    if (this.mode === 'tones') {
      if (status === 'down' && streak % 2 === 1) this.bad();
      else if (status === 'up' && (streak === 2 || streak % 8 === 0)) this.good();
    } else if (this.mode === 'voice') {
      const now = performance.now();
      const changed = status !== this.lastSpokenStatus;
      const gap = changed ? 3500 : 9000;
      const want = status === 'down' || status === 'still' || status === 'irregular' || status === 'halftime' || (status === 'up' && (changed || streak % 16 === 0));
      if (want && streak >= 2 && now - this.lastSpoken > gap) this.say(status);
    }
  }

  say(status) {
    if (!('speechSynthesis' in window)) return;
    const list = PHRASES[status];
    if (!list) return;
    const u = new SpeechSynthesisUtterance(list[Math.floor(Math.random() * list.length)]);
    u.rate = 1.05;
    u.volume = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    this.lastSpoken = performance.now();
    this.lastSpokenStatus = status;
  }

  // Optional high "tick" on every beat (helps to feel where to rise). Scheduled slightly ahead.
  scheduleClicks(grid, nowPerf) {
    if (!this.beatClick || !grid) return;
    const k = Math.ceil((nowPerf - grid.anchor) / grid.period);
    const beatPerf = grid.anchor + k * grid.period;
    if (beatPerf - nowPerf > 0.15) return;
    const key = Math.round(beatPerf * 20);
    if (this.lastClickBeat != null && Math.abs(key - this.lastClickBeat) < 5) return;
    this.lastClickBeat = key;
    const when = Math.max(this.ctx.currentTime, perfToCtx(this.ctx, beatPerf));
    this._tone(2600, when, 0.03, 0.12, 'square');
  }
}
