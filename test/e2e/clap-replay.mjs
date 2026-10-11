// Offline check of the clap calibration on a real video: detect claps in the soundtrack and in
// recorded pose landmarks (from record-pose.mjs) and estimate the delay between them.
//   node test/e2e/clap-replay.mjs <pose.json> <video> [audioDelaySec]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ClapListener, HandClapDetector, palmDistance, estimateDelay } from '../../src/core/clap.js';

export function clapReplay(poseFile, video, delay = 0) {
  const sr = 48000;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const listener = new ClapListener(sr);
  const heard = [];
  for (let i = 0; i < samples.length; i += 1024) heard.push(...listener.push(samples.subarray(i, i + 1024)).map((n) => n / sr + delay));
  const { pose } = JSON.parse(readFileSync(poseFile, 'utf8'));
  const hands = new HandClapDetector();
  const seen = [];
  for (const f of pose) seen.push(...hands.push(f.t, palmDistance(f.lm.map(([x, y, visibility]) => ({ x, y, visibility })))));
  return { heard: heard.length, seen: seen.length, ...estimateDelay(heard, seen), seenTimes: seen, heardTimes: heard };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [poseFile, video, delay] = process.argv.slice(2);
  const r = clapReplay(poseFile, video, +(delay || 0));
  console.log({ ...r, seenTimes: undefined, heardTimes: undefined });
}
