// Online beat tracker. Takes the onset envelope (one value per hop) and keeps a beat grid:
// { period, anchor, bpm, confidence } where beats fall at anchor + k * period (seconds).
//
// Tempo: autocorrelation of the recent envelope with a log-normal prior centred on typical
// Kizomba tempos. Phase: comb filter over the recent envelope, weighted towards the latest
// beats, then smoothed with a simple phase-locked loop so the grid does not jitter.

export class BeatTracker {
  constructor({
    hopSec = 0.01,
    windowSec = 8,
    minBpm = 60,
    maxBpm = 150,
    preferBpm = 92,
    preferOctaves = 0.4,
    // Weights of the autocorrelation at 2 and 4 beats (half bar / bar). The true beat repeats at
    // the bar level, while the 3-3-2 Kizomba rhythm makes a strong but misleading peak at ¾ beat.
    w2 = 0.5,
    w4 = 0.5,
  } = {}) {
    Object.assign(this, { hopSec, windowSec, minBpm, maxBpm, preferBpm, preferOctaves, w2, w4 });
    this.cap = Math.round(windowSec / hopSec);
    this.times = [];
    this.values = [];
    this.grid = null;
    this._pendingPeriod = null;
    this._pendingCount = 0;
    this._phaseJumpCount = 0;
    this._stable = 0; // how many of the last 12 updates agreed with the running grid
    this._agree = [];
  }

  reset() {
    this._stable = 0;
    this._agree = [];
    this.times = [];
    this.values = [];
    this.grid = null;
    this._pendingPeriod = null;
    this._pendingCount = 0;
    this._phaseJumpCount = 0;
  }

  addFrame(t, value) {
    const n = this.times.length;
    if (n && t <= this.times[n - 1]) {
      // Clock jumped backwards (e.g. a seek): start over.
      if (this.times[n - 1] - t > 0.5) this.reset();
      else return;
    }
    this.times.push(t);
    this.values.push(value);
    if (this.times.length > this.cap * 1.5) {
      const drop = this.times.length - this.cap;
      this.times.splice(0, drop);
      this.values.splice(0, drop);
    }
  }

  // Phase of time t within the beat (0 = on the beat, 0.5 = halfway / the "and").
  static phaseAt(grid, t) {
    const x = (t - grid.anchor) / grid.period;
    return x - Math.floor(x);
  }

