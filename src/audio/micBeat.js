// Listens to music through the microphone and keeps a live beat grid on the
// performance.now() clock (seconds).
import { OnsetDetector } from '../core/onset.js';
import { BeatTracker, isLocked } from '../core/beatTracker.js';
import { startMicCapture } from './micCapture.js';

export class MicBeatSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.grid = null;
  }

  get level() {
    return this.capture?.level ?? 0;
  }

  get inputDelay() {
    return this.capture?.inputDelay;
  }

  async start() {
    this.detector = new OnsetDetector(this.ctx.sampleRate);
    this.tracker = new BeatTracker({ hopSec: this.detector.hopSec });
    this.capture = await startMicCapture(this.ctx, (samples, start) => {
      for (const f of this.detector.push(samples)) this.tracker.addFrame(this.capture.perfTime(f.sample), f.value);
    });
    this.timer = setInterval(() => {
      this.grid = this.tracker.update();
    }, 250);
  }

  getGrid() {
    return isLocked(this.grid) ? this.grid : null;
  }

  stop() {
    clearInterval(this.timer);
    this.capture?.stop();
  }
}
