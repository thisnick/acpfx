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

Fix npx: bundle all deps (except yaml CJS) so transitive deps like zod are available at runtime
