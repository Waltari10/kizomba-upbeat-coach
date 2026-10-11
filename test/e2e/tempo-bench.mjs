// Tempo/phase stability benchmark over real soundtracks (mono f32 @ 22050 Hz files).
//   node test/e2e/tempo-bench.mjs <dir> name:expectedBpm[:fromSec[:toSec]] ...
// Reports, for each track, the share of 1-second steps whose tracked tempo is within 3% of
// the expected tempo, plus how many times the beat phase jumped.
import { readFileSync } from 'node:fs';
import { onsetEnvelope } from '../../src/core/onset.js';
import { precomputeGrids, gridAt } from '../../src/core/beatTracker.js';

const [dir, ...specs] = process.argv.slice(2);
let total = 0, good = 0;
for (const spec of specs) {
  const [name, bpm, from = 0, to = 1e9] = spec.split(':');
  const buf = readFileSync(`${dir}/${name}.f32`);
  const s = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const { frames, hopSec } = onsetEnvelope(s, 22050);
  const grids = precomputeGrids(frames, hopSec, JSON.parse(process.env.BT_OPTS || '{}'));
  const end = Math.min(+to, s.length / 22050);
  let n = 0, ok = 0, jumps = 0, prev = null;
  for (let t = +from + 4; t < end; t += 1) {
    const g = gridAt(grids, t);
    n++;
    if (Math.abs(g.bpm / bpm - 1) < 0.03) ok++;
    if (prev) {
      const d = (g.anchor - prev.anchor) / g.period;
      if (Math.abs(d - Math.round(d)) > 0.15) jumps++;
    }
    prev = g;
  }
  total += n; good += ok;
  console.log(`${name.padEnd(14)} expected ${bpm} BPM: ${Math.round((100 * ok) / n)}% in tempo, ${jumps} phase jumps`);
}
console.log(`OVERALL ${Math.round((100 * good) / total)}% in tempo`);
