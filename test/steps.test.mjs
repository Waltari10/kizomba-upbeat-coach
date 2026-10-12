import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BounceAnalyzer } from '../src/core/bounce.js';
import { StepAnalyzer } from '../src/core/steps.js';

// A dancer stepping from foot to foot every `stepBeats` beats: the hips sway sideways once per
// two steps (sway = peak-to-peak) and rise/fall once per step. arriveBeats: when the weight
// arrives over a foot (sideways extreme), in steps; peakLagBeats: how long after that the hip is
// highest, in steps (= beats for one step per beat).
function simulate({ bpm = 92, stepBeats = 1, analyzerStepBeats = stepBeats, sway = 0.2, amp = 0.03, arriveBeats = 0.1, peakLagBeats = 0.05, spread = 0.35, shoulderShare = 0.2, mirror = false, noise = 0.004, seconds = 10 * stepBeats, seed = 5 }) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const P = 60 / bpm;
  const grid = { period: P, anchor: 0.2 };
  const steps = new StepAnalyzer({ stepBeats: analyzerStepBeats });
  for (let t = 0; t < seconds; t += 1 / 30 + rnd() * 0.003) {
    const th = (2 * Math.PI * (t - grid.anchor)) / (P * stepBeats);
    const x = (mirror ? -1 : 1) * (sway / 2) * Math.cos(th / 2 - Math.PI * arriveBeats) + 0.01 * t + noise * rnd();
    const h = -2.2 + amp * Math.cos(th - 2 * Math.PI * (arriveBeats + peakLagBeats)) + noise * rnd();
    // Shoulders follow a share of the hips' sway (0 = between two walls, 1 = whole body moves).
    const sx = shoulderShare == null ? null : shoulderShare * (x - 0.01 * t) + 0.5 + noise * rnd();
    steps.addSample(t, { h, x, sx, spread: spread == null ? null : spread + 0.02 * rnd() });
  }
  return steps.analyze(seconds - 0.05, grid);
}

test('transfer → push up → relax (a smile) passes all three steps', () => {
  const r = simulate({});
  assert.deepEqual([r.transfer, r.push, r.relax, r.shoulders], ['ok', 'ok', 'ok', 'ok']);
  assert.equal(r.firstMiss, null);
  assert.ok(Math.abs(r.lag - 0.05) < 0.04, `lag ${r.lag}`);
  assert.ok(r.smile > 0.9);
  assert.ok(Math.abs(r.sway - 0.2) < 0.02, `sway ${r.sway}`);
});

test('the result does not depend on mirroring or which foot goes first', () => {
  for (const opts of [{ mirror: true }, { arriveBeats: 1.1 }, { arriveBeats: 0.6, mirror: true }]) {
    const r = simulate(opts);
    assert.deepEqual([r.transfer, r.push, r.relax], ['ok', 'ok', 'ok'], JSON.stringify(opts));
  }
});

test('hips staying between the feet is a missing weight transfer', () => {
  const r = simulate({ sway: 0.04 });
  assert.equal(r.transfer, 'small');
  assert.equal(r.firstMiss, 'transfer');
  assert.equal(r.push, 'unknown');
});

test('a small sway relative to a wide stance is not a full transfer', () => {
  assert.equal(simulate({ sway: 0.1, spread: 0.6 }).transfer, 'small');
  assert.equal(simulate({ sway: 0.1, spread: null }).transfer, 'ok');
});

test('no rise at all: push up and relax are missing', () => {
  const r = simulate({ amp: 0.002 });
  assert.equal(r.transfer, 'ok');
  assert.equal(r.push, 'none');
  assert.equal(r.relax, 'none');
  assert.equal(r.firstMiss, 'push');
});

test('rising while travelling and dropping over the foot is a frown', () => {
  const r = simulate({ peakLagBeats: 0.5 });
  assert.equal(r.push, 'early');
  assert.equal(r.relax, 'frown');
  assert.ok(r.smile < -0.9);
});

test('pushing up before the weight has arrived is flagged', () => {
  const r = simulate({ peakLagBeats: -0.3 });
  assert.equal(r.push, 'early');
  assert.equal(r.firstMiss, 'push');
});

test('pushing up a moment after the weight lands (as teachers do) passes', () => {
  for (const peakLagBeats of [0.15, 0.3, 0.38]) {
    const r = simulate({ peakLagBeats, amp: 0.04 }); // the teacher's bounce in the reference video
    assert.deepEqual([r.push, r.relax], ['ok', 'ok'], `lag ${peakLagBeats}`);
  }
});

