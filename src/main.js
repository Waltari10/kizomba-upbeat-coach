import { createPoseDetector, DancerTracker, SKELETON } from './pose.js';
import { BounceAnalyzer, HeightNormalizer, hipHeight } from './core/bounce.js';
import { StepAnalyzer } from './core/steps.js';
import { BeatTracker } from './core/beatTracker.js';
import { MicBeatSource } from './audio/micBeat.js';
import { PracticeBeat } from './audio/practiceBeat.js';
import { analyseFile, SongBeat } from './audio/fileBeat.js';
import { AudioFeedback } from './ui/feedback.js';
import { cameraFrameTime } from './core/latency.js';
import { Calibration } from './ui/calibration.js';

const $ = (s) => document.querySelector(s);

const STATUS = {
  up: { label: 'UP-BEAT', icon: '✓', sub: 'You rise on the beat. Keep it up!', cls: 'good' },
  down: { label: 'DOWN-BEAT', icon: '↓', sub: 'Go up on the beat, sink on the “and”', cls: 'bad' },
  still: { label: 'Bounce a little', icon: '〰', sub: 'Soft knees: down on the “and”, up on the beat', cls: 'warn' },
  halftime: { label: 'Every 2nd beat', icon: '½', sub: 'You rise and fall over two beats. Add a small lift on every beat', cls: 'warn' },
  irregular: { label: 'Find the pulse', icon: '♪', sub: 'Keep a steady up-and-down with the music', cls: 'warn' },
  insufficient: { label: 'Step into view', icon: '◎', sub: 'Show your whole body, about 2–3 m from the camera', cls: 'idle' },
  'no-beat': { label: 'Listening for the beat…', icon: '♫', sub: 'Play some Kizomba nearby', cls: 'idle' },
  loading: { label: 'Loading…', icon: '…', sub: '', cls: 'idle' },
};

// Basic-step mode: what to say about the first of the three steps that is missing.
const STEP_HINTS = {
  'transfer-small': 'Shift your hips fully over the foot you step on',
  'transfer-irregular': 'Step from foot to foot in time: one step every {n}',
  'push-none': 'Push up from the floor once your weight arrives',
  'push-early': 'Arrive on the foot first, then push up',
  'relax-flat': 'Relax the hip down between steps: draw a smile ‿',
  'relax-frown': 'Your hip rises between the feet. Let it sink instead: a smile ‿, not a frown ⁀',
  'shoulders-moving': 'Keep your shoulders still, as if between two walls: only the hips move',
};
const STEP_KEYS = ['transfer', 'push', 'relax', 'shoulders'];
const emptyStepStats = () => ({ judged: 0, transfer: 0, push: 0, relax: 0, shoulders: 0, all: 0 });

const STORE_KEY = 'kizomba-coach-settings';
const settings = {
  mode: 'upbeat', // 'upbeat' | 'steps' (also checks the basic step technique)
  stepBeats: 1, // basic-step mode: beats per step (1, 2 or 4)
  source: 'mic',
  bpm: 90,
  facing: 'user',
  visual: true,
  sound: 'tones',
  beatClick: false,
  quality: 'lite',
  offsetMs: 0,
  sensitivity: 1,
  halfShift: false,
  calibration: null, // { offsetMs, spreadMs, n, at } from the clap calibration
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
} catch {}
const saveSettings = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {}
};

// Exposed for debugging and automated tests.
const app = (window.kizomba = {
  settings,
  log: [],
  stats: { up: 0, down: 0, still: 0, irregular: 0, halftime: 0 },
  stepStats: emptyStepStats(),
  state: 'setup',
  ready: false,
  perf: { frames: 0, detectMs: 0 },
  recordPose: false, // set true (e.g. from the console) to keep raw landmarks in poseLog
  poseLog: [],
});

let ctx, pose, beatSource, fileBeat, feedback, analyzer, stepAnalyzer, normalizer, dancer, wakeLock;
let running = false;
let lastJudgedBeat = null;
let current = { status: 'loading' };
let streak = { status: null, n: 0 };
let stepStreak = { key: null, n: 0 };
let hipTrail = []; // recent hip positions (image coords) for drawing the smile in basic-step mode
let latest = { t: null, landmarks: null };
let startedAt = 0;
const video = $('#video');

