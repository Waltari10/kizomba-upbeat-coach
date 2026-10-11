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
| **Play a song from this device** | Pick a music file; the app analyses its beat up front (with look-ahead) and plays it itself. The beat timing is exact and room noise can't interfere, so this is the most reliable mode in a noisy room. |
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
- Play the music from a speaker, not headphones, so the microphone can hear it. In a noisy room
  (people talking, fans, AC) use **Play a song from this device** instead.
- It is built for solo practice. With a partner in close embrace, the tracker can jump between
  the two bodies, and verdicts are less reliable.
- Watch the four beat dots: they should flash on the main beat (the bass/kick). If the song fools
  the tracker into following the off-beat, tick **Settings → shift by half a beat**.
- If the camera lags the music on your device, adjust **Settings → Sync offset**.

## Delay correction (live mode)

Camera and microphone each have their own delay, and they push in opposite directions, so each is
corrected where it happens (`src/core/latency.js`):

- **Camera:** if the browser timestamps each frame at capture (`requestVideoFrameCallback`
  `captureTime`, usually available in Chrome), that exact time is used. Otherwise the frame's
  display time minus a conservative **60 ms** default is used (camera pipelines are typically
  40–100 ms).
- **Microphone:** the input delay the browser reports (Chrome), otherwise a **25 ms** default.
  Only the input delay matters, because you and the microphone hear the speaker at the same
  moment.
- **Calibrate delay** (start screen) measures what's left on your device. You clap about 8 times,
  at any pace and without music. Each clap is heard by the microphone and seen by the camera
  (palms meeting, timed between frames), and the median difference is saved as the sync
  fine-tune. It is saved only if at least 5 claps were both heard and seen, most claps
  matched, and they agree within ±30 ms; otherwise nothing changes. Stray sounds don't throw it
  off: it picks the delay at which the most claps line up.
- **Settings → Fine-tune sync** holds the calibrated value, and you can still change it by hand.
  The drawer shows which corrections are active.

At 90 BPM the app accepts your high point within ±167 ms of the beat (±¼ beat). In the simulated
live test, the timing matches video mode (which has no device delay) to within about 25 ms once
the applied correction is accounted for. That test can't check the 60 ms camera estimate
itself, because the simulated camera has no real pipeline delay. It hasn't been measured on a
real phone or webcam yet.

The calibration's detectors are unit-tested on synthetic claps (sound onsets to <1 ms, hand
contact between frames to <20 ms), and the screen flow is tested end to end. I couldn't find
clean real footage of one person clapping in a quiet room, though. On noisy YouTube footage
(several people, audience noise) the quality gate correctly refuses to save a value. So its
accuracy on a real device is still to be confirmed.

## Limitations (measured)

- **Microphone mode needs the music clearly louder than steady background noise.** With pink
  noise 23 dB below the music, the correct beat was found 17–98% of the time depending on the
  song; at 11 dB below, mostly not at all. The app then shows "Listening for the beat…" rather
  than judging against a wrong beat. A phone-speaker sound (no bass below ~350 Hz), echo and
  quiet playback were handled well.
- **"Is there a beat?" isn't perfect.** Pink noise is mistaken for music about 6% of the time, and
  synthetic speech about 23% (computer speech has a very regular rhythm). A false beat only
  produces verdicts if you're also bouncing rhythmically.
- **Couples:** see the tip above. On two couple demo videos the dancers' timing relative to the
  beat was inconsistent, so verdicts were close to 50/50.

## Tests

```bash
npm test                     # unit tests: onset detection, beat tracking, bounce analysis
bash test/e2e/fetch-media.sh # downloads public Kizomba videos from YouTube (needs yt-dlp + ffmpeg)
npx playwright install chromium
npm run e2e                  # end-to-end simulation in headless Chromium (~12 min, real time)
npm run e2e:ui               # UI robustness: seeking, settings, restarts, song mode, calibration, CPU fallback
```

The end-to-end simulation (`test/e2e/run-e2e.mjs`):

1. Plays real Kizomba videos from YouTube through **Analyse a video**. Each runs twice, once as
   is and once with the soundtrack delayed by exactly half a beat. The pose data are identical,
   so a correct analyzer must flip its verdict between the two (up-beat ↔ down-beat).
2. Runs the **live** path with a fake webcam and microphone fed from a dance video (getUserMedia
   is replaced by a stream captured from the video). This covers mic capture → beat tracker →
   pose → judging → feedback.
3. Runs the **built-in practice groove** with the voice coach and beat tick on.

`test/e2e/ui-stress.mjs` checks that:

- seeking keeps judging;
- the half-beat toggle moves the measured high point by exactly ½ beat, and the sync slider by
  offset ÷ beat length;
- repeated start/stop cycles and reloads keep working and settings persist;
- song mode locks to the song's tempo;
- the CPU-only pose fallback still runs in real time.

Tools for tuning:

- `test/e2e/record-pose.mjs` + `test/e2e/replay.mjs`: record raw landmarks once, then replay them
  through the analysis code offline (with an optional half-beat audio delay for the flip test).
- `test/e2e/tempo-bench.mjs`: tempo/beat-lock benchmark over real soundtracks.

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