test('a hip that barely sinks between the feet fails the relax step', () => {
  // Push up is late enough that the hip is still high when it reaches the next foot.
  const r = simulate({ peakLagBeats: 0.43, amp: 0.02 });
  assert.equal(r.push, 'ok');
  assert.notEqual(r.relax, 'ok');
  assert.ok(r.dip < 0.01, `dip ${r.dip}`);
});

test('not enough data gives no result', () => {
  const steps = new StepAnalyzer();
  for (let t = 0; t < 1; t += 1 / 30) steps.addSample(t, { h: 0, x: 0 });
  assert.equal(steps.analyze(5, { period: 0.65, anchor: 0 }), null);
});

test('one step per beat: the height fit matches the BounceAnalyzer', () => {
  const P = 60 / 92, grid = { period: P, anchor: 0.2 };
  const bounce = new BounceAnalyzer(), steps = new StepAnalyzer();
  for (let t = 0; t < 10; t += 1 / 30) {
    const th = (2 * Math.PI * (t - 0.2)) / P;
    const h = 0.03 * Math.cos(th - 0.4) + 0.01 * Math.cos(th / 2 + 1);
    bounce.addSample(t, h);
    steps.addSample(t, { h, x: 0.1 * Math.cos(th / 2) });
  }
  const b = bounce.analyze(9.95, grid), r = steps.analyze(9.95, grid);
  assert.ok(Math.abs(b.offset - r.offset) < 1e-9 && Math.abs(b.amplitude - r.amplitude) < 1e-9);
  assert.equal(r.status, b.status);
});

for (const stepBeats of [2, 4]) {
  test(`slow steps (${stepBeats} beats per step) are judged at their own tempo`, () => {
    const r = simulate({ stepBeats, peakLagBeats: 0.15 });
    assert.deepEqual([r.transfer, r.push, r.relax], ['ok', 'ok', 'ok']);
    assert.ok(Math.abs(r.lag - 0.15) < 0.04, `lag ${r.lag}`);
    // Weight arrives at 0.1 step, high point 0.15 step later = 0.25·N beats after the anchor beat.
    const d = r.offset - 0.25 * stepBeats;
    assert.ok(Math.abs(d - Math.round(d)) < 0.05, `offset ${r.offset}`); // circular: ±½ beat are the same
    assert.equal(r.status, Math.abs(r.offset) <= 0.25 ? 'up' : 'down');
  });

  test(`slow steps (${stepBeats} beats per step): high point on a beat is up, between beats is down`, () => {
    // Weight arrives 0.1 step after a beat; the high point lands on beat 1 of the step, or half a beat later.
    const onBeat = simulate({ stepBeats, arriveBeats: 0, peakLagBeats: 1 / stepBeats });
    const offBeat = simulate({ stepBeats, arriveBeats: 0, peakLagBeats: 1.5 / stepBeats });
    assert.equal(onBeat.status, 'up');
    assert.equal(offBeat.status, 'down');
  });

  test(`slow steps (${stepBeats} beats per step) are not mistaken for steps on every beat`, () => {
    const r = simulate({ stepBeats, analyzerStepBeats: 1 });
    assert.notDeepEqual([r.transfer, r.push, r.relax], ['ok', 'ok', 'ok']);
  });
}

test('swaying the whole body (shoulders move with the hips) fails the shoulder check', () => {
  const r = simulate({ shoulderShare: 0.95 });
  assert.equal(r.shoulders, 'moving');
  assert.equal(r.firstMiss, 'shoulders');
  assert.ok(Math.abs(r.shoulderSway - 0.19) < 0.02, `shoulder sway ${r.shoulderSway}`);
});

test('shoulders that stay between two walls pass, also with slow steps', () => {
  for (const opts of [{ shoulderShare: 0 }, { shoulderShare: 0.3 }, { stepBeats: 2, shoulderShare: 0.1 }, { stepBeats: 4, shoulderShare: 0.95 }]) {
    const r = simulate(opts);
    assert.equal(r.shoulders, opts.shoulderShare > 0.5 ? 'moving' : 'ok', JSON.stringify(opts));
  }
});

test('shoulders out of view are not counted as a mistake', () => {
  const r = simulate({ shoulderShare: null });
  assert.equal(r.shoulders, 'unknown');
  assert.equal(r.firstMiss, null);
});
