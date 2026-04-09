---
"@acpfx/cli": minor
"@acpfx/mic-speaker": minor
"@acpfx/audio-player": patch
"@acpfx/stt-deepgram": patch
"@acpfx/stt-elevenlabs": patch
"@acpfx/stt-kyutai": patch
"@acpfx/core": patch
---

Independent mic/speaker for push-to-talk mode: hold Space to capture, release to finalize.

- sys-voice: add PlaybackHandle + IndependentCaptureHandle with per-platform backends (macOS VoiceProcessingIO capture-only, Linux PulseAudio, Windows WASAPI)
- mic-speaker: mode setting (ptt/continuous), independent capture created/dropped on mute/unmute, audio.start/end events for STT session boundaries, control.interrupt on unmute
- STT nodes: turnDetection setting to disable VAD/endpointing, audio.start/end handlers for PTT finalization, proper end-of-stream signaling (Deepgram Finalize, ElevenLabs manual commit, Kyutai buffer flush)
- UI: don't show "Interrupted" on the emitting node
- All example pipelines default to hold-to-unmute with turnDetection off
