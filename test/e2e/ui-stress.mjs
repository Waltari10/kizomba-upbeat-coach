// UI robustness checks in headless Chromium: seeking, half-beat toggle, settings, restarting
// sessions, song mode, visual-off, and the CPU pose fallback.
//   node test/e2e/ui-stress.mjs        (needs test/fixtures/media from fetch-media.sh)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const media = join(root, 'test/fixtures/media');
const PORT = 8098;
const server = spawn(process.execPath, [join(root, 'server.mjs')], { env: { ...process.env, PORT, HTTPS_PORT: 8498 }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const src = (await import('node:fs')).readFileSync(join(root, 'test/e2e/run-e2e.mjs'), 'utf8');
const FAKE_MEDIA = eval(src.slice(src.indexOf('const FAKE_MEDIA = '), src.indexOf('async function liveSimulation')).replace('const FAKE_MEDIA = ', '(').replace(/;\s*$/, ')'));

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failed = true; };
const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const newPage = async (query = '') => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await ctx.addInitScript(FAKE_MEDIA('/test/fixtures/media/live.webm'));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/${query}`);
  return page;
};
const K = (page) => page.evaluate(() => ({ state: window.kizomba.state, stats: { ...window.kizomba.stats }, n: window.kizomba.log.length, perf: window.kizomba.perf, log: window.kizomba.log.slice(-40) }));
const judged = (s) => s.up + s.down;

try {
  // 1. Video mode: seek backwards and forwards, toggle half-beat shift, change settings mid-run.
  {
    const page = await newPage();
    await page.check('input[name=source][value=file]');
    await page.setInputFiles('#file', join(media, 'workout.webm'));
    await page.check('input[name=sound][value=off]', { force: true });
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 120000 });
    await page.waitForTimeout(12000);
    const a = await K(page);
    await page.evaluate(() => (document.querySelector('video').currentTime = 2));
    await page.waitForTimeout(8000);
    await page.evaluate(() => (document.querySelector('video').currentTime = 120));
    await page.waitForTimeout(10000);
    const b = await K(page);
    check(b.n > a.n + 10, `video: keeps judging after seeking back and forward (${a.n} → ${b.n} judgements)`);
    const ts = b.log.map((l) => l.t);
    check(ts.at(-1) > 120, `video: judgements continue at the new position (last t=${ts.at(-1)})`);

    // Paired tests on the same 20 s stretch (with clear bouncing): the average position of the
    // dancer's high point must move by ½ beat with the half-beat toggle, and by offset/period
    // with the sync-offset slider.
    const playStretch = async () => {
      await page.evaluate(() => (document.querySelector('video').currentTime = 170));
      await page.waitForTimeout(1500);
      const n0 = (await K(page)).n;
      await page.waitForTimeout(20000);
      const log = await page.evaluate((n0) => window.kizomba.log.slice(n0), n0);
      const offs = log.filter((l) => l.status === 'up' || l.status === 'down').map((l) => l.offset);
      const v = offs.reduce((a, o) => [a[0] + Math.cos(2 * Math.PI * o), a[1] + Math.sin(2 * Math.PI * o)], [0, 0]);
      return { mean: Math.atan2(v[1], v[0]) / (2 * Math.PI), n: offs.length, bpm: log.at(-1)?.bpm };
    };
    const wrap = (x) => x - Math.round(x);
    const setDrawer = async (fn) => {
      await page.click('#btn-settings');
      await fn();
      await page.click('#btn-close-drawer');
    };
    const base = await playStretch();
    await setDrawer(() => page.check('#d-half'));
    const half = await playStretch();
    const dHalf = Math.abs(wrap(half.mean - base.mean));
    check(Math.abs(dHalf - 0.5) < 0.1 && half.n > 10,
      `video: half-beat toggle moves the high point by ${dHalf.toFixed(2)} beats (expected 0.5; ${base.mean.toFixed(2)} → ${half.mean.toFixed(2)})`);
    await setDrawer(async () => {
      await page.uncheck('#d-half');
      await page.selectOption('#d-sound', 'voice');
      await page.fill('#d-offset', '100');
      await page.dispatchEvent('#d-offset', 'input');
    });
    const off = await playStretch();
    const expected = 0.1 / (60 / base.bpm);
    const dOff = wrap(off.mean - base.mean);
    check(Math.abs(Math.abs(dOff) - expected) < 0.06,
      `video: 100 ms sync offset moves the high point by ${dOff.toFixed(3)} beats (expected ±${expected.toFixed(3)})`);
    await setDrawer(async () => {
      await page.fill('#d-offset', '0');
      await page.dispatchEvent('#d-offset', 'input');
    });
    await page.click('#btn-stop');
    check((await K(page)).state === 'summary', 'video: stop shows the summary');
    check(!page.errors.length, `video: no page errors (${page.errors.join('; ')})`);
    await page.context().close();
  }

  // 2. Restart sessions repeatedly (mic mode), with visual feedback off; settings persist.
  {
    const page = await newPage();
    await page.check('input[name=source][value=mic]');
    await page.uncheck('#visual');
    await page.check('input[name=sound][value=off]', { force: true });
    for (let i = 0; i < 3; i++) {
      if (i) await page.click('#btn-again');
      await page.click('button[type=submit]');
      await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 60000 });
      await page.waitForTimeout(i === 2 ? 20000 : 4000);
      await page.click('#btn-stop');
    }
    const k = await K(page);
    check(k.state === 'summary', 'restart: three start/stop cycles end on the summary');
    check(k.perf.frames > 200, `restart: pose still running in the 3rd session (${k.perf.frames} frames)`);
    const hidden = await page.evaluate(() => document.body.dataset.visual === '0' && getComputedStyle(document.querySelector('.status')).visibility === 'hidden');
    check(hidden, 'visual off: verdict pill hidden');
    await page.reload();
    const persisted = await page.evaluate(() => ({ v: document.querySelector('#visual').checked, s: document.querySelector('input[name=sound]:checked').value, src: document.querySelector('input[name=source]:checked').value }));
    check(!persisted.v && persisted.s === 'off' && persisted.src === 'mic', `settings persist across reloads (${JSON.stringify(persisted)})`);
    check(!page.errors.length, `restart: no page errors (${page.errors.join('; ')})`);
    await page.context().close();
  }

  // 3. Song mode: app plays a music file and judges against its known beat grid.
  {
    const page = await newPage();
    await page.check('input[name=source][value=song]');
    await page.setInputFiles('#song', join(media, 'ginga_music.webm'));
    await page.check('input[name=sound][value=tones]', { force: true });
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 120000 });
    await page.waitForTimeout(20000);
    const k = await K(page);
    const bpm = k.log.filter((l) => l.bpm).at(-1)?.bpm;
    check(k.n > 15 && Math.abs(bpm - 96.1) < 2, `song mode: ${k.n} judgements at ${bpm?.toFixed(1)} BPM (song is 96 BPM)`);
    await page.screenshot({ path: join(root, 'test/e2e/out/song-session.png') });
    check(!page.errors.length, `song mode: no page errors (${page.errors.join('; ')})`);
    await page.context().close();
  }

  // 4. CPU pose fallback: still fast enough to judge.
  {
    const page = await newPage('?cpu=1');
    await page.check('input[name=source][value=file]');
    await page.setInputFiles('#file', join(media, 'workout.webm'));
    await page.check('input[name=sound][value=off]', { force: true });
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window.kizomba.ready, null, { timeout: 120000 });
    await page.waitForTimeout(30000);
    const k = await K(page);
    const fps = k.perf.frames / 30;
    check(k.perf.delegate === 'CPU', `cpu: running on ${k.perf.delegate}`);
    check(fps > 8 && judged(k.stats) > 5, `cpu: ${fps.toFixed(1)} fps, ${k.perf.detectMs.toFixed(0)} ms/frame, ${judged(k.stats)} beats judged`);
    await page.context().close();
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
