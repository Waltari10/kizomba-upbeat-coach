// Checks the three parts of the Kizomba basic step, one step every N beats (stepBeats = 1, 2 or
// 4; slow steps are a common drill), plus the posture that goes with it:
//   1. Weight transfer – the hips travel sideways over the new standing foot.
//   2. Push up         – once the weight has arrived, push up from the floor (the high point).
//   3. Relax the hip   – soften and let the hip sink as it travels to the other foot, so seen
//                        from the front the hip draws a smiley face: high over each foot, low
//                        in the middle.
//   Shoulders still    – throughout, the shoulders hardly move sideways: the hips do the work,
//                        as if the upper body were standing between two walls.
//
// The steps alternate feet, so the hip sways sideways once every two steps while it rises and
// falls once per step. With θ = 2π·(t − anchor) / (N·beat) (one turn per step), we fit over the
// last four steps
//     x(t) = a + b·t + X·cos(θ/2 − ψ) + X₁·cos(θ − ψ₁)          (sideways, torso lengths)
//     h(t) = a + b·t + A·cos(θ − φ)   + B·cos(θ/2 − φ₂)          (height, torso lengths)
// For N = 1 the height fit is exactly the BounceAnalyzer's. The hip is over a foot (weight
// arrived) at the sideways extremes, θ = 2ψ (mod 2π). The lag
//     lag = (φ − 2ψ) / 2π  steps, wrapped to ±½
// is how long after the weight arrives the hip reaches its highest point:
//   lag ≈ 0 … +0.4 → transfer, then push up, then relax down in between  → a smile ‿
//   lag ≈ ±½       → the hip rises while travelling and drops over the foot → a frown ⁀
// (A teacher's basic side steps in a real video, one per beat, measured lag 0.1–0.4: the push
// up comes a moment after the weight lands.) With the bounce h = A·cos(θ − φ), the hip stands at
// A·cos(2π·lag) over each foot and its low point (−A) lies in the travel, so it dips
//     dip = A·(1 + cos(2π·lag))
// below the standing height between the feet: that dip is the relaxed hip, the smile.
// The sign of x (camera mirroring, which foot first) does not matter: flipping x moves ψ by π,
// which moves 2ψ by 2π.
//
// The shoulders get the same sideways fit as the hips; their step-rhythm sway must stay small,
// both in absolute terms and next to the hips' sway.
//
// For slow steps the once-per-beat up-beat analysis has nothing to measure, so the verdict comes
// from here: the high point (φ, in steps) should land on a beat, i.e. N·φ/2π near a whole number.

import { solve } from './bounce.js';

export const STEP_DEFAULTS = {
  stepBeats: 1, // beats per step: 1, 2 or 4
  windowSteps: 4,
  minSway: 0.06, // peak-to-peak sideways hip travel, torso lengths (≈ 3 cm)
  transferRatio: 0.3, // … and at least this share of the distance between the ankles
  minSwayRhythm: 0.3, // share of the sideways motion explained by the step rhythm
  minAmplitude: 0.01, // vertical bounce (half peak-to-peak), same as the BounceAnalyzer
  minRhythmicity: 0.2, // share of the up-and-down motion explained by the step rhythm
  upZone: 0.25, // |high point − nearest beat| below this many beats counts as on the beat
  pushLag: [-0.1, 0.45], // steps: high point from just before to almost ½ step after the weight arrives
  minDip: 0.01, // torso lengths (≈ 0.5 cm): how far the hip sinks between the feet
  // Shoulders: sideways sway (peak-to-peak, torso lengths) allowed is the larger of these two.
  maxShoulderSway: 0.05, // ≈ 2.5 cm
  // … or this share of the hips' sway. A teacher's basic steps measured 0.26–0.57 (quartiles);
  // moving the whole body as a block gives ≈ 1.
  maxShoulderRatio: 0.55,
};

const wrap = (x) => x - Math.round(x);

