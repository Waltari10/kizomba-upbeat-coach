#!/usr/bin/env bash
# Downloads the public YouTube clips used by the end-to-end simulation and prepares test media:
#  - WebM copies (Playwright's Chromium has no H.264/AAC decoders)
#  - "halfshift" controls whose soundtrack is delayed by exactly half a beat
#  - a clip used as fake webcam + fake microphone for the live-mode test
# Needs yt-dlp and ffmpeg. Files land in test/fixtures/media (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/../fixtures/media" 2>/dev/null || { mkdir -p "$(dirname "$0")/../fixtures/media"; cd "$(dirname "$0")/../fixtures/media"; }

get() { [ -f "$1.mp4" ] || yt-dlp -q -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]" --merge-output-format mp4 -o "$1.mp4" "https://www.youtube.com/watch?v=$1"; }
webm() { ffmpeg -v error -y "$@" -c:v libvpx-vp9 -b:v 1200k -deadline realtime -cpu-used 8 -c:a libopus -b:a 128k; }

# "Kizomba Workout Warm up with Basics practice to music" – solo dancer, 92 BPM
get IRk21M-HXoo
webm -ss 18 -to 220 -i IRk21M-HXoo.mp4 -vf scale=-2:540 workout.webm
ffmpeg -v error -y -i workout.webm -c:v copy -af "adelay=326.1:all=1" -c:a libopus -b:a 128k -shortest workout_halfshift.webm   # ½ beat @ 92.0 BPM
webm -ss 30 -t 60 -i IRk21M-HXoo.mp4 -vf scale=-2:540 live.webm   # fed in as fake webcam + microphone

# "Kizomba Ladies Ginga by Eliza Sala and Iolanda Rangel" – two dancers, 96 BPM
get GNEXZ46EDSk
webm -ss 25 -i GNEXZ46EDSk.mp4 ginga_music.webm
ffmpeg -v error -y -i ginga_music.webm -c:v copy -af "adelay=312.2:all=1" -c:a libopus -b:a 128k -shortest ginga_halfshift.webm  # ½ beat @ 96.1 BPM
ls -la
