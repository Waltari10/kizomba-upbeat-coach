// Copies the MediaPipe runtime out of node_modules and downloads the pose models,
// so the app can be served as plain static files (and works offline afterwards).
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@mediapipe/tasks-vision');
const out = join(root, 'vendor/mediapipe');

if (!existsSync(src)) {
  console.error('node_modules/@mediapipe/tasks-vision missing – run `npm install` first.');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
cpSync(join(src, 'vision_bundle.mjs'), join(out, 'vision_bundle.mjs'));
cpSync(join(src, 'wasm'), join(out, 'wasm'), { recursive: true });
console.log('Copied MediaPipe runtime to vendor/mediapipe');

const models = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};
const modelDir = join(root, 'vendor/models');
mkdirSync(modelDir, { recursive: true });
for (const [name, url] of Object.entries(models)) {
  const dest = join(modelDir, name);
  if (existsSync(dest)) continue;
  process.stdout.write(`Downloading ${name}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log('done');
}
