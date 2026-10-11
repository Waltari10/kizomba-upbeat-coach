import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onsetEnvelope, OnsetDetector } from '../src/core/onset.js';
import { BeatTracker, precomputeGrids, gridAt, isLocked } from '../src/core/beatTracker.js';
import { BounceAnalyzer } from '../src/core/bounce.js';
import { synthKizomba, synthRandomOnsets, wrapBeats } from './helpers.mjs';

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

test('rising and falling over two beats is reported as half-time, not up/down', () => {
  const P = 60 / 92, grid = { period: P, anchor: 0.1 };
  const a = new BounceAnalyzer();
  for (let t = 0; t < 10; t += 1 / 30) a.addSample(t, 0.05 * Math.cos((Math.PI * (t - 0.1)) / P + 1.2));
  assert.equal(a.analyze(9.9, grid).status, 'halftime');
});

test('a per-beat lift on top of a two-beat sway is still judged', () => {
  const P = 60 / 92, grid = { period: P, anchor: 0.1 };
  const a = new BounceAnalyzer();
  for (let t = 0; t < 10; t += 1 / 30) {
    const th = (2 * Math.PI * (t - 0.1)) / P;
    a.addSample(t, 0.04 * Math.cos(th / 2 + 0.7) + 0.025 * Math.cos(th));
  }
  const r = a.analyze(9.9, grid);
  assert.equal(r.status, 'up');
  assert.ok(Math.abs(r.offset) < 0.05);
});

test('a real groove locks; random onsets (speech-like) do not', () => {
  const lockedShare = ({ samples, sr }) => {
    const { frames, hopSec } = onsetEnvelope(samples, sr);
    const grids = precomputeGrids(frames, hopSec, { lookAheadSec: 0 });
    let n = 0, ok = 0;
    for (let t = 6; t < 20; t += 0.5) { n++; if (isLocked(gridAt(grids, t))) ok++; }
    return ok / n;
  };
  assert.ok(lockedShare(synthKizomba({ bpm: 92 })) > 0.9);
  assert.ok(lockedShare(synthRandomOnsets()) < 0.2);
});

test('a groove dominated by a loud 3-3-2 rim pattern keeps the true tempo and phase', () => {
  const { samples, sr, beats, period } = synthKizomba({ bpm: 87, kickGain: 0.35, rimGain: 0.9, hatGain: 0.3, seconds: 24 });
  const { frames, hopSec } = onsetEnvelope(samples, sr);
  const grids = precomputeGrids(frames, hopSec);
  const g = gridAt(grids, 20);
  assert.ok(Math.abs(g.bpm / 87 - 1) < 0.03, `bpm ${g.bpm}`);
  assert.ok(Math.abs(wrapBeats((g.anchor - beats[0]) / period)) < 0.08);
});

import { cameraFrameTime, micInputDelay, CAMERA_DELAY_DEFAULT, MIC_DELAY_DEFAULT } from '../src/core/latency.js';

test('camera frames use the capture timestamp when the browser gives one', () => {
  const r = cameraFrameTime({ captureTime: 9950, presentationTime: 9990 }, 10000);
  assert.equal(r.source, 'timestamp');
  assert.ok(Math.abs(r.t - 9.95) < 1e-9);
});

test('camera frames without (or with implausible) capture stamps get the default delay', () => {
  for (const meta of [{ presentationTime: 9990 }, { captureTime: 20000, presentationTime: 9990 }, { captureTime: 1000, presentationTime: 9990 }]) {
    const r = cameraFrameTime(meta, 10000);
    assert.equal(r.source, 'estimate');
    assert.ok(Math.abs(r.t - (9.99 - CAMERA_DELAY_DEFAULT)) < 1e-9);
  }
});

test('microphone delay: reported latency if sane, otherwise the default', () => {
  assert.equal(micInputDelay({ getSettings: () => ({ latency: 0.04 }) }).delay, 0.04);
  assert.equal(micInputDelay({ getSettings: () => ({ latency: 3 }) }).delay, MIC_DELAY_DEFAULT);
  assert.equal(micInputDelay({ getSettings: () => ({}) }).delay, MIC_DELAY_DEFAULT);
  assert.equal(micInputDelay(undefined).delay, MIC_DELAY_DEFAULT);
});
