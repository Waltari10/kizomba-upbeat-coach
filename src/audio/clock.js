// Converts audio-context time to the performance.now() clock (both in seconds), so beats
// heard through the speaker/microphone and frames seen by the camera share one timeline.
export function ctxToPerf(ctx, ctxTime) {
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.performanceTime > 0) return ts.performanceTime / 1000 + (ctxTime - ts.contextTime);
  }
  return performance.now() / 1000 - (ctx.currentTime - ctxTime) + (ctx.outputLatency || ctx.baseLatency || 0);
}

export function perfToCtx(ctx, perfSec) {
  return ctxTime0(ctx) + perfSec;
}

function ctxTime0(ctx) {
  // ctxTime − perfTime offset
  return -ctxToPerf(ctx, 0);
}
