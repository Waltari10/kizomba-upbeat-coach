// Listens to music through the microphone and keeps a live beat grid on the
// performance.now() clock (seconds).
import { OnsetDetector } from '../core/onset.js';
import { BeatTracker, isLocked } from '../core/beatTracker.js';
import { ctxToPerf } from './clock.js';

const ASSUMED_INPUT_LATENCY = 0.012;

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

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
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.detector = new OnsetDetector(this.ctx.sampleRate);
    this.tracker = new BeatTracker({ hopSec: this.detector.hopSec });
    try {
      await withTimeout(this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url)), 3000);
      this.node = new AudioWorkletNode(this.ctx, 'capture-processor', { numberOfOutputs: 0 });
      this.node.port.onmessage = (e) => this._onChunk(e.data);
      src.connect(this.node);
    } catch (err) {
      // Some browsers/environments never finish loading AudioWorklet modules; the deprecated
      // ScriptProcessorNode is universally available and good enough for onset detection.
      console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
      const size = 2048;
      this.node = this.ctx.createScriptProcessor(size, 1, 1);
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.onaudioprocess = (e) => {
        const startFrame = Math.round((e.playbackTime - size / this.ctx.sampleRate) * this.ctx.sampleRate);
        this._onChunk({ startFrame, samples: new Float32Array(e.inputBuffer.getChannelData(0)) });
      };
      src.connect(this.node);
      this.node.connect(mute);
      mute.connect(this.ctx.destination);
    }
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
    return isLocked(this.grid) ? this.grid : null;
  }

  stop() {
    clearInterval(this.timer);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
