import { createPoseDetector, DancerTracker, SKELETON } from './pose.js';
import { BounceAnalyzer, HeightNormalizer, hipHeight } from './core/bounce.js';
import { BeatTracker } from './core/beatTracker.js';
import { MicBeatSource } from './audio/micBeat.js';
import { PracticeBeat } from './audio/practiceBeat.js';
import { analyseFile, SongBeat } from './audio/fileBeat.js';
import { AudioFeedback } from './ui/feedback.js';
import { cameraFrameTime } from './core/latency.js';

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

const STORE_KEY = 'kizomba-coach-settings';
const settings = {
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
  state: 'setup',
  ready: false,
  perf: { frames: 0, detectMs: 0 },
  recordPose: false, // set true (e.g. from the console) to keep raw landmarks in poseLog
  poseLog: [],
});

let ctx, pose, beatSource, fileBeat, feedback, analyzer, normalizer, dancer, wakeLock;
let running = false;
let lastJudgedBeat = null;
let current = { status: 'loading' };
let streak = { status: null, n: 0 };
let latest = { t: null, landmarks: null };
let startedAt = 0;
const video = $('#video');

// ---------- Setup screen ----------
function bindSetup() {
  const form = $('#setup-form');
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
  };
  syncSource();
  form.addEventListener('change', syncSource);
  $('#bpm').addEventListener('input', (e) => ($('#bpm-out').textContent = e.target.value));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
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
  normalizer = new HeightNormalizer();
  dancer = new DancerTracker();
  applySensitivity();
  app.log = [];
  app.stats = { up: 0, down: 0, still: 0, irregular: 0, halftime: 0 };
  lastJudgedBeat = null;
  streak = { status: null, n: 0 };
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
    lastJudgedBeat = null;
  }
  const d0 = performance.now();
  // MediaPipe smooths landmarks over time, so it always gets wall-clock timestamps: media time
  // jumps backwards on a seek, which would make its filter think frames are 1 ms apart.
  const { landmarks, switched } = dancer.pick(pose.detect(video, now));
  if (switched) {
    // A different person was picked up: their hip height is not comparable.
    analyzer.reset();
    normalizer.reset();
  }
  app.perf.frames++;
  app.perf.detectMs += (performance.now() - d0 - app.perf.detectMs) * 0.05;
  latest = { t, landmarks, sampleT };
  if (app.recordPose && landmarks) app.poseLog.push({ t: sampleT, lm: landmarks.map((p) => [+p.x.toFixed(5), +p.y.toFixed(5), +(p.visibility ?? 1).toFixed(2)]) });
  const m = hipHeight(landmarks, video.videoWidth / video.videoHeight || 1);
  if (m) analyzer.addSample(sampleT, normalizer.height(m));
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
  const r = analyzer.analyze(t, grid);
  r.bpm = grid.bpm;
  setStatus(r);
  if (r.status === streak.status) streak.n++;
  else streak = { status: r.status, n: 1 };
  if (r.status in app.stats) app.stats[r.status]++;
  app.log.push({ t: +t.toFixed(3), status: r.status, offset: r.offset, amplitude: r.amplitude, rhythmicity: r.rhythmicity, bpm: grid.bpm });
  if (['up', 'down', 'still', 'irregular', 'halftime'].includes(r.status)) {
    feedback.onJudgement(r.status, streak.n);
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
  return `Automatic delay correction: ${camText}; ${micText}.`;
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
  $('#sum-timeline').innerHTML = app.log
    .filter((l) => ['up', 'down', 'still', 'irregular', 'halftime'].includes(l.status))
    .map((l) => `<i class="${STATUS[l.status].cls}"></i>`)
    .join('');
}

bindSetup();
bindDrawer();
showScreen('setup');
