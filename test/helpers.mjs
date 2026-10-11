// Synthetic Kizomba-like drum loop with exactly known beat times.
export function synthKizomba({ bpm = 90, seconds = 20, sr = 22050, offset = 0.137, hatGain = 0.8, kickGain = 0.9, rimGain = 0.3, seed = 1 } = {}) {
  const out = new Float32Array(Math.round(seconds * sr));
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const P = 60 / bpm;
  const beats = [];
  const add = (t0, fn, dur) => {
    const i0 = Math.round(t0 * sr), n = Math.round(dur * sr);
    for (let i = 0; i < n && i0 + i < out.length; i++) if (i0 + i >= 0) out[i0 + i] += fn(i / sr);
  };
  for (let k = 0; offset + k * P < seconds; k++) {
    const tb = offset + k * P;
    beats.push(tb);
    // kick on every beat
    add(tb, (t) => Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * kickGain, 0.35);
    // snare / clap on beats 2 and 4
    if (k % 2 === 1) add(tb, (t) => rnd() * Math.exp(-t * 25) * 0.5, 0.2);
    // hats on the "and" (off-beat) – deliberately loud to make phase locking non-trivial
    add(tb + P / 2, (t) => rnd() * Math.exp(-t * 60) * hatGain, 0.08);
    // tresillo-ish rim on 16th positions 3 and 6 of each pair of beats
    if (k % 2 === 0) for (const q of [0, 3, 6]) add(tb + (q * P) / 4, (t) => Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 80) * rimGain, 0.05);
  }
  return { samples: out, sr, beats, period: P };
}

export function wrapBeats(x) {
  return x - Math.round(x);
}

// Random, non-periodic clicks and noise bursts (speech-like onsets without a beat).
export function synthRandomOnsets({ seconds = 20, sr = 22050, rate = 4, seed = 7 } = {}) {
  const out = new Float32Array(Math.round(seconds * sr));
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < seconds; t += -Math.log(1 - rnd()) / rate) {
    const i0 = Math.round(t * sr), f = 150 + 600 * rnd(), g = 0.2 + 0.6 * rnd();
    for (let i = 0; i < 0.12 * sr && i0 + i < out.length; i++) out[i0 + i] += Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / sr / 0.04) * g;
  }
  return { samples: out, sr };
}
