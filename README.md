# Kizomba Upbeat Coach

A browser app that watches you dance Kizomba through the webcam and tells you, beat by beat,
whether you are dancing on the **up-beat** (✓) or the **down-beat**.

Set up your phone or laptop so it can see your whole body, put on some Kizomba, press **Start
dancing**. You get:

- **Visual feedback**: a big verdict (UP-BEAT ✓ / DOWN-BEAT / bounce a little / …), a green or red
  flash on every judged beat, your skeleton coloured by the verdict, a dial showing where your
  high point falls within the beat, a live trace of your hip height with the beat lines drawn in,
  and a running score.
- **Audio feedback** (choose one): short chimes and buzzes, or a voice coach ("Rise on the beat",
  "Nice, that's the up-beat"). There's also an optional tick on every beat.
- A **session summary** with your up-beat percentage and a beat-by-beat timeline.

Everything runs locally in the browser. No video or audio leaves the device.

## What counts as "up-beat"?

In Kizomba the body moves softly up and down with the steps. Here, **up-beat** means your body
is **at its highest on the beat** and sinks (knees bend) on the "and" in between. **Down-beat**
is the opposite: you drop into the floor on the beat.

The coach measures the height of your hips (in torso lengths, so distance to the camera doesn't
matter) and fits a beat-frequency oscillation over the last 4 beats. The phase of that
oscillation is the position of your high point within the beat: near the beat means up-beat,
near the "and" means down-beat. Movement that rises and falls over *two* beats is modelled
separately. If that's all you do, the app says "Every 2nd beat" instead of guessing.

## Music sources

| Source | How the beat is found |
| --- | --- |
| **Music playing in the room** (default) | The microphone listens; a spectral-flux onset detector (bass-weighted, because the kick/bass carries the Kizomba beat while hi-hats sit on the "and") feeds an autocorrelation tempo estimator and a comb-filter phase tracker with a phase-locked loop. |
| **Built-in practice groove** | The app synthesises a simple Kizomba/ghetto-zouk groove (70–120 BPM), so the beat is known exactly. |
| **Analyse a video** | Pick a recording (of yourself or anyone). The soundtrack is analysed up front and the video is judged as it plays. |

## Running it

```bash
npm install     # also copies the MediaPipe runtime to vendor/ and downloads the pose models
npm start
```

- On this computer: open **http://localhost:8080**
- On a phone or tablet on the same Wi-Fi: open the **https://<your-ip>:8443** address the server
  prints and accept the self-signed certificate warning once. Browsers only allow the camera on
  https or localhost.

`vendor/` is plain static files, so the whole folder can be served by any static web server over
HTTPS.

### Tips

- Whole body in view (head to feet), 2–3 m from the camera, decent light.
- Play the music from a speaker, not headphones, so the microphone can hear it.
- Watch the four beat dots: they should flash on the main beat (the bass/kick). If the song fools
  the tracker into following the off-beat, tick **Settings → shift by half a beat**.
- If the camera lags the music on your device, adjust **Settings → Sync offset**.

## Tests

```bash
npm test                     # unit tests: onset detection, beat tracking, bounce analysis
bash test/e2e/fetch-media.sh # downloads public Kizomba videos from YouTube (needs yt-dlp + ffmpeg)
npx playwright install chromium
npm run e2e                  # end-to-end simulation in headless Chromium
```

The end-to-end simulation (`test/e2e/run-e2e.mjs`):

1. Plays real Kizomba videos from YouTube through **Analyse a video**. Each runs twice, once as
   is and once with the soundtrack delayed by exactly half a beat. The pose data are identical,
   so a correct analyzer must flip its verdict between the two (up-beat ↔ down-beat).
2. Runs the **live** path with a fake webcam and a fake microphone fed from the same dance video
   (`--use-file-for-fake-video-capture` / `--use-file-for-fake-audio-capture`). This covers
   getUserMedia → AudioWorklet → beat tracker → pose → feedback.

`test/e2e/record-pose.mjs` + `test/e2e/replay.mjs` record raw landmarks once and replay them
through the analysis code offline, for fast tuning.

## Project layout

```
index.html, css/style.css     UI
src/main.js                   app wiring: camera, pose loop, judging, HUD drawing
src/pose.js                   MediaPipe PoseLandmarker wrapper (GPU with CPU fallback)
src/core/onset.js             FFT + spectral-flux onset detector
src/core/beatTracker.js       tempo/phase tracker, offline grid precomputation
src/core/bounce.js            hip-height extraction and up/down-beat analysis
src/audio/                    mic capture worklet, practice groove, file analysis, clock sync
src/ui/feedback.js            tones, voice coach, beat tick
server.mjs                    zero-dependency static server (http + self-signed https)
scripts/setup.mjs             vendors MediaPipe + models (runs on npm install)
```
