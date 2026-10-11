// Beat grid for an uploaded video/audio file: the whole soundtrack is decoded and analysed
// up-front, so grids are looked up by media time (seconds).
import { onsetEnvelope } from '../core/onset.js';
import { precomputeGrids, gridAt } from '../core/beatTracker.js';

export async function analyseFile(ctx, file, onProgress = () => {}) {
  onProgress('Decoding audio…');
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  onProgress('Finding the beat…');
  const ch = buf.numberOfChannels;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch;
  }
  await new Promise((r) => setTimeout(r, 0));
  const { frames, hopSec } = onsetEnvelope(mono, buf.sampleRate);
  const grids = precomputeGrids(frames, hopSec);
  return {
    duration: buf.duration,
    grids,
    getGrid: (mediaTime) => gridAt(grids, mediaTime),
  };
}
