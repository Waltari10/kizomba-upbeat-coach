// Delay calibration screen: the user claps ~8 times; each clap is heard by the microphone and
// seen by the camera, and the median difference is saved as the sync fine-tune. (Both timestamps
// already include the automatic corrections, so this measures what those defaults got wrong.)
import { createPoseDetector, DancerTracker } from '../pose.js';
import { startMicCapture } from '../audio/micCapture.js';
import { cameraFrameTime } from '../core/latency.js';
import { ClapListener, HandClapDetector, palmDistance, estimateDelay, calibrationResult, CALIBRATION } from '../core/clap.js';

const TIMEOUT_SEC = 40;

export class Calibration {
  constructor({ video, onUpdate, onDone, facing = 'user', quality = 'lite' }) {
    Object.assign(this, { video, onUpdate, onDone, facing, quality });
    this.heard = [];
    this.seen = [];
    this.running = false;
  }

  async start() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.resume();
    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const posePromise = createPoseDetector(this.quality, { forceCpu: new URLSearchParams(location.search).has('cpu') });
    const listener = new ClapListener(this.ctx.sampleRate);
    this.mic = await startMicCapture(this.ctx, (samples) => {
      for (const n of listener.push(samples)) this._add('heard', this.mic.perfTime(n));
    });
    this.video.srcObject = await camera;
    this.video.muted = true;
    await this.video.play();
    this.pose = await posePromise;
    this.hands = new HandClapDetector();
    this.dancer = new DancerTracker();
    this.running = true;
    this.startedAt = performance.now();
    this._loop();
    this.ticker = setInterval(() => this._report(), 250);
  }

  _loop() {
    if (!this.running) return;
    const next = (now, meta) => {
      if (!this.running) return;
      if (this.video.readyState >= 2) {
        const { t } = cameraFrameTime(meta, now);
        const { landmarks } = this.dancer.pick(this.pose.detect(this.video, now));
        this.landmarks = landmarks;
        for (const tc of this.hands.push(t, palmDistance(landmarks))) this._add('seen', tc);
      }
      if ((performance.now() - this.startedAt) / 1000 > TIMEOUT_SEC) this.finish();
      else this._loop();
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(next);
    else requestAnimationFrame((now) => next(now, null));
  }

  _add(kind, t) {
    this[kind].push(t);
    this._report();
    if (this.estimate?.n >= CALIBRATION.wantClaps) this.finish();
  }

  _report() {
    this.estimate = estimateDelay(this.heard, this.seen);
    this.onUpdate?.({
      heard: this.heard.length,
      seen: this.seen.length,
      matched: this.estimate.n || 0,
      want: CALIBRATION.wantClaps,
      level: this.mic?.level ?? 0,
      handsVisible: palmDistance(this.landmarks) != null,
    });
  }

  finish() {
    if (!this.running) return;
    this.stop();
    const result = calibrationResult(this.estimate);
    this.onDone?.({ ...result, estimate: this.estimate, heard: this.heard.length, seen: this.seen.length });
  }

  stop() {
    this.running = false;
    clearInterval(this.ticker);
    this.mic?.stop();
    this.video.srcObject?.getTracks?.().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.pose?.close();
    this.ctx?.close().catch(() => {});
  }
}
