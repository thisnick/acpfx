---
"@acpfx/stt-deepgram": patch
"@acpfx/stt-elevenlabs": patch
"@acpfx/tts-deepgram": patch
"@acpfx/tts-elevenlabs": patch
"@acpfx/bridge-acpx": patch
"@acpfx/audio-player": patch
"@acpfx/recorder": patch
"@acpfx/mic-file": patch
"@acpfx/play-file": patch
"@acpfx/echo": patch
---

Fix npm publishing: each package now builds its own dist/index.js + manifest.json via prepack, so npx resolution works correctly