  update() {
    const N = Math.min(this.times.length, this.cap);
    if (N * this.hopSec < 4) return this.grid;
    const off = this.times.length - N;
    const raw = this.values.slice(off);
    const times = this.times.slice(off);
    const fps = 1 / this.hopSec;

    // Remove the slowly varying loudness level and keep the positive "attacks".
    const half = Math.round(0.25 * fps);
    const env = new Float32Array(N);
    let acc = 0;
    const prefix = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + raw[i];
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - half), b = Math.min(N, i + half + 1);
      const v = raw[i] - (prefix[b] - prefix[a]) / (b - a);
      env[i] = v > 0 ? v : 0;
      acc += env[i];
    }
    const mean = acc / N;
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = env[i] - mean;

    // --- Tempo via autocorrelation ---
    const minLag = Math.floor((60 / this.maxBpm) * fps);
    const maxLag = Math.ceil((60 / this.minBpm) * fps);
    const ac = (lag) => {
      let s = 0;
      for (let i = 0; i + lag < N; i++) s += x[i] * x[i + lag];
      return s / (N - lag);
    };
    const ac0 = ac(0);
    if (ac0 <= 1e-12) return this.grid;
    const acv = new Float32Array(4 * maxLag + 2);
    const acAt = (l) => {
      if (l >= N - 1) return 0;
      if (!acv[l]) acv[l] = ac(l) || 1e-30;
      return acv[l];
    };
    let best = -1, bestScore = -Infinity;
    const score = new Float32Array(maxLag + 2);
    for (let l = minLag; l <= maxLag; l++) {
      const bpm = (60 * fps) / l;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / this.preferBpm) / this.preferOctaves) ** 2);
      const s = (acAt(l) + this.w2 * acAt(2 * l) + this.w4 * acAt(4 * l)) * prior;
      score[l] = s;
      if (s > bestScore) { bestScore = s; best = l; }
    }
    if (best < 0) return this.grid;
    let lag = best;
    if (best > minLag && best < maxLag) {
      const a = score[best - 1], b = score[best], c = score[best + 1];
      const den = a - 2 * b + c;
      if (den < 0) lag = best + (0.5 * (a - c)) / den;
    }
    const confidence = Math.max(0, Math.min(1, acAt(best) / ac0));
    // How much the chosen tempo stands out from the other candidate tempos.
    let acMean = 0;
    for (let l = minLag; l <= maxLag; l++) acMean += acAt(l);
    acMean /= maxLag - minLag + 1;
    const tempoContrast = (acAt(best) - acMean) / ac0;
    let period = lag * this.hopSec;
    const tempoAgrees = !!this.grid && Math.abs(period / this.grid.period - 1) < 0.04;

    // Tempo hysteresis: small changes are smoothed, big jumps must persist.
    if (this.grid) {
      const ratio = period / this.grid.period;
      if (Math.abs(ratio - 1) < 0.05) {
        period = 0.85 * this.grid.period + 0.15 * period;
        this._pendingCount = 0;
      } else {
        if (this._pendingPeriod && Math.abs(period / this._pendingPeriod - 1) < 0.05) this._pendingCount++;
        else { this._pendingPeriod = period; this._pendingCount = 1; }
        if (this._pendingCount < 4) period = this.grid.period;
        else this._pendingCount = 0;
      }
    }

    // --- Phase via comb filter (recent beats weigh more) ---
    const P = period * fps;
    const steps = Math.ceil(P);
    let bestPhase = 0, bestComb = -Infinity;
    for (let ph = 0; ph < steps; ph++) {
      let s = 0;
      for (let k = 0; ; k++) {
        const pos = N - 1 - ph - k * P;
        if (pos < 2) break;
        const i = Math.round(pos);
        const w = Math.exp(-k / 6);
        s += w * (env[i] + 0.5 * (env[i - 1] + (env[i + 1] || 0)) + 0.25 * (env[i - 2] + (env[i + 2] || 0)));
      }
      if (s > bestComb) { bestComb = s; bestPhase = ph; }
    }
    let anchor = times[N - 1] - bestPhase * this.hopSec;

    if (this.grid) {
      // PLL: move the previous grid towards the measured phase instead of jumping.
      const prev = this.grid;
      const k = Math.round((anchor - prev.anchor) / prev.period);
      const predicted = prev.anchor + k * prev.period;
      let err = anchor - predicted;
      // Track how many of the last 12 updates agreed with the running grid on both tempo and beat
      // position. Music does this update after update; speech and noise do not.
      this._agree.push(tempoAgrees && Math.abs(err) < 0.1 * period ? 1 : 0);
      if (this._agree.length > 12) this._agree.shift();
      this._stable = this._agree.reduce((a, b) => a + b, 0);
      const big = Math.abs(err) > 0.2 * period;
      if (big) this._phaseJumpCount++;
      else this._phaseJumpCount = 0;
      if (!big || this._phaseJumpCount < 4) {
        const gain = big ? 0 : 0.35;
        anchor = predicted + gain * err;
      } else {
        this._phaseJumpCount = 0;
      }
    }

    this.grid = { period, anchor, bpm: 60 / period, confidence, tempoContrast, stable: this._stable, t: times[N - 1] };
    return this.grid;
  }
}

// Offline helper: runs the online tracker over a precomputed envelope and returns a list of
// grid snapshots so that gridAt(t) can be looked up for any media time t. A short look-ahead
// makes the grid already locked at the very start of the track.
export function precomputeGrids(frames, hopSec, { stepSec = 0.25, lookAheadSec = 2, ...opts } = {}) {
  const tracker = new BeatTracker({ hopSec, ...opts });
  const grids = [];
  let fi = 0;
  const end = frames.length ? frames[frames.length - 1].t : 0;
  for (let t = 0; t <= end + stepSec; t += stepSec) {
    while (fi < frames.length && frames[fi].t <= t + lookAheadSec) {
      tracker.addFrame(frames[fi].t, frames[fi].value);
      fi++;
    }
    const g = tracker.update();
    if (g) grids.push({ ...g, at: t });
  }
  return grids;
}

// Is this grid trustworthy enough to judge dancing against? Most of the recent updates must
// agree on tempo and beat position, and the tempo must stand out from other candidates.
// Tuned on real Kizomba recordings vs. speech and noise (see test/e2e/tempo-bench.mjs).
export const LOCK = { minStable: 7, minConfidence: 0.04, minContrast: 0.08 };
export function isLocked(grid) {
  return !!grid && grid.stable >= LOCK.minStable && grid.confidence > LOCK.minConfidence && grid.tempoContrast > LOCK.minContrast;
}

export function gridAt(grids, t) {
  if (!grids.length) return null;
  let lo = 0, hi = grids.length - 1;
  if (t <= grids[0].at) return grids[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (grids[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  return grids[lo];
}