// ---------- Setup screen ----------
function bindSetup() {
  const form = $('#setup-form');
  form.mode.value = settings.mode;
  form.stepBeats.value = String(settings.stepBeats);
  form.source.value = settings.source;
  form.facing.value = settings.facing;
  form.sound.value = settings.sound;
  form.quality.value = settings.quality;
  $('#bpm').value = settings.bpm;
  $('#bpm-out').textContent = settings.bpm;
  $('#visual').checked = settings.visual;
  $('#beat-click').checked = settings.beatClick;
  const syncSource = () => {
    document.body.dataset.source = form.source.value;
    document.body.dataset.mode = form.mode.value;
  };
  syncSource();
  form.addEventListener('change', syncSource);
  $('#bpm').addEventListener('input', (e) => ($('#bpm-out').textContent = e.target.value));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.mode = form.mode.value;
    settings.stepBeats = +form.stepBeats.value;
    settings.source = form.source.value;
    settings.facing = form.facing.value;
    settings.sound = form.sound.value;
    settings.quality = form.quality.value;
    settings.bpm = +$('#bpm').value;
    settings.visual = $('#visual').checked;
    settings.beatClick = $('#beat-click').checked;
    saveSettings();
    if (settings.source === 'file' && !$('#file').files[0]) {
      $('#setup-error').textContent = 'Choose a video file first.';
      return;
    }
    if (settings.source === 'song' && !$('#song').files[0]) {
      $('#setup-error').textContent = 'Choose a song first.';
      return;
    }
    start().catch((err) => {
      console.error(err);
      stop(false);
      showScreen('setup');
      $('#setup-error').textContent = friendlyError(err);
    });
  });
}

function friendlyError(err) {
  if (err?.name === 'NotAllowedError') return 'Camera/microphone permission was denied. Allow access in the browser settings and try again.';
  if (err?.name === 'NotFoundError') return 'No camera or microphone was found.';
  if (err?.name === 'EncodingError') return 'This browser cannot decode the sound of that file. Try Chrome/Safari, or export it as MP4 (H.264/AAC) or WebM.';
  if (!window.isSecureContext) return 'The camera only works on https:// or http://localhost. Open the https address printed by the server.';
  return `Could not start: ${err?.message || err}`;
}

function showScreen(name) {
  document.body.dataset.screen = name;
  app.state = name;
}

// ---------- Session ----------
async function start() {
  $('#setup-error').textContent = '';
  showScreen('session');
  setStatus({ status: 'loading' });
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  feedback = new AudioFeedback(ctx);
  applyFeedbackSettings();
  analyzer = new BounceAnalyzer();
  stepAnalyzer = new StepAnalyzer({ stepBeats: settings.stepBeats });
  normalizer = new HeightNormalizer();
  dancer = new DancerTracker();
  applySensitivity();
  app.log = [];
  app.stats = { up: 0, down: 0, still: 0, irregular: 0, halftime: 0 };
  app.stepStats = emptyStepStats();
  lastJudgedBeat = null;
  streak = { status: null, n: 0 };
  stepStreak = { key: null, n: 0 };
  hipTrail = [];
  showSteps(null);
  document.body.dataset.mirror = settings.source !== 'file' && settings.facing === 'user' ? '1' : '0';

  // ?cpu=1 forces the slower CPU pose model (for testing the fallback path).
  const posePromise = createPoseDetector(settings.quality, { forceCpu: new URLSearchParams(location.search).has('cpu') });

  if (settings.source === 'file') {
    const file = $('#file').files[0];
    $('#status-sub').textContent = 'Analysing the music…';
    fileBeat = await analyseFile(ctx, file, (msg) => ($('#status-sub').textContent = msg));
    video.srcObject = null;
    video.src = URL.createObjectURL(file);
    video.muted = false;
    video.controls = true;
    video.loop = false;
    pose = await posePromise;
    await video.play().catch(() => {});
    video.onended = () => stop(true);
  } else {
    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: settings.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    if (settings.source === 'practice') {
      beatSource = new PracticeBeat(ctx, settings.bpm);
    } else if (settings.source === 'song') {
      $('#status-sub').textContent = 'Analysing the song…';
      beatSource = new SongBeat(ctx, await analyseFile(ctx, $('#song').files[0], (msg) => ($('#status-sub').textContent = msg)));
      beatSource.onended = () => stop(true);
    } else {
      beatSource = new MicBeatSource(ctx);
      await beatSource.start();
    }
    video.srcObject = await camera;
    video.muted = true;
    video.controls = false;
    await video.play();
    pose = await posePromise;
    if (settings.source === 'practice' || settings.source === 'song') beatSource.start();
  }

  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
  running = true;
  app.ready = true;
  app.perf = { frames: 0, detectMs: 0, delegate: pose.delegate };
  startedAt = performance.now();
  scheduleFrame();
  requestAnimationFrame(render);
}

