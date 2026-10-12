// Measures *when* in the beat the dancer's body is up and when it is down.
//
// We track the height of the hips (normalised by torso length so distance to the camera does
// not matter) and fit, over the last few beats, the model
//     h(t) = a + b·t + A·cos(θ − φ) + B·cos(θ/2 − ψ),   θ = 2π·(t − anchor)/period
// with least squares. The first oscillation is the once-per-beat bounce; its phase φ tells us
// where the highest point sits relative to the beat:
//   peak offset ≈ 0       → the body is UP on the beat (and down on the "and")  → UP-BEAT
//   peak offset ≈ ±½ beat → the body is DOWN on the beat (knees bend on the beat) → DOWN-BEAT
// The second (half-tempo) term soaks up movement that repeats every two beats — many Kizomba
// steps rise and fall over a pair of steps — so it does not get mistaken for noise. The fit also
// gives the bounce size (A) and how rhythmic the movement is (share of motion explained).

export function solve(M, v) {
  // Gaussian elimination with partial pivoting for a small dense system.
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

export const DEFAULTS = {
  windowBeats: 4,
  minAmplitude: 0.01, // in torso lengths (half of peak-to-peak); ≈ 0.5 cm for an adult
  minRhythmicity: 0.2,
  halfTimeRatio: 0.3, // per-beat bounce smaller than this × the two-beat movement → "half-time"
  upZone: 0.25, // |peak offset| below this many beats counts as "up on the beat"
};

export class BounceAnalyzer {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  addSample(t, height) {
    const s = this.samples;
    if (s.length && t <= s[s.length - 1].t) {
      if (s[s.length - 1].t - t > 0.5) this.reset();
      else return;
    }
    s.push({ t, h: height });
    while (s.length && s[0].t < t - 12) s.shift();
  }

  // Returns an analysis of the window ending at time t (seconds, same clock as samples/grid).
  analyze(t, grid) {
    const { windowBeats, minAmplitude, minRhythmicity, halfTimeRatio, upZone } = this.opts;
    if (!grid) return { status: 'no-beat' };
    const P = grid.period;
    const from = t - windowBeats * P;
    const pts = this.samples.filter((s) => s.t >= from && s.t <= t);
    if (pts.length < 16 || pts[0].t > from + 0.5 * P || t - pts[pts.length - 1].t > 0.5 * P) {
      return { status: 'insufficient' };
    }
    const w = (2 * Math.PI) / P;
    const tm = (from + t) / 2;
    const K = 6;
    // Basis [1, (t − tm), cos θ, sin θ, cos θ/2, sin θ/2]
    const rows = pts.map((p) => {
      const th = w * (p.t - grid.anchor);
      return [1, p.t - tm, Math.cos(th), Math.sin(th), Math.cos(th / 2), Math.sin(th / 2)];
    });
    const normal = (k) => {
      const M = Array.from({ length: k }, () => new Array(k).fill(0));
      const v = new Array(k).fill(0);
      rows.forEach((r, i) => {
        for (let a = 0; a < k; a++) {
          v[a] += r[a] * pts[i].h;
          for (let b = 0; b < k; b++) M[a][b] += r[a] * r[b];
        }
      });
      return solve(M, v);
    };
    const coef = normal(K);
    const trend = normal(2);
    if (!coef || !trend) return { status: 'insufficient' };
    let ssTrend = 0, ssRes = 0;
    rows.forEach((r, i) => {
      const h = pts[i].h;
      const et = h - (trend[0] + trend[1] * r[1]);
      let fit = 0;
      for (let k = 0; k < K; k++) fit += coef[k] * r[k];
      ssTrend += et * et;
      ssRes += (h - fit) ** 2;
    });
    const [, , c, d, c2, d2] = coef;
    const amplitude = Math.hypot(c, d);
    const halfAmplitude = Math.hypot(c2, d2);
    const rhythmicity = ssTrend > 0 ? Math.max(0, 1 - ssRes / ssTrend) : 0;
    let offset = Math.atan2(d, c) / (2 * Math.PI); // beats, peak position relative to beat
    if (offset > 0.5) offset -= 1;
    if (offset <= -0.5) offset += 1;
    const alignment = Math.cos(2 * Math.PI * offset); // +1 perfect upbeat, −1 perfect downbeat

    let status;
    if (Math.max(amplitude, halfAmplitude) < minAmplitude) status = 'still';
    else if (rhythmicity < minRhythmicity) status = 'irregular';
    else if (amplitude < minAmplitude || amplitude < halfTimeRatio * halfAmplitude) status = 'halftime';
    else status = Math.abs(offset) <= upZone ? 'up' : 'down';
    return { status, offset, alignment, amplitude, halfAmplitude, rhythmicity, samples: pts.length };
  }
}

// Height signal from MediaPipe pose landmarks (normalised image coords, y grows downward).
// Returns { hipY, torso, hipX, hipXa, shXa, ankleSpread } or null if the body is not visible
// enough. hipXa is hipX scaled by the aspect ratio (same units as hipY), shXa the same for the
// middle of the shoulders (null unless both are visible); ankleSpread is the sideways distance
// between the ankles in those units, or null when the feet are not visible.
export function hipHeight(landmarks, aspect = 1) {
  if (!landmarks) return null;
  const L = (i) => landmarks[i];
  const lh = L(23), rh = L(24), ls = L(11), rs = L(12);
  const vis = (p) => (p.visibility ?? 1) > 0.5;
  if (!lh || !rh || !ls || !rs || !vis(lh) || !vis(rh) || !(vis(ls) || vis(rs))) return null;
  const hipX = (lh.x + rh.x) / 2, hipY = (lh.y + rh.y) / 2;
  const shX = (ls.x + rs.x) / 2, shY = (ls.y + rs.y) / 2;
  const torso = Math.hypot((hipX - shX) * aspect, hipY - shY);
  if (torso < 0.03) return null;
  const la = L(27), ra = L(28);
  const ankleSpread = la && ra && vis(la) && vis(ra) ? Math.abs(la.x - ra.x) * aspect : null;
  const shXa = vis(ls) && vis(rs) ? shX * aspect : null;
  return { hipY, hipX, hipXa: hipX * aspect, shXa, torso, ankleSpread };
}

// Converts hip y positions into heights measured in torso lengths. The torso length is
// smoothed heavily so landmark jitter in the shoulders does not leak into the height signal.
export class HeightNormalizer {
  constructor(alpha = 0.03) {
    this.alpha = alpha;
    this.torso = null;
  }
  reset() {
    this.torso = null;
  }
  height(m) {
    this.torso = this.torso == null ? m.torso : this.torso + this.alpha * (m.torso - this.torso);
    return -m.hipY / this.torso;
  }
  // Sideways hip and shoulder positions and ankle spread in torso lengths (call after height()
  // for the frame).
  lateral(m) {
    const n = (v) => (v == null ? null : v / this.torso);
    return { x: n(m.hipXa), sx: n(m.shXa), spread: n(m.ankleSpread) };
  }
}
