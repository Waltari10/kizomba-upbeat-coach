// Listens to music through the microphone and keeps a live beat grid on the
// performance.now() clock (seconds).
import { OnsetDetector } from '../core/onset.js';
import { BeatTracker } from '../core/beatTracker.js';
import { ctxToPerf } from './clock.js';

const ASSUMED_INPUT_LATENCY = 0.012;

export class MicBeatSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.level = 0;
    this.grid = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', { numberOfOutputs: 0 });
    src.connect(this.node);
    this.detector = new OnsetDetector(this.ctx.sampleRate);
    this.tracker = new BeatTracker({ hopSec: this.detector.hopSec });
    this.node.port.onmessage = (e) => this._onChunk(e.data);
    this.timer = setInterval(() => {
      this.grid = this.tracker.update();
    }, 250);
  }

  _onChunk({ startFrame, samples }) {
    let peak = 0;
    for (let i = 0; i < samples.length; i += 4) peak = Math.max(peak, Math.abs(samples[i]));
    this.level = Math.max(peak, this.level * 0.9);
    if (this.firstFrame == null) this.firstFrame = startFrame;
    const sr = this.ctx.sampleRate;
    const latency = (this.ctx.outputLatency || this.ctx.baseLatency || 0) + ASSUMED_INPUT_LATENCY;
    for (const f of this.detector.push(samples)) {
      const ctxTime = (this.firstFrame + f.sample) / sr;
      this.tracker.addFrame(ctxToPerf(this.ctx, ctxTime) - latency, f.value);
    }
  }

  getGrid() {
    if (!this.grid) return null;
    // Below this the music is too quiet / not rhythmic enough to trust.
    return this.grid.confidence > 0.08 ? this.grid : null;
  }

  stop() {
    clearInterval(this.timer);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
