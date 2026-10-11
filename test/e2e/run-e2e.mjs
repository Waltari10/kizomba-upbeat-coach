// End-to-end simulation in a real (headless) Chromium.
//
//  1. "Analyse a video" mode on real Kizomba videos downloaded from YouTube, plus a control copy
//     whose soundtrack is delayed by exactly half a beat. Moving the beat grid by half a beat
//     must flip the verdict (up-beat ↔ down-beat); this checks the whole pipeline without
//     needing to know in advance what the dancer does.
//  2. Live mode with a fake webcam + fake microphone fed from the same video, which exercises
//     the getUserMedia → AudioWorklet → beat tracker → pose → feedback path.
//
// Media files are created by test/e2e/fetch-media.sh (not committed).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const media = join(root, 'test/fixtures/media');
const out = join(root, 'test/e2e/out');
mkdirSync(out, { recursive: true });
const PORT = 8099;
const only = process.argv[2];

const server = spawn(process.execPath, [join(root, 'server.mjs')], { env: { ...process.env, PORT, HTTPS_PORT: 8499 }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const results = {};
const summarise = (s) => {
  const judged = s.up + s.down;
  return { ...s, upPct: judged ? Math.round((100 * s.up) / judged) : null };
};

async function analyseVideo(name, file) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => m.type() === 'error' && console.log(`  [console] ${m.text()}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.check('input[name=source][value=file]');
  await page.setInputFiles('#file', join(media, file));
  await page.check('input[name=sound][value=off]', { force: true });
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 120000 });
  const t0 = Date.now();
  await page.waitForTimeout(25000);
  await page.screenshot({ path: join(out, `${name}-session.png`) });
  await page.waitForFunction(() => window.kizomba.state === 'summary', null, { timeout: 300000, polling: 1000 });
  await page.screenshot({ path: join(out, `${name}-summary.png`) });
  const { stats, log } = await page.evaluate(() => ({ stats: window.kizomba.stats, log: window.kizomba.log }));
  await browser.close();
  writeFileSync(join(out, `${name}-log.json`), JSON.stringify(log, null, 1));
  const offsets = log.filter((l) => l.offset != null && (l.status === 'up' || l.status === 'down')).map((l) => l.offset);
  const meanVec = offsets.reduce((a, o) => [a[0] + Math.cos(2 * Math.PI * o), a[1] + Math.sin(2 * Math.PI * o)], [0, 0]);
  const meanOffset = Math.atan2(meanVec[1], meanVec[0]) / (2 * Math.PI);
  results[name] = { ...summarise(stats), meanPeakOffsetBeats: +meanOffset.toFixed(3), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(name, results[name]);
}

async function liveSimulation() {
  const browser = await chromium.launch({ channel: 'chromium',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${join(media, 'live_cam.y4m')}`,
      `--use-file-for-fake-audio-capture=${join(media, 'live_mic.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log(`  [console] ${m.text()}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.screenshot({ path: join(out, 'live-setup.png'), fullPage: true });
  await page.check('input[name=source][value=mic]');
  await page.check('input[name=sound][value=tones]', { force: true });
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 120000 });
  await page.waitForTimeout(30000);
  await page.screenshot({ path: join(out, 'live-session.png') });
  await page.click('#btn-settings');
  await page.screenshot({ path: join(out, 'live-settings.png') });
  await page.click('#btn-close-drawer');
  const { stats, log } = await page.evaluate(() => ({ stats: window.kizomba.stats, log: window.kizomba.log }));
  await page.click('#btn-stop');
  await page.screenshot({ path: join(out, 'live-summary.png') });
  await browser.close();
  writeFileSync(join(out, 'live-log.json'), JSON.stringify(log, null, 1));
  const bpms = log.filter((l) => l.bpm).map((l) => l.bpm);
  results.live = { ...summarise(stats), judgements: log.length, bpm: bpms.length ? +bpms[bpms.length - 1].toFixed(1) : null };
  console.log('live', results.live);
}

const cases = [
  ['workout', 'workout.webm'],
  ['workout-halfshift', 'workout_halfshift.webm'],
  ['ginga', 'ginga_music.webm'],
  ['ginga-halfshift', 'ginga_halfshift.webm'],
];

try {
  for (const [name, file] of cases) {
    if (only && !name.startsWith(only)) continue;
    if (!existsSync(join(media, file))) { console.log(`skip ${name}: ${file} missing (run test/e2e/fetch-media.sh)`); continue; }
    await analyseVideo(name, file);
  }
  if ((!only || only === 'live') && existsSync(join(media, 'live_cam.y4m'))) await liveSimulation();
} finally {
  server.kill();
}

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failed = true; };
for (const base of ['workout', 'ginga']) {
  const a = results[base], b = results[`${base}-halfshift`];
  if (!a || !b) continue;
  check(a.upPct != null && b.upPct != null, `${base}: beats were judged (${a.up + a.down} / ${b.up + b.down})`);
  check((a.upPct - 50) * (b.upPct - 50) < 0 && Math.abs(a.upPct - b.upPct) >= 25,
    `${base}: half-beat shift flips the verdict (${a.upPct}% → ${b.upPct}% up-beat)`);
}
if (results.live) {
  check(results.live.up + results.live.down > 10, `live: judged ${results.live.up + results.live.down} beats from fake camera + microphone`);
  check(Math.abs(results.live.bpm - 92) < 3, `live: detected ${results.live.bpm} BPM from the microphone (expected ≈ 92)`);
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