function stop(showSummary = true) {
  if (showSummary) renderSummary();
  running = false;
  app.ready = false;
  beatSource?.stop();
  beatSource = null;
  fileBeat = null;
  video.srcObject?.getTracks?.().forEach((t) => t.stop());
  video.pause();
  video.onended = null;
  pose?.close();
  pose = null;
  wakeLock?.release?.().catch(() => {});
  speechSynthesis?.cancel?.();
  const c = ctx;
  ctx = null;
  c?.close().catch(() => {});
  showScreen(showSummary ? 'summary' : 'setup');
}

// The beat grid in the same clock as the pose samples, with the user's half-beat shift.
function getGrid(t) {
  let g = fileBeat ? fileBeat.getGrid(t) : beatSource?.getGrid();
  if (!g) return null;
  if (settings.halfShift) g = { ...g, anchor: g.anchor + g.period / 2 };
  return g;
}

// ---------- Pose loop ----------
function scheduleFrame() {
  if (!running) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame((now) => onFrame(now, null));
}

function onFrame(now, meta) {
  if (!running) return;
  try {
    if (video.readyState >= 2 && !(fileBeat && video.paused)) processFrame(now, meta);
  } catch (e) {
    console.error(e);
  }
  scheduleFrame();
}

function processFrame(now, meta) {
  let t;
  if (fileBeat) t = meta?.mediaTime ?? video.currentTime;
  else {
    const cam = cameraFrameTime(meta, now);
    t = cam.t;
    app.perf.camera = cam;
  }
  const sampleT = t - settings.offsetMs / 1000;
  if (latest.t != null && t < latest.t - 0.3) {
    // Seeked backwards in a file.
    analyzer.reset();
    stepAnalyzer.reset();
    hipTrail = [];
    lastJudgedBeat = null;
  }
  const d0 = performance.now();
  // MediaPipe smooths landmarks over time, so it always gets wall-clock timestamps: media time
  // jumps backwards on a seek, which would make its filter think frames are 1 ms apart.
  const { landmarks, switched } = dancer.pick(pose.detect(video, now));
  if (switched) {
    // A different person was picked up: their hip height is not comparable.
    analyzer.reset();
    stepAnalyzer.reset();
    normalizer.reset();
    hipTrail = [];
  }
  app.perf.frames++;
  app.perf.detectMs += (performance.now() - d0 - app.perf.detectMs) * 0.05;
  latest = { t, landmarks, sampleT };
  if (app.recordPose && landmarks) app.poseLog.push({ t: sampleT, lm: landmarks.map((p) => [+p.x.toFixed(5), +p.y.toFixed(5), +(p.visibility ?? 1).toFixed(2)]) });
  const m = hipHeight(landmarks, video.videoWidth / video.videoHeight || 1);
  if (m) {
    const h = normalizer.height(m);
    analyzer.addSample(sampleT, h);
    stepAnalyzer.addSample(sampleT, { h, ...normalizer.lateral(m) });
    hipTrail.push({ t: sampleT, x: m.hipX, y: m.hipY });
    while (hipTrail.length && hipTrail[0].t < sampleT - 8) hipTrail.shift();
  }
  judge(sampleT);
}

