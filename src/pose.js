// Thin wrapper around MediaPipe's PoseLandmarker (served locally from /vendor).
const BASE = new URL('../vendor/', import.meta.url);

export async function createPoseDetector(quality = 'lite') {
  const { FilesetResolver, PoseLandmarker } = await import(new URL('mediapipe/vision_bundle.mjs', BASE).href);
  const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', BASE).href);
  const modelAssetPath = new URL(`models/pose_landmarker_${quality}.task`, BASE).href;
  const make = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let landmarker;
  try {
    landmarker = await make('GPU');
  } catch (e) {
    console.warn('GPU delegate unavailable, falling back to CPU', e);
    landmarker = await make('CPU');
  }
  let lastTs = -1;
  return {
    detect(video, timestampMs) {
      const ts = Math.max(timestampMs, lastTs + 1);
      lastTs = ts;
      const r = landmarker.detectForVideo(video, ts);
      return r.landmarks?.[0] || null;
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
