// Spectral-flux onset detector. Feed it mono audio in arbitrary chunks; it emits one
// onset-strength value every `hopSec` seconds. Low frequencies (kick drum / bass) are
// weighted extra, because in Kizomba the bass/kick marks the beat while the hi-hats and
// percussion often sit on the off-beats.

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export class OnsetDetector {
  constructor(sampleRate, { hopSec = 0.01, lowCutHz = 180, highCutHz = 8000, lowWeight = 2 } = {}) {
    this.sampleRate = sampleRate;
    this.hop = Math.max(1, Math.round(sampleRate * hopSec));
    this.hopSec = this.hop / sampleRate;
    this.n = sampleRate > 30000 ? 2048 : 1024;
    this.ring = new Float32Array(this.n);
    this.pos = 0;
    this.total = 0; // samples consumed so far
    this.sinceHop = 0;
    this.window = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n);
    const binHz = sampleRate / this.n;
    this.lowBin = Math.max(2, Math.ceil(lowCutHz / binHz));
    this.highBin = Math.min(this.n / 2 - 1, Math.floor(highCutHz / binHz));
    this.lowWeight = lowWeight;
    this.prev = new Float32Array(this.n / 2);
    this.re = new Float32Array(this.n);
    this.im = new Float32Array(this.n);
  }

  // Returns [{ sample, value }] where `sample` is the stream index of the analysis-window centre.
  push(samples) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.pos] = samples[i];
      this.pos = (this.pos + 1) % this.n;
      this.total++;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        if (this.total >= this.n) out.push({ sample: this.total - this.n / 2, value: this._frame() });
      }
    }
    return out;
  }

  _frame() {
    const { n, re, im, ring, window, prev } = this;
    for (let i = 0; i < n; i++) {
      re[i] = ring[(this.pos + i) % n] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let low = 0, all = 0;
    for (let b = 1; b <= this.highBin; b++) {
      const mag = Math.log1p(100 * Math.hypot(re[b], im[b]));
      const d = mag - prev[b];
      prev[b] = mag;
      if (d > 0) {
        all += d;
        if (b <= this.lowBin) low += d;
      }
    }
    return all / this.highBin + (this.lowWeight * low) / this.lowBin;
  }
}

// Convenience for offline analysis of a whole decoded track.
export function onsetEnvelope(samples, sampleRate, opts) {
  const det = new OnsetDetector(sampleRate, opts);
  const frames = [];
  const chunk = 8192;
  for (let i = 0; i < samples.length; i += chunk) {
    for (const f of det.push(samples.subarray(i, i + chunk))) frames.push({ t: f.sample / sampleRate, value: f.value });
  }
  return { frames, hopSec: det.hopSec };
}