// Judge once per beat, half a beat after it (so the motion around the beat has been seen).
function judge(t) {
  const grid = getGrid(t);
  if (!grid) {
    setStatus({ status: 'no-beat' });
    return;
  }
  // Time of the latest beat that is at least half a beat in the past. (Beat indices are not
  // stable because the tracker keeps moving its anchor, so we compare absolute times.)
  const beatT = grid.anchor + Math.floor((t - grid.anchor) / grid.period - 0.5) * grid.period;
  if (lastJudgedBeat !== null && beatT < lastJudgedBeat + 0.5 * grid.period) return;
  lastJudgedBeat = beatT;
  const steps = settings.mode === 'steps';
  const st = steps ? stepAnalyzer.analyze(t, grid) : null;
  // Slow steps rise and fall once per 2 or 4 beats, which the once-per-beat analysis can't judge
  // (it would say "every 2nd beat"); the step analyzer judges the high point at the step's tempo.
  let r = analyzer.analyze(t, grid);
  if (steps && settings.stepBeats > 1) {
    r = st ? { status: st.status, offset: st.offset, amplitude: st.amplitude, rhythmicity: st.rhythmicity } : { status: 'insufficient' };
  }
  r.bpm = grid.bpm;
  setStatus(r);
  if (r.status === streak.status) streak.n++;
  else streak = { status: r.status, n: 1 };
  if (r.status in app.stats) app.stats[r.status]++;
  const entry = { t: +t.toFixed(3), status: r.status, offset: r.offset, amplitude: r.amplitude, rhythmicity: r.rhythmicity, bpm: grid.bpm };
  let stepsSpoke = false;
  if (steps) {
    showSteps(st);
    if (st) {
      const ss = app.stepStats;
      ss.judged++;
      for (const k of STEP_KEYS) if (st[k] === 'ok') ss[k]++;
      if (!st.firstMiss) ss.all++;
      const key = st.firstMiss && `${st.firstMiss}-${st[st.firstMiss]}`;
      if (key === stepStreak.key) stepStreak.n++;
      else stepStreak = { key, n: 1 };
      stepsSpoke = feedback.onSteps(key, stepStreak.n);
      entry.steps = { transfer: st.transfer, push: st.push, relax: st.relax, shoulders: st.shoulders, sway: +st.sway.toFixed(3), shoulderSway: st.shoulderSway == null ? null : +st.shoulderSway.toFixed(3), lag: st.lag == null ? null : +st.lag.toFixed(3) };
    }
  }
  app.log.push(entry);
  if (['up', 'down', 'still', 'irregular', 'halftime'].includes(r.status)) {
    if (!stepsSpoke) feedback.onJudgement(r.status, streak.n);
    if (settings.visual) flash(STATUS[r.status].cls);
    pushTimeline(r.status);
  }
  updateScore();
}

// ---------- HUD ----------
function setStatus(r) {
  current = r;
  const s = STATUS[r.status] || STATUS.loading;
  const pill = $('#status');
  pill.className = `status ${s.cls}`;
  $('#status-icon').textContent = s.icon;
  $('#status-label').textContent = s.label;
  if (r.status !== 'loading' || !$('#status-sub').textContent) $('#status-sub').textContent = s.sub;
  const needle = $('#dial-needle');
  if (r.offset != null) {
    needle.style.transform = `rotate(${r.offset * 360}deg)`;
    needle.style.opacity = String(0.35 + 0.65 * Math.min(1, (r.rhythmicity || 0) * 1.5));
  }
  $('#bounce-size').textContent = r.amplitude != null ? `${(r.amplitude * 2 * 50).toFixed(1)} cm` : '–';
}

