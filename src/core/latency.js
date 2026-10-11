// Default delay corrections for live mode, so the camera and the microphone are put on the same
// timeline without the user having to calibrate. All values in seconds.
//
// Camera: the browser can tell us when a frame was captured (requestVideoFrameCallback
// `captureTime`). If it does, no correction is needed. Otherwise we only know when the frame was
// handed to the page, which is later than the moment it shows; typical camera pipelines take
// 40–100 ms, so we subtract a conservative 60 ms.
//
// Microphone: the dancer and the microphone hear the speaker at (almost) the same moment, so only
// the microphone's input delay matters. Chrome reports it in the track settings; otherwise
// assume 25 ms (typical for laptops and phones; at 90 BPM, 25 ms is under 0.04 beats).
export const CAMERA_DELAY_DEFAULT = 0.06;
export const MIC_DELAY_DEFAULT = 0.025;

// Capture time (seconds, performance.now() clock) of a camera frame.
export function cameraFrameTime(meta, nowMs) {
  const now = nowMs / 1000;
  const capture = meta?.captureTime / 1000;
  // Ignore implausible capture stamps (from the future or more than a second old).
  if (Number.isFinite(capture) && capture <= now + 0.005 && now - capture < 1) {
    return { t: capture, correction: 0, source: 'timestamp' };
  }
  const shown = (meta?.presentationTime ?? nowMs) / 1000;
  return { t: shown - CAMERA_DELAY_DEFAULT, correction: CAMERA_DELAY_DEFAULT, source: 'estimate' };
}

// Microphone input delay for a MediaStreamTrack.
export function micInputDelay(track) {
  const reported = track?.getSettings?.().latency;
  if (Number.isFinite(reported) && reported > 0 && reported < 0.5) return { delay: reported, source: 'reported' };
  return { delay: MIC_DELAY_DEFAULT, source: 'estimate' };
}
