---
"@acpfx/mic-speaker": patch
"@acpfx/audio-player": patch
"@acpfx/tts-pocket": patch
"@acpfx/core": patch
"@acpfx/stt-deepgram": patch
"@acpfx/stt-elevenlabs": patch
"@acpfx/tts-deepgram": patch
"@acpfx/tts-elevenlabs": patch
"@acpfx/bridge-acpx": patch
"@acpfx/recorder": patch
"@acpfx/mic-file": patch
"@acpfx/play-file": patch
"@acpfx/echo": patch
"@acpfx/stt-kyutai": patch
"@acpfx/tts-kyutai": patch
---

Embed manifest.yaml via include_str in native binaries (no hardcoded inline). Fix realpathSync for npx symlink manifest resolution. Remove speaker dep from audio-player.