// Basic-step mode: colour the three step chips and show a hint for the first missing step.
function showSteps(st) {
  document.querySelectorAll('#steps [data-step]').forEach((el) => {
    const v = st?.[el.dataset.step];
    el.className = v === 'ok' ? 'ok' : v && v !== 'unknown' ? 'miss' : '';
  });
  const n = settings.stepBeats;
  const hint = st?.firstMiss ? (STEP_HINTS[`${st.firstMiss}-${st[st.firstMiss]}`] || '').replace('{n}', n === 1 ? 'beat' : `${n} beats`) : '';
  $('#step-hint').textContent = !st ? '' : st.firstMiss ? hint : 'Transfer · push up · relax · still shoulders ✓';
  current.steps = st;
}

function updateScore() {
  const { up, down } = app.stats;
  const total = up + down;
  $('#score').textContent = total ? `${Math.round((100 * up) / total)}%` : '–';
  $('#score-sub').textContent = total ? `${up} of ${total} beats on the up` : 'on the up-beat';
}

function flash(cls) {
  const el = $('#flash');
  el.className = `flash ${cls}`;
  void el.offsetWidth;
  el.classList.add('on');
}

const timeline = [];
function pushTimeline(status) {
  timeline.push(status);
  if (timeline.length > 32) timeline.shift();
  $('#timeline').innerHTML = timeline.map((s) => `<i class="${STATUS[s].cls}"></i>`).join('');
}

function applyFeedbackSettings() {
  document.body.dataset.visual = settings.visual ? '1' : '0';
  if (feedback) {
    feedback.mode = settings.sound;
    feedback.beatClick = settings.beatClick;
  }
}

function applySensitivity() {
  if (analyzer) analyzer.opts.minAmplitude = 0.01 / settings.sensitivity;
  if (stepAnalyzer) {
    stepAnalyzer.opts.minAmplitude = 0.01 / settings.sensitivity;
    stepAnalyzer.opts.minDip = 0.01 / settings.sensitivity;
  }
}

// ---------- Drawing ----------
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const trace = $('#trace');
const tctx = trace.getContext('2d');

function render() {
  if (!running) return;
  requestAnimationFrame(render);
  const now = fileBeat ? video.currentTime : performance.now() / 1000;
  const grid = getGrid(latest.sampleT ?? now);
  if (grid) {
    feedback.scheduleClicks(fileBeat ? null : grid, now);
    const x = (now - settings.offsetMs / 1000 - grid.anchor) / grid.period;
    const beatIdx = Math.floor(x);
    const ph = x - beatIdx;
    document.querySelectorAll('#beats i').forEach((el, i) => {
      el.classList.toggle('on', ((beatIdx % 4) + 4) % 4 === i);
      el.style.setProperty('--pulse', String(Math.max(0, 1 - ph * 3)));
    });
    $('#bpm-now').textContent = `${Math.round(grid.bpm)} BPM`;
  } else {
    $('#bpm-now').textContent = beatSource instanceof MicBeatSource ? 'listening…' : '';
  }
  if (beatSource instanceof MicBeatSource) $('#level').style.width = `${Math.min(100, beatSource.level * 160)}%`;
  drawSkeleton(grid);
  if (settings.mode === 'steps') drawHipTrail();
  drawTrace(grid);
}

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { w, h, dpr };
}

