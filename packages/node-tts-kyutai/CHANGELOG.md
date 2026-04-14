# @acpfx/tts-kyutai

## 0.2.4

### Patch Changes

- 3aee7f1: Fix Kyutai TTS interrupt during flush and PTT race condition

  - Make flush_remaining() interruptible by accepting a check_interrupted callback that polls for control.interrupt between generation steps
  - Update finish_generation() to detect interrupts during flush and discard buffered output
  - Route idle-branch agent.complete through finish_generation() for consistent interrupt handling
  - Fix PTT race condition: add monotonic seq counter to mute events and gap-aware re-activation in HoldState to prevent stale timeout-mute from killing active capture
  - Add interrupt unit tests and CI step for Python node tests

## 0.2.3

### Patch Changes

- dca8263: Fix npx symlink resolution in Python node bash wrappers

## 0.2.2

### Patch Changes

- 13d47a9: Fix manifest lookup in Python nodes: use os.path.realpath + load manifest.yaml from package root instead of hardcoded inline JSON

## 0.2.1

### Patch Changes

- c520c3f: Add Windows uv install instructions to error message. Clarify --dist flag is dev only.

## 0.2.0

### Minor Changes

- 0e6838e: Add local on-device STT and TTS nodes (no API keys required). Introduces --acpfx-\* flag convention with setup phase for first-time model downloads, dynamic release pipeline with dual CPU/CUDA builds, MLX acceleration on Mac, and TUI improvements for speech event display.
