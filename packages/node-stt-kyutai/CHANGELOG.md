# @acpfx/stt-kyutai

## 0.3.4

### Patch Changes

- 4b83cb4: Fix TTS audio cutoff, improve SFX lifecycle, and add Kyutai silence-based pause detection

  - TTS Deepgram/ElevenLabs: increase idle timeout to 60s and reset on incoming audio chunks to prevent premature WebSocket close during long responses
  - Audio player: keep SFX playing through consecutive tool calls, only stop on agent.delta or agent.complete
  - STT Kyutai: add silence timer (utteranceEndMs) to emit speech.pause after period of no words, fixing agent not responding after speech.final
  - Add phone-agent-local-gpu.yaml pipeline config for on-device Kyutai STT+TTS

## 0.3.3

### Patch Changes

- 921de4c: Independent mic/speaker for push-to-talk mode: hold Space to capture, release to finalize.

  - sys-voice: add PlaybackHandle + IndependentCaptureHandle with per-platform backends (macOS VoiceProcessingIO capture-only, Linux PulseAudio, Windows WASAPI)
  - mic-speaker: mode setting (ptt/continuous), independent capture created/dropped on mute/unmute, audio.start/end events for STT session boundaries, control.interrupt on unmute
  - STT nodes: turnDetection setting to disable VAD/endpointing, audio.start/end handlers for PTT finalization, proper end-of-stream signaling (Deepgram Finalize, ElevenLabs manual commit, Kyutai buffer flush)
  - UI: don't show "Interrupted" on the emitting node
  - All example pipelines default to hold-to-unmute with turnDetection off

## 0.3.2

### Patch Changes

- dca8263: Fix npx symlink resolution in Python node bash wrappers

## 0.3.1

### Patch Changes

- 13d47a9: Fix manifest lookup in Python nodes: use os.path.realpath + load manifest.yaml from package root instead of hardcoded inline JSON

## 0.3.0

### Minor Changes

- d71ad78: Convert stt-kyutai from Rust/Candle to Python with MLX (macOS) and PyTorch (Linux/Windows) backends. Auto-detects GPU at runtime — no compile-time CUDA issues. Same TtsBackend/SttBackend DRY architecture as tts-kyutai.

### Patch Changes

- d71ad78: Disable CUDA CI builds (Linux: toolkit install broken, Windows: CRT mismatch). Postinstall falls back to CPU. Users can build CUDA locally.

## 0.2.6

### Patch Changes

- 04b5165: CUDA builds now target Ampere (compute capability 8.0+) instead of Turing (7.5) to support bf16 WMMA required by candle-kernels. Documented GPU requirements in READMEs.

## 0.2.5

### Patch Changes

- 10d738d: Fix Windows CUDA build: use pwsh instead of bash to avoid Git's link.exe shadowing MSVC linker. Drop Linux CUDA (toolkit install broken on Ubuntu 24.04 GH runners).

## 0.2.4

### Patch Changes

- 30d2161: Fix npx resolution to always use @latest. Re-enable CUDA builds for Linux and Windows. Add package READMEs, LICENSE, and credits.

## 0.2.3

### Patch Changes

- 6442a57: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.2.2

### Patch Changes

- d717712: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.2.1

### Patch Changes

- ee63a45: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.2.0

### Minor Changes

- 0e6838e: Add local on-device STT and TTS nodes (no API keys required). Introduces --acpfx-\* flag convention with setup phase for first-time model downloads, dynamic release pipeline with dual CPU/CUDA builds, MLX acceleration on Mac, and TUI improvements for speech event display.