function drawSkeleton(grid) {
  const { w, h, dpr } = fitCanvas(overlay);
  octx.clearRect(0, 0, w, h);
  const lm = latest.landmarks;
  if (!lm || !video.videoWidth) return;
  // The video uses object-fit: contain in file mode and cover for the camera.
  const vw = video.videoWidth, vh = video.videoHeight;
  const cover = !fileBeat;
  const scale = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const ox = (w - vw * scale) / 2, oy = (h - vh * scale) / 2;
  const P = (p) => [ox + p.x * vw * scale, oy + p.y * vh * scale];
  const color = { good: '#3ee08f', bad: '#ff5d6c', warn: '#ffc145', idle: '#ffffff' }[(STATUS[current.status] || STATUS.loading).cls];
  octx.lineCap = 'round';
  octx.lineWidth = 4 * dpr;
  octx.strokeStyle = color;
  octx.globalAlpha = 0.85;
  for (const [a, b] of SKELETON) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    const [x1, y1] = P(lm[a]), [x2, y2] = P(lm[b]);
    octx.beginPath();
    octx.moveTo(x1, y1);
    octx.lineTo(x2, y2);
    octx.stroke();
  }
  // Pulsing ring around the hips on every beat.
  const [hx, hy] = P({ x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 });
  let pulse = 0;
  if (grid) {
    const now = fileBeat ? video.currentTime : performance.now() / 1000;
    const ph = (((now - settings.offsetMs / 1000 - grid.anchor) / grid.period) % 1 + 1) % 1;
    pulse = Math.max(0, 1 - ph * 2.5);
  }
  octx.globalAlpha = 0.25 + 0.6 * pulse;
  octx.lineWidth = 3 * dpr;
  octx.beginPath();
  octx.arc(hx, hy, (14 + 22 * pulse) * dpr, 0, Math.PI * 2);
  octx.stroke();
  octx.globalAlpha = 1;
}

// The hip's path over the last two beats, drawn around the hips with the up-and-down movement
// exaggerated so the smile (or frown) is visible: green when the relax step is right.
function drawHipTrail() {
  const lm = latest.landmarks;
  if (!lm || hipTrail.length < 3 || !video.videoWidth) return;
  const { w, h, dpr } = fitCanvas(overlay);
  const vw = video.videoWidth, vh = video.videoHeight;
  const cover = !fileBeat;
  const scale = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const ox = (w - vw * scale) / 2, oy = (h - vh * scale) / 2;
  const step = (getGrid(latest.sampleT)?.period ?? 0.65) * settings.stepBeats;
  const pts = hipTrail.filter((p) => p.t >= latest.sampleT - 2 * step);
  if (pts.length < 3) return;
  const meanY = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const cy = (lm[23].y + lm[24].y) / 2;
  const relax = current.steps?.relax;
  octx.strokeStyle = relax === 'ok' ? '#3ee08f' : relax && relax !== 'unknown' ? '#ff5d6c' : '#ffffff';
  octx.lineWidth = 5 * dpr;
  octx.lineCap = octx.lineJoin = 'round';
  octx.beginPath();
  pts.forEach((p, i) => {
    const x = ox + p.x * vw * scale;
    const y = oy + (cy + 4 * (p.y - meanY)) * vh * scale;
    octx.globalAlpha = 0.15 + 0.85 * (i / (pts.length - 1));
    if (i) {
      octx.lineTo(x, y);
      octx.stroke();
      octx.beginPath();
    }
    octx.moveTo(x, y);
  });
  octx.globalAlpha = 1;
}

function drawTrace(grid) {
  const { w, h, dpr } = fitCanvas(trace);
  tctx.clearRect(0, 0, w, h);
  const tEnd = latest.sampleT;
  if (tEnd == null) return;
  const span = 4;
  const tStart = tEnd - span;
  const X = (t) => ((t - tStart) / span) * w;
  if (grid) {
    const k0 = Math.ceil((tStart - grid.anchor) / grid.period * 2);
    for (let k = k0; ; k++) {
      const t = grid.anchor + (k * grid.period) / 2;
      if (t > tEnd) break;
      const onBeat = k % 2 === 0;
      tctx.strokeStyle = onBeat ? 'rgba(62,224,143,0.9)' : 'rgba(255,255,255,0.25)';
      tctx.lineWidth = (onBeat ? 2 : 1) * dpr;
      tctx.setLineDash(onBeat ? [] : [4 * dpr, 4 * dpr]);
      tctx.beginPath();
      tctx.moveTo(X(t), 0);
      tctx.lineTo(X(t), h);
      tctx.stroke();
    }
    tctx.setLineDash([]);
  }
  const pts = analyzer.samples.filter((s) => s.t >= tStart);
  if (pts.length < 2) return;
  // Detrend for display: subtract a moving average so only the bounce remains.
  const hs = pts.map((p, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 20); j < Math.min(pts.length, i + 21); j++) { s += pts[j].h; n++; }
    return p.h - s / n;
  });
  const maxAbs = Math.max(0.03, ...hs.map(Math.abs));
  tctx.strokeStyle = '#fff';
  tctx.lineWidth = 2.5 * dpr;
  tctx.beginPath();
  pts.forEach((p, i) => {
    const y = h / 2 - (hs[i] / maxAbs) * (h * 0.42);
    i ? tctx.lineTo(X(p.t), y) : tctx.moveTo(X(p.t), y);
  });
  tctx.stroke();
}

