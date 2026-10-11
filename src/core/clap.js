// Delay calibration by clapping. Each clap is detected twice: in the microphone signal (a sharp,
// broadband burst of sound) and in the camera (the hands meeting). The median difference between
// the two is the camera-vs-microphone delay of this device. No musical timing is involved, so
// the result doesn't depend on how precisely the user claps.

// ---------- Audio ----------

// Streaming clap detector. push(samples) returns stream sample indices of clap onsets.
// A clap must be (1) well above the background, (2) loud in absolute terms, so rustling in a
// silent room doesn't count, and (3) bright: much of its energy above ~2 kHz, which footsteps,
// thuds and knocks don't have. Laptop and webcam mics dull claps, so a less bright sound still
// counts if it rises very sharply above the background (speech and footsteps don't).
export class ClapListener {
  constructor(sampleRate, {
    hopSec = 0.004, riseDb = 12, minDb = -45, minBrightShare = 0.3,
    sharpRiseDb = 25, minSharpBrightShare = 0.08, cutoffHz = 2000, minGapSec = 0.25,
  } = {}) {
    this.sr = sampleRate;
    this.hop = Math.max(1, Math.round(sampleRate * hopSec));
    this.rise = 10 ** (riseDb / 10);
    this.sharpRise = 10 ** (sharpRiseDb / 10);
    this.minEnergy = 10 ** (minDb / 10); // mean square of the high-passed signal over one hop
    this.minBrightShare = minBrightShare;
    this.minSharpBrightShare = minSharpBrightShare;
    this.minGap = Math.round(minGapSec * sampleRate);
    // 2nd-order Butterworth high-pass (RBJ cookbook).
    const w = (2 * Math.PI * cutoffHz) / sampleRate, alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
    this.b = [(1 + Math.cos(w)) / 2 / a0, -(1 + Math.cos(w)) / a0, (1 + Math.cos(w)) / 2 / a0];
    this.a = [(-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.acc = 0;
    this.accRaw = 0;
    this.inHop = 0;
    this.total = 0;
    this.floor = null; // slow-moving background energy per hop
    this.lastClap = -Infinity;
    // Recent high-passed samples, for refining the onset to the sample.
    this.ring = new Float32Array(Math.round(sampleRate * 0.1));
    this.pending = null; // candidate clap waiting for the rest of its burst
  }

  push(samples) {
    const out = [];
    const { ring } = this;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], { b, a } = this;
      const x = b[0] * s + b[1] * this.x1 + b[2] * this.x2 - a[0] * this.y1 - a[1] * this.y2;
      this.x2 = this.x1;
      this.x1 = s;
      this.y2 = this.y1;
      this.y1 = x;
      ring[this.total % ring.length] = x;
      this.total++;
      this.acc += x * x;
      this.accRaw += s * s;
      if (++this.inHop < this.hop) continue;
      const e = this.acc / this.hop + 1e-12;
      const hp = this.acc, raw = this.accRaw;
      const { pending } = this;
      if (pending) {
        pending.hp += hp;
        pending.raw += raw;
        pending.peak = Math.max(pending.peak, e);
      }
      this.acc = 0;
      this.accRaw = 0;
      this.inHop = 0;
      if (pending && this.total >= pending.until) {
        // Judge brightness over the whole burst: a thud starts with a short bright click too.
        const bright = pending.hp / (pending.raw + 1e-12);
        if (bright > this.minBrightShare || (bright > this.minSharpBrightShare && pending.peak > pending.floor * this.sharpRise)) {
          this.lastClap = pending.at;
          out.push(this._refine(pending.from, this.total));
        }
        this.pending = null;
      }
      if (this.floor == null) this.floor = e;
      const isCandidate = e > this.floor * this.rise && e > this.minEnergy && this.total - this.lastClap > this.minGap;
      if (isCandidate && !this.pending) {
        this.pending = {
          at: this.total, from: this.total - 2 * this.hop, until: this.total + Math.round(0.02 * this.sr),
          floor: this.floor, peak: e, hp, raw,
        };
      }
      // The floor follows quiet stretches quickly and loud ones slowly, so claps don't raise it much.
      const k = e > this.floor ? 0.01 : 0.2;
      this.floor += k * (e - this.floor);
    }
    return out;
  }

  // Onset = first sample whose magnitude reaches 30% of the clap's peak.
  _refine(from, to) {
    const { ring } = this;
    let peak = 0;
    for (let n = from; n < to; n++) peak = Math.max(peak, Math.abs(ring[n % ring.length]));
    for (let n = from; n < to; n++) if (Math.abs(ring[n % ring.length]) >= 0.3 * peak) return n;
    return from;
  }
}

// ---------- Video ----------

// Distance between the palms in shoulder widths, or null if the hands aren't visible.
// Palm centre ≈ midpoint of wrist (15/16) and index knuckle/finger (19/20).
export function palmDistance(lm) {
  if (!lm) return null;
  const ok = (i) => (lm[i]?.visibility ?? 1) > 0.3;
  if (![11, 12, 15, 16, 19, 20].every(ok)) return null;
  const palm = (w, f) => [(lm[w].x + lm[f].x) / 2, (lm[w].y + lm[f].y) / 2];
  const [lx, ly] = palm(15, 19), [rx, ry] = palm(16, 20);
  const shoulders = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y);
  if (shoulders < 0.02) return null;
  return Math.hypot(lx - rx, ly - ry) / shoulders;
}

