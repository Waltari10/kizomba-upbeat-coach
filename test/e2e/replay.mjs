// Offline replay: feeds recorded pose landmarks (from record-pose.mjs) and the video's soundtrack
// through the same analysis code the app uses, and prints the per-beat verdict statistics.
//   node test/e2e/replay.mjs <pose.json> <video> [audioDelaySec]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { onsetEnvelope } from '../../src/core/onset.js';
import { precomputeGrids, gridAt, isLocked } from '../../src/core/beatTracker.js';
import { BounceAnalyzer, HeightNormalizer, hipHeight } from '../../src/core/bounce.js';

export function replay(poseFile, video, delay = 0, aspect = 16 / 9) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const { frames, hopSec } = onsetEnvelope(samples, 22050);
  const grids = precomputeGrids(frames.map((f) => ({ t: f.t + delay, value: f.value })), hopSec);
  const { pose } = JSON.parse(readFileSync(poseFile, 'utf8'));
  const an = new BounceAnalyzer(), norm = new HeightNormalizer();
  const stats = {};
  const offsets = [];
  let last = null, lastHip = null;
  for (const f of pose) {
    const lm = f.lm.map(([x, y, visibility]) => ({ x, y, visibility }));
    const hip = [(lm[23].x + lm[24].x) / 2, (lm[23].y + lm[24].y) / 2];
    if (lastHip && Math.hypot(hip[0] - lastHip[0], hip[1] - lastHip[1]) > 0.08) {
      an.reset();
      norm.reset();
    }
    lastHip = hip;
    const m = hipHeight(lm, aspect);
    if (m) an.addSample(f.t, norm.height(m));
    const g = gridAt(grids, f.t);
    if (!isLocked(g)) {
      stats['no-beat'] = (stats['no-beat'] || 0) + 1;
      continue;
    }
    const beatT = g.anchor + Math.floor((f.t - g.anchor) / g.period - 0.5) * g.period;
    if (last !== null && beatT < last + 0.5 * g.period) continue;
    last = beatT;
    const r = an.analyze(f.t, g);
    stats[r.status] = (stats[r.status] || 0) + 1;
    if (r.status === 'up' || r.status === 'down') offsets.push(r.offset);
  }
  const judged = (stats.up || 0) + (stats.down || 0);
  // Circular mean of the high-point position (beats) and its consistency R (1 = always the same).
  const v = offsets.reduce((a, o) => [a[0] + Math.cos(2 * Math.PI * o), a[1] + Math.sin(2 * Math.PI * o)], [0, 0]);
  const meanOffset = offsets.length ? +(Math.atan2(v[1], v[0]) / (2 * Math.PI)).toFixed(3) : null;
  const R = offsets.length ? +(Math.hypot(v[0], v[1]) / offsets.length).toFixed(2) : null;
  return { ...stats, upPct: judged ? Math.round((100 * (stats.up || 0)) / judged) : null, meanOffset, R };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [poseFile, video, delay] = process.argv.slice(2);
  console.log(replay(poseFile, video, +(delay || 0)));
}