function autoCorrectionText() {
  if (fileBeat) return 'Video mode: sound and picture come from the same file, so no delay correction is needed.';
  const cam = app.perf.camera;
  const camText = !cam ? 'camera: waiting for frames'
    : cam.source === 'timestamp' ? 'camera: exact (the browser timestamps each frame)'
    : `camera: −${Math.round(cam.correction * 1000)} ms (estimated)`;
  const mic = beatSource?.inputDelay;
  const micText = mic ? `microphone: −${Math.round(mic.delay * 1000)} ms (${mic.source === 'reported' ? 'reported by the browser' : 'estimated'})`
    : 'microphone: not used (the app plays the music itself)';
  const cal = settings.calibration ? ` Clap calibration: ${settings.calibration.offsetMs} ms (set as the fine-tune below).` : '';
  return `Automatic delay correction: ${camText}; ${micText}.${cal}`;
}

// ---------- Settings drawer ----------
function bindDrawer() {
  const open = () => {
    $('#drawer').hidden = false;
    $('#d-visual').checked = settings.visual;
    $('#d-sound').value = settings.sound;
    $('#d-click').checked = settings.beatClick;
    $('#d-offset').value = settings.offsetMs;
    $('#d-offset-out').textContent = settings.offsetMs;
    $('#d-sens').value = settings.sensitivity;
    $('#d-steps').value = String(settings.stepBeats);
    $('#d-half').checked = settings.halfShift;
    $('#d-auto').textContent = autoCorrectionText();
  };
  $('#btn-settings').onclick = open;
  $('#btn-close-drawer').onclick = () => ($('#drawer').hidden = true);
  $('#drawer').addEventListener('input', () => {
    settings.visual = $('#d-visual').checked;
    settings.sound = $('#d-sound').value;
    settings.beatClick = $('#d-click').checked;
    settings.offsetMs = +$('#d-offset').value;
    settings.sensitivity = +$('#d-sens').value;
    settings.stepBeats = +$('#d-steps').value;
    if (stepAnalyzer) stepAnalyzer.opts.stepBeats = settings.stepBeats;
    const half = $('#d-half').checked;
    if (half !== settings.halfShift) {
      settings.halfShift = half;
      lastJudgedBeat = null;
    }
    $('#d-offset-out').textContent = settings.offsetMs;
    applyFeedbackSettings();
    applySensitivity();
    saveSettings();
  });
  $('#btn-stop').onclick = () => stop(true);
  $('#btn-again').onclick = () => showScreen('setup');
}

