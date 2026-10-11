// Forwards microphone audio to the main thread in ~2048-sample chunks, tagged with the
// audio-context frame index of the first sample so the main thread can timestamp beats.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.len = 0;
    this.startFrame = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chans = input.length;
      const n = input[0].length;
      for (let i = 0; i < n; i++) {
        if (this.len === 0) this.startFrame = currentFrame + i;
        let v = 0;
        for (let c = 0; c < chans; c++) v += input[c][i];
        this.buf[this.len++] = v / chans;
        if (this.len === this.buf.length) {
          this.port.postMessage({ startFrame: this.startFrame, samples: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