export class StepAnalyzer {
  constructor(opts = {}) {
    this.opts = { ...STEP_DEFAULTS, ...opts };
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  // All in torso lengths: h hip height, x sideways hip position, sx sideways shoulder position
  // (null if not visible), spread distance between the ankles (null when the feet are not
  // visible).
  addSample(t, { h, x, sx = null, spread = null }) {
    const s = this.samples;
    if (s.length && t <= s[s.length - 1].t) {
      if (s[s.length - 1].t - t > 0.5) this.reset();
      else return;
    }
    s.push({ t, h, x, sx, spread });
    while (s.length && s[0].t < t - 24) s.shift(); // four 4-beat steps at 70 BPM ≈ 14 s
  }

  analyze(t, grid) {
    const o = this.opts;
    if (!grid) return null;
    const N = o.stepBeats;
    const P = grid.period * N; // one step
    const from = t - o.windowSteps * P;
    const pts = this.samples.filter((s) => s.t >= from && s.t <= t);
    if (pts.length < 16 || pts[0].t > from + 0.5 * grid.period || t - pts[pts.length - 1].t > 0.5 * grid.period) return null;

    const w = (2 * Math.PI) / P;
    const tm = (from + t) / 2;
    const rows = pts.map((p) => {
      const th = w * (p.t - grid.anchor);
      return [1, p.t - tm, Math.cos(th / 2), Math.sin(th / 2), Math.cos(th), Math.sin(th)];
    });
    // Least-squares fit of one signal (over the samples that have it); returns the coefficients
    // and the share of the motion (around a straight trend) that the step rhythm explains.
    const fit = (key) => {
      const idx = pts.map((p, i) => (p[key] == null ? -1 : i)).filter((i) => i >= 0);
      if (idx.length < Math.max(16, pts.length / 2)) return null;
      const solveK = (k) => {
        const M = Array.from({ length: k }, () => new Array(k).fill(0));
        const v = new Array(k).fill(0);
        idx.forEach((i) => {
          const r = rows[i];
          for (let a = 0; a < k; a++) {
            v[a] += r[a] * pts[i][key];
            for (let b = 0; b < k; b++) M[a][b] += r[a] * r[b];
          }
        });
        return solve(M, v);
      };
      const coef = solveK(6), trend = solveK(2);
      if (!coef || !trend) return null;
      let ssTrend = 0, ssRes = 0;
      idx.forEach((i) => {
        const r = rows[i], y = pts[i][key];
        let f = 0;
        for (let k = 0; k < 6; k++) f += coef[k] * r[k];
        ssTrend += (y - trend[0] - trend[1] * r[1]) ** 2;
        ssRes += (y - f) ** 2;
      });
      return { coef, rhythm: ssTrend > 0 ? Math.max(0, 1 - ssRes / ssTrend) : 0 };
    };
    const fx = fit('x'), fh = fit('h');
    if (!fx || !fh) return null;
    const [, , c, d] = fx.coef;
    const sway = 2 * Math.hypot(c, d);
    const swayRhythm = fx.rhythm;
    const [, , , , hc, hd] = fh.coef;
    const amplitude = Math.hypot(hc, hd);
    const rhythmicity = fh.rhythm;
    const peak = Math.atan2(hd, hc) / (2 * Math.PI); // high point, in steps after the anchor
    const offset = wrap(N * peak); // beats from the nearest beat
    let status;
    if (amplitude < o.minAmplitude) status = 'still';
    else if (rhythmicity < o.minRhythmicity) status = 'irregular';
    else status = Math.abs(offset) <= o.upZone ? 'up' : 'down';
    const spreads = pts.map((p) => p.spread).filter((v) => v != null).sort((a, b) => a - b);
    const spread = spreads.length >= pts.length / 2 ? spreads[spreads.length >> 1] : null;
    const psi = Math.atan2(d, c);

    // 1. Weight transfer
    let transfer;
    if (sway < o.minSway || (spread != null && sway < o.transferRatio * spread)) transfer = 'small';
    else if (swayRhythm < o.minSwayRhythm) transfer = 'irregular';
    else transfer = 'ok';

    // 2. Push up and 3. relax need a vertical bounce, and the weight transfer as a reference
    // for when the weight arrives.
    let lag = null, smile = null, dip = null, push, relax;
    if (amplitude < o.minAmplitude) {
      push = 'none';
      relax = 'none';
    } else if (transfer !== 'ok') {
      push = 'unknown';
      relax = 'unknown';
    } else {
      lag = wrap(peak - psi / Math.PI);
      smile = Math.cos(2 * Math.PI * lag);
      dip = amplitude * (1 + smile);
      push = lag >= o.pushLag[0] && lag <= o.pushLag[1] ? 'ok' : 'early';
      relax = dip >= o.minDip ? 'ok' : smile < -0.5 ? 'frown' : 'flat';
    }
    // 4. Shoulders between two walls
    const fs = fit('sx');
    const shoulderSway = fs ? 2 * Math.hypot(fs.coef[2], fs.coef[3]) : null;
    const shoulders = shoulderSway == null ? 'unknown'
      : shoulderSway <= Math.max(o.maxShoulderSway, o.maxShoulderRatio * sway) ? 'ok' : 'moving';

    const steps = { transfer, push, relax, shoulders };
    // ('unknown' push/relax only happens after a missed transfer; unseen shoulders aren't a miss.)
    const firstMiss = ['transfer', 'push', 'relax', 'shoulders'].find((k) => steps[k] !== 'ok' && steps[k] !== 'unknown') ?? null;
    return { ...steps, firstMiss, sway, swayRhythm, spread, shoulderSway, lag, smile, dip, status, offset, amplitude, rhythmicity };
  }
}
