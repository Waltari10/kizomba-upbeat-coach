// Offline replay: feeds recorded pose landmarks (from record-pose.mjs) and the video's soundtrack
// through the same analysis code the app uses, and prints the per-beat verdict statistics.
//   node test/e2e/replay.mjs <pose.json> <video> [audioDelaySec]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { onsetEnvelope } from '../../src/core/onset.js';
import { precomputeGrids, gridAt } from '../../src/core/beatTracker.js';
import { BounceAnalyzer, HeightNormalizer, hipHeight } from '../../src/core/bounce.js';

export function replay(poseFile, video, delay = 0, aspect = 16 / 9) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const { frames, hopSec } = onsetEnvelope(samples, 22050);
  const grids = precomputeGrids(frames.map((f) => ({ t: f.t + delay, value: f.value })), hopSec);
  const { pose } = JSON.parse(readFileSync(poseFile, 'utf8'));
  const an = new BounceAnalyzer(), norm = new HeightNormalizer();
  const stats = {};
  let last = null;
  for (const f of pose) {
    const lm = f.lm.map(([x, y, visibility]) => ({ x, y, visibility }));
    const m = hipHeight(lm, aspect);
    if (m) an.addSample(f.t, norm.height(m));
    const g = gridAt(grids, f.t);
    const beatT = g.anchor + Math.floor((f.t - g.anchor) / g.period - 0.5) * g.period;
    if (last !== null && beatT < last + 0.5 * g.period) continue;
    last = beatT;
    const r = an.analyze(f.t, g);
    stats[r.status] = (stats[r.status] || 0) + 1;
  }
  const judged = (stats.up || 0) + (stats.down || 0);
  return { ...stats, upPct: judged ? Math.round((100 * (stats.up || 0)) / judged) : null };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [poseFile, video, delay] = process.argv.slice(2);
  console.log(replay(poseFile, video, +(delay || 0)));
}
