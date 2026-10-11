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
    preferOctaves = 0.6,
  } = {}) {
    Object.assign(this, { hopSec, windowSec, minBpm, maxBpm, preferBpm, preferOctaves });
    this.cap = Math.round(windowSec / hopSec);
    this.times = [];
    this.values = [];
    this.grid = null;
    this._pendingPeriod = null;
    this._pendingCount = 0;
    this._phaseJumpCount = 0;
  }

  reset() {
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
    const acv = new Float32Array(2 * maxLag + 2);
    for (let l = Math.max(1, minLag - 1); l <= Math.min(2 * maxLag + 1, N - 1); l++) acv[l] = ac(l);
    let best = -1, bestScore = -Infinity;
    const score = new Float32Array(maxLag + 2);
    for (let l = minLag; l <= maxLag; l++) {
      const bpm = (60 * fps) / l;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / this.preferBpm) / this.preferOctaves) ** 2);
      const s = (acv[l] + 0.5 * (acv[2 * l] || 0)) * prior;
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
    const confidence = Math.max(0, Math.min(1, acv[best] / ac0));
    let period = lag * this.hopSec;

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
        s += w * (env[i] + 0.5 * (env[i - 1] + env[i + 1]) + 0.25 * (env[i - 2] + (env[i + 2] || 0)));
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

    this.grid = { period, anchor, bpm: 60 / period, confidence, t: times[N - 1] };
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
