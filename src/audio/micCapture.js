// Microphone capture shared by the beat tracker and the delay calibration. Calls
// onChunk(samples, startIndex) with mono audio, where startIndex counts samples since capture
// began; perfTime(index) converts a sample index to the performance.now() clock (seconds),
// corrected for the output and input delays.
import { ctxToPerf } from './clock.js';
import { micInputDelay } from '../core/latency.js';

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

export async function startMicCapture(ctx, onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const inputDelay = micInputDelay(stream.getAudioTracks()[0]);
  const src = ctx.createMediaStreamSource(stream);
  const cap = { stream, inputDelay, level: 0, firstFrame: null, count: 0 };
  const handle = ({ startFrame, samples }) => {
    let peak = 0;
    for (let i = 0; i < samples.length; i += 4) peak = Math.max(peak, Math.abs(samples[i]));
    cap.level = Math.max(peak, cap.level * 0.9);
    if (cap.firstFrame == null) cap.firstFrame = startFrame;
    const start = cap.count;
    cap.count += samples.length;
    onChunk(samples, start);
  };
  cap.perfTime = (index) => {
    // Audio is processed about outputLatency ahead of the context's output clock, and was
    // recorded inputDelay before it was processed.
    const latency = (ctx.outputLatency || ctx.baseLatency || 0) + inputDelay.delay;
    return ctxToPerf(ctx, (cap.firstFrame + index) / ctx.sampleRate) - latency;
  };
  let node;
  try {
    await withTimeout(ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url)), 3000);
    node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfOutputs: 0 });
    node.port.onmessage = (e) => handle(e.data);
    src.connect(node);
  } catch (err) {
    // Some browsers/environments never finish loading AudioWorklet modules; the deprecated
    // ScriptProcessorNode is universally available and good enough here.
    console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
    const size = 2048;
    node = ctx.createScriptProcessor(size, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (e) => {
      const startFrame = Math.round((e.playbackTime - size / ctx.sampleRate) * ctx.sampleRate);
      handle({ startFrame, samples: new Float32Array(e.inputBuffer.getChannelData(0)) });
    };
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }
  cap.stop = () => {
    node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  };
  return cap;
}