function renderSummary() {
  const { up, down, still, irregular, halftime } = app.stats;
  const total = up + down;
  const pct = total ? Math.round((100 * up) / total) : null;
  const mins = (performance.now() - startedAt) / 60000;
  $('#sum-score').textContent = pct == null ? '–' : `${pct}%`;
  $('#sum-verdict').textContent =
    pct == null
      ? 'Not enough clear bouncing to judge. Try a slightly bigger knee bounce.'
      : pct >= 75
        ? 'Great! You are dancing on the up-beat.'
        : pct >= 45
          ? 'Mixed: you switch between the up-beat and the down-beat.'
          : 'Mostly on the down-beat. Try rising on the beat and sinking on the “and”.';
  $('#sum-details').textContent = `${up} up-beat · ${down} down-beat · ${halftime} every-2nd-beat · ${still} too still · ${irregular} irregular · ${fileBeat ? '' : `${mins.toFixed(1)} min`}`;
  const ss = app.stepStats;
  const pctOf = (n) => (ss.judged ? Math.round((100 * n) / ss.judged) : null);
  $('#sum-steps').innerHTML = !ss.judged
    ? '<p class="muted">Basic step: not enough side-to-side stepping in view to check the steps.</p>'
    : [['1. Weight transfer', ss.transfer], ['2. Push up', ss.push], ['3. Relax hip ‿', ss.relax], ['Shoulders still', ss.shoulders], ['All four', ss.all]]
        .map(([label, n]) => `<div class="row"><span>${label}</span><span class="bar"><i style="width:${pctOf(n)}%"></i></span><b>${pctOf(n)}%</b></div>`)
        .join('');
  $('#sum-timeline').innerHTML = app.log
    .filter((l) => ['up', 'down', 'still', 'irregular', 'halftime'].includes(l.status))
    .map((l) => `<i class="${STATUS[l.status].cls}"></i>`)
    .join('');
}

// ---------- Delay calibration ----------
let calibration = null;

function calibrationStatus() {
  const c = settings.calibration;
  $('#calib-status').textContent = c
    ? `Delay calibrated: ${c.offsetMs > 0 ? '+' : ''}${c.offsetMs} ms (${new Date(c.at).toLocaleDateString()})`
    : 'Delay: automatic correction';
}

async function startCalibration() {
  const form = $('#setup-form');
  settings.facing = form.facing.value;
  settings.quality = form.quality.value;
  document.body.dataset.mirror = settings.facing === 'user' ? '1' : '0';
  $('#calib-run').hidden = false;
  $('#calib-result').hidden = true;
  showScreen('calibrate');
  const dots = $('#calib-dots');
  calibration = app.calibration = new Calibration({
    video: $('#calib-video'),
    facing: settings.facing,
    quality: settings.quality,
    onUpdate: (u) => {
      dots.innerHTML = Array.from({ length: u.want }, (_, i) => `<i class="${i < u.matched ? 'on' : ''}"></i>`).join('');
      $('#calib-heard').textContent = u.heard;
      $('#calib-seen').textContent = u.seen;
      $('#calib-hands').textContent = u.handsVisible ? 'hands in view ✓' : 'hands not in view';
      app.calibrationProgress = u;
    },
    onDone: (r) => {
      app.calibrationResult = r;
      $('#calib-run').hidden = true;
      $('#calib-result').hidden = false;
      if (r.ok) {
        settings.offsetMs = Math.max(-250, Math.min(250, r.offsetMs));
        settings.calibration = { offsetMs: settings.offsetMs, spreadMs: r.spreadMs, n: r.n, at: Date.now() };
        saveSettings();
        calibrationStatus();
        const ms = Math.abs(r.offsetMs);
        $('#calib-result-text').textContent =
          ms < 10 ? 'Camera and sound are in sync. Nothing to correct.'
            : `The camera is ${ms} ms ${r.offsetMs > 0 ? 'behind' : 'ahead of'} the sound. Saved; it's corrected from now on.`;
        $('#calib-result-detail').textContent = `${r.n} claps measured, agreeing within ±${r.spreadMs} ms.`;
      } else {
        $('#calib-result-text').textContent = 'Could not measure the delay reliably.';
        $('#calib-result-detail').textContent = `${r.reason} (${r.heard} claps heard, ${r.seen} seen.) Nothing was changed.`;
      }
    },
  });
  try {
    await calibration.start();
  } catch (err) {
    console.error(err);
    calibration.stop();
    showScreen('setup');
    $('#setup-error').textContent = friendlyError(err);
  }
}

function bindCalibration() {
  $('#btn-calibrate').onclick = startCalibration;
  $('#btn-calib-cancel').onclick = () => {
    calibration?.stop();
    showScreen('setup');
  };
  $('#btn-calib-retry').onclick = startCalibration;
  $('#btn-calib-done').onclick = () => showScreen('setup');
  calibrationStatus();
}

bindSetup();
bindDrawer();
bindCalibration();
showScreen('setup');
