# @acpfx/stt-kyutai

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
