import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapListener, HandClapDetector, estimateDelay, calibrationResult } from '../src/core/clap.js';

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

test('heard claps are found to within a millisecond, over background noise and hum', () => {
  const sr = 48000, rnd = rng(5);
  const x = new Float32Array(sr * 6);
  for (let i = 0; i < x.length; i++) x[i] = 0.01 * rnd() + 0.05 * Math.sin((2 * Math.PI * 50 * i) / sr);
  const claps = [0.8, 1.5, 2.31, 3.0, 3.77, 4.4, 5.2];
  for (const c of claps) {
    const i0 = Math.round(c * sr);
    for (let i = 0; i < 0.05 * sr; i++) x[i0 + i] += 0.6 * rnd() * Math.exp(-i / sr / 0.008);
  }
  const det = new ClapListener(sr);
  const found = [];
  for (let i = 0; i < x.length; i += 128) found.push(...det.push(x.subarray(i, i + 128)).map((n) => n / sr));
  assert.equal(found.length, claps.length, `found ${found}`);
  found.forEach((f, k) => assert.ok(Math.abs(f - claps[k]) < 0.001, `clap ${k}: ${f} vs ${claps[k]}`));
});

test('seen claps are timed between camera frames', () => {
  // Hands swing together and apart; contact at known times, sampled at 30 fps with jitter.
  const contacts = [1.0, 2.05, 3.1, 4.12, 5.2];
  const rnd = rng(11);
  const det = new HandClapDetector();
  const found = [];
  for (let t = 0.013; t < 6; t += 1 / 30) {
    let d = 1.2;
    for (const c of contacts) {
      const dt = t - c;
      if (dt > -0.25 && dt < 0) d = Math.min(d, 0.25 + 4 * -dt); // fast approach (~4 shoulder widths/s)
      if (dt >= 0 && dt < 0.3) d = Math.min(d, 0.25 + 3 * dt); // open again
    }
    found.push(...det.push(t, d + 0.005 * rnd()));
  }
  assert.equal(found.length, contacts.length, `found ${found}`);
  found.forEach((f, k) => assert.ok(Math.abs(f - contacts[k]) < 0.02, `clap ${k}: ${f.toFixed(3)} vs ${contacts[k]}`));
});

test('delay estimate: the delay where most claps line up, ignoring stray sounds', () => {
  const heard = [1, 2, 3, 4, 5, 6, 7, 8];
  const seen = [1.05, 2.06, 3.04, 4.05, 5.2, 6.05, 7.055, 8.045, 9.5];
  const r = estimateDelay(heard, seen);
  assert.ok(Math.abs(r.offset - 0.05) < 0.006, `offset ${r.offset}`);
  assert.equal(r.n, 7);
  assert.equal(r.rejected, 2);
  // Extra sounds (talking, a door) between the claps don't change the answer.
  const noisy = [...heard, 1.31, 2.52, 3.77, 4.2, 5.61, 6.33, 7.48, 7.9];
  assert.ok(Math.abs(estimateDelay(noisy, seen).offset - 0.05) < 0.006);
});

test('calibration quality gate', () => {
  assert.equal(calibrationResult({ offset: 0.04, spread: 0.01, n: 7, rejected: 1 }).ok, true);
  assert.equal(calibrationResult({ offset: 0.04, spread: 0.01, n: 3, rejected: 0 }).ok, false);
  assert.equal(calibrationResult({ offset: 0.04, spread: 0.06, n: 8, rejected: 0 }).ok, false);
  assert.equal(calibrationResult({ offset: 0.04, spread: 0.01, n: 5, rejected: 10 }).ok, false);
  assert.equal(calibrationResult({ n: 0 }).ok, false);
});
