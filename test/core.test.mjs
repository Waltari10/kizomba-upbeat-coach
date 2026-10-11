import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onsetEnvelope, OnsetDetector } from '../src/core/onset.js';
import { BeatTracker, precomputeGrids, gridAt } from '../src/core/beatTracker.js';
import { BounceAnalyzer } from '../src/core/bounce.js';
import { synthKizomba, wrapBeats } from './helpers.mjs';

for (const bpm of [80, 90, 100, 120]) {
  test(`beat tracker locks tempo and phase on a synthetic ${bpm} BPM kizomba loop`, () => {
    const { samples, sr, beats, period } = synthKizomba({ bpm });
    const { frames, hopSec } = onsetEnvelope(samples, sr);
    const tracker = new BeatTracker({ hopSec });
    let grid;
    for (const f of frames) tracker.addFrame(f.t, f.value);
    for (let i = 0; i < 5; i++) grid = tracker.update();
    assert.ok(grid, 'grid');
    assert.ok(Math.abs(grid.bpm - bpm) / bpm < 0.02, `bpm ${grid.bpm}`);
    const phaseErr = wrapBeats((grid.anchor - beats[0]) / period);
    assert.ok(Math.abs(phaseErr) < 0.06, `phase error ${phaseErr} beats`);
  });
}

test('streaming detector gives the same frames as offline envelope', () => {
  const { samples, sr } = synthKizomba({ seconds: 3 });
  const det = new OnsetDetector(sr);
  const streamed = [];
  for (let i = 0; i < samples.length; i += 128) streamed.push(...det.push(samples.subarray(i, i + 128)));
  const { frames } = onsetEnvelope(samples, sr);
  assert.equal(streamed.length, frames.length);
  assert.ok(Math.abs(streamed[50].value - frames[50].value) < 1e-9);
});

test('precomputed grids follow the beat over the whole track', () => {
  const { samples, sr, beats, period } = synthKizomba({ bpm: 94, seconds: 25 });
  const { frames, hopSec } = onsetEnvelope(samples, sr);
  const grids = precomputeGrids(frames, hopSec);
  for (const t of [1, 5, 12, 22]) {
    const g = gridAt(grids, t);
    assert.ok(Math.abs(wrapBeats((g.anchor - beats[0]) / period)) < 0.08, `at ${t}s`);
  }
});

function simulateDancer({ bpm = 90, peakOffsetBeats, amp = 0.05, noise = 0.004, fps = 30, seconds = 10, seed = 3 }) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const P = 60 / bpm;
  const grid = { period: P, anchor: 0.3 };
  const a = new BounceAnalyzer();
  for (let t = 0; t < seconds; t += 1 / fps + rnd() * 0.004) {
    const h = -2.2 + 0.01 * t + amp * Math.cos((2 * Math.PI * (t - grid.anchor)) / P - 2 * Math.PI * peakOffsetBeats) + noise * rnd();
    a.addSample(t, h);
  }
  return a.analyze(seconds - 0.05, grid);
}

test('rising on the beat is classified as upbeat', () => {
  const r = simulateDancer({ peakOffsetBeats: 0.05 });
  assert.equal(r.status, 'up');
  assert.ok(Math.abs(r.offset - 0.05) < 0.03, `offset ${r.offset}`);
  assert.ok(r.alignment > 0.9);
});

test('sinking on the beat is classified as downbeat', () => {
  const r = simulateDancer({ peakOffsetBeats: 0.5 });
  assert.equal(r.status, 'down');
  assert.ok(r.alignment < -0.9);
});

test('a dancer standing still is reported as still', () => {
  const r = simulateDancer({ peakOffsetBeats: 0, amp: 0.002 });
  assert.equal(r.status, 'still');
});

test('non-rhythmic movement is reported as irregular', () => {
  let s = 9;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const a = new BounceAnalyzer();
  let h = 0;
  for (let t = 0; t < 10; t += 1 / 30) { h += rnd() * 0.02; a.addSample(t, h + 0.03 * rnd()); }
  const r = a.analyze(9.99, { period: 0.66, anchor: 0 });
  assert.notEqual(r.status, 'up');
  assert.notEqual(r.status, 'down');
});