// Streaming detector for the moment the hands meet. push(t, d) takes palm distance samples and
// returns the times of claps found so far. The contact time is where the line through the last
// two approaching samples reaches the closest distance, which works between frames (frames are
// 33 ms apart, hands close the last gap in less than that).
export class HandClapDetector {
  constructor({ closeBelow = 0.6, openAbove = 0.3 } = {}) {
    this.closeBelow = closeBelow; // palms closer than this (shoulder widths) can be a clap
    this.openAbove = openAbove; // hands must open by this much before and after
    this.pts = [];
    this.lastClapT = -Infinity;
  }

  push(t, d) {
    if (d == null) return [];
    const p = this.pts;
    p.push({ t, d });
    while (p.length && p[0].t < t - 1.5) p.shift();
    // Look for a local minimum at least 2 samples back, so we can see the hands open again.
    const out = [];
    for (let i = 2; i < p.length - 1; i++) {
      const m = p[i];
      if (m.t <= this.lastClapT + 0.2) continue;
      if (m.d > this.closeBelow || m.d > p[i - 1].d || m.d > p[i + 1].d) continue;
      const before = Math.max(...p.slice(0, i).filter((q) => q.t >= m.t - 0.6).map((q) => q.d));
      const after = p.slice(i + 1).filter((q) => q.t <= m.t + 0.6);
      if (!after.length || before - m.d < this.openAbove) continue;
      if (Math.max(...after.map((q) => q.d)) - m.d < this.openAbove) continue;
      const a = p[i - 2], b = p[i - 1];
      let tc = m.t;
      if (a.d > b.d && b.d > m.d) {
        // Approach line through a → b, extended to the minimum distance.
        const slope = (b.d - a.d) / (b.t - a.t);
        if (slope < 0) tc = Math.min(m.t, Math.max(b.t, b.t + (m.d - b.d) / slope));
      }
      this.lastClapT = m.t;
      out.push(tc);
    }
    return out;
  }
}

// ---------- Matching ----------

// Finds the delay at which the most seen claps line up with a heard clap (within ±tolSec), then
// refines it with the median of those pairs. Extra sounds (talking, a door, other people) don't
// line up consistently at any one delay, so they can't win. Returns offset = seen − heard in
// seconds; positive means the camera is late.
export function estimateDelay(heard, seen, { maxGapSec = 0.3, tolSec = 0.025, stepSec = 0.002 } = {}) {
  if (!heard.length || !seen.length) return { n: 0 };
  const sortedHeard = [...heard].sort((a, b) => a - b);
  const nearest = (t) => {
    let lo = 0, hi = sortedHeard.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedHeard[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const a = sortedHeard[lo], b = sortedHeard[lo - 1];
    return b !== undefined && Math.abs(b - t) < Math.abs(a - t) ? b : a;
  };
  const pairsAt = (o) => {
    const diffs = [];
    for (const v of seen) {
      const a = nearest(v - o);
      if (Math.abs(v - o - a) <= tolSec) diffs.push(v - a);
    }
    return diffs;
  };
  let best = null;
  for (let o = -maxGapSec; o <= maxGapSec + 1e-9; o += stepSec) {
    const n = pairsAt(o).length;
    if (!best || n > best.n) best = { o, n };
  }
  // Centre of the plateau of equally good offsets, then the median of the matched pairs.
  let lo = best.o, hi = best.o;
  while (lo - stepSec >= -maxGapSec && pairsAt(lo - stepSec).length === best.n) lo -= stepSec;
  while (hi + stepSec <= maxGapSec && pairsAt(hi + stepSec).length === best.n) hi += stepSec;
  const diffs = pairsAt((lo + hi) / 2).sort((a, b) => a - b);
  if (!diffs.length) return { n: 0 };
  const m = diffs.length >> 1;
  const offset = diffs.length % 2 ? diffs[m] : (diffs[m - 1] + diffs[m]) / 2;
  const spread = [...diffs.map((x) => Math.abs(x - offset))].sort((a, b) => a - b)[diffs.length >> 1];
  return { offset, spread, n: diffs.length, rejected: seen.length - diffs.length };
}

// Decides whether a delay estimate is trustworthy enough to save.
export const CALIBRATION = { minClaps: 5, minMatchedShare: 0.6, maxSpreadSec: 0.03, wantClaps: 8 };
export function calibrationResult(est) {
  if (!est || !est.n) return { ok: false, reason: 'No clap was both heard and seen.' };
  const share = est.n / (est.n + (est.rejected || 0));
  if (est.n < CALIBRATION.minClaps) return { ok: false, reason: `Only ${est.n} claps were both heard and seen; at least ${CALIBRATION.minClaps} are needed.` };
  if (share < CALIBRATION.minMatchedShare) return { ok: false, reason: 'Many claps were seen but not heard (or the other way round). Try a quieter room and louder claps.' };
  if (est.spread > CALIBRATION.maxSpreadSec) return { ok: false, reason: 'The claps did not agree with each other. Keep your hands clearly in view and clap sharply.' };
  return { ok: true, offsetMs: Math.round(est.offset * 1000), spreadMs: Math.round(est.spread * 1000), n: est.n };
}
