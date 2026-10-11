// Thin wrapper around MediaPipe's PoseLandmarker (served locally from /vendor).
const BASE = new URL('../vendor/', import.meta.url);

export async function createPoseDetector(quality = 'lite', { forceCpu = false } = {}) {
  const { FilesetResolver, PoseLandmarker } = await import(new URL('mediapipe/vision_bundle.mjs', BASE).href);
  const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', BASE).href);
  const modelAssetPath = new URL(`models/pose_landmarker_${quality}.task`, BASE).href;
  const make = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      // One pose: with two, partners in close embrace get mixed up and detection is ~40% slower.
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let landmarker, delegate = 'GPU';
  try {
    if (forceCpu) throw new Error('CPU forced');
    landmarker = await make('GPU');
  } catch (e) {
    console.warn('GPU delegate unavailable, falling back to CPU', e);
    delegate = 'CPU';
    landmarker = await make('CPU');
  }
  let lastTs = -1;
  return {
    delegate,
    detect(video, timestampMs) {
      const ts = Math.max(timestampMs, lastTs + 1);
      lastTs = ts;
      const r = landmarker.detectForVideo(video, ts);
      return r.landmarks || [];
    },
    close() {
      landmarker.close();
    },
  };
}

export const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

const hipCenter = (lm) => [(lm[23].x + lm[24].x) / 2, (lm[23].y + lm[24].y) / 2];

// Keeps following one dancer across frames: picks the detected pose whose hips are closest to
// where the followed dancer was. `switched` is true when the followed body jumped (e.g. the
// detector picked up the partner instead), so callers can restart anything that assumes one
// continuous body.
export class DancerTracker {
  constructor() {
    this.last = null;
  }
  pick(poses) {
    if (!poses.length) return { landmarks: null, switched: false };
    let best = poses[0];
    if (this.last) {
      let bestD = Infinity;
      for (const p of poses) {
        const [x, y] = hipCenter(p);
        const d = Math.hypot(x - this.last[0], y - this.last[1]);
        if (d < bestD) { bestD = d; best = p; }
      }
    } else {
      // First sighting: take the biggest (closest) body.
      const size = (p) => Math.abs(p[11].y - p[23].y) + Math.abs(p[12].y - p[24].y);
      best = poses.reduce((a, b) => (size(b) > size(a) ? b : a));
    }
    const c = hipCenter(best);
    const switched = !!this.last && Math.hypot(c[0] - this.last[0], c[1] - this.last[1]) > 0.08;
    this.last = c;
    return { landmarks: best, switched };
  }
  reset() {
    this.last = null;
  }
}
