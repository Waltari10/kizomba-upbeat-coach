// Beat grid for an uploaded video/audio file: the whole soundtrack is decoded and analysed
// up-front, so grids are looked up by media time (seconds).
import { onsetEnvelope } from '../core/onset.js';
import { precomputeGrids, gridAt, isLocked } from '../core/beatTracker.js';
import { ctxToPerf } from './clock.js';

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
    buffer: buf,
    duration: buf.duration,
    grids,
    getGrid: (mediaTime) => {
      const g = gridAt(grids, mediaTime);
      return isLocked(g) ? g : null;
    },
  };
}

// Plays a song file through the app and provides its beat grid on the performance.now() clock.
// The beat was found offline with look-ahead and the playback time is known exactly, so this is
// immune to room noise and microphone latency.
export class SongBeat {
  constructor(ctx, analysis) {
    this.ctx = ctx;
    this.analysis = analysis;
    this.onended = null;
  }

  start() {
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.analysis.buffer;
    this.src.connect(this.ctx.destination);
    this.startCtx = this.ctx.currentTime + 0.1;
    this.src.onended = () => this.onended?.();
    this.src.start(this.startCtx);
  }

  getGrid() {
    if (this.startCtx == null) return null;
    const startPerf = ctxToPerf(this.ctx, this.startCtx);
    const g = this.analysis.getGrid(performance.now() / 1000 - startPerf);
    return g && { ...g, anchor: g.anchor + startPerf };
  }

  stop() {
    if (this.src) this.src.onended = null;
    try {
      this.src?.stop();
    } catch {}
  }
}
