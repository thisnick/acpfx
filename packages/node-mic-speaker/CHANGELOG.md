# @acpfx/mic-speaker

## 0.4.4

### Patch Changes

- 30d2161: Fix npx resolution to always use @latest. Re-enable CUDA builds for Linux and Windows. Add package READMEs, LICENSE, and credits.

## 0.4.3

### Patch Changes

- 6442a57: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.4.2

### Patch Changes

- d717712: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.4.1

### Patch Changes

- ee63a45: Fix release pipeline: only pass --features metal/cuda to packages that declare them.

## 0.4.0

### Minor Changes

- 0e6838e: Add local on-device STT and TTS nodes (no API keys required). Introduces --acpfx-\* flag convention with setup phase for first-time model downloads, dynamic release pipeline with dual CPU/CUDA builds, MLX acceleration on Mac, and TUI improvements for speech event display.

## 0.3.0

### Minor Changes

- 79c6694: Consolidate mic-aec and mic-sox into unified mic-speaker node

  - **Remove `node-mic-aec` and `node-mic-sox`**: Replaced by the native `node-mic-speaker` package with built-in AEC support.
  - **Add `node-mic-speaker`**: Rust-based mic capture + speaker output with acoustic echo cancellation in a single node.
  - **Simplify pipeline configs**: Remove deprecated AEC/sysvoice pipeline variants; update remaining configs to use `@acpfx/mic-speaker`.
  - **Update audio-player**: Streamline to work with the new mic-speaker node.
  - **Update orchestrator**: Onboarding, templates, and node runner adjusted for consolidated mic node.
  - **Update tests**: Reflect removed packages and new node structure.

## 0.2.4

### Patch Changes

- 6e742d2: Fix binary downloads: split GitHub Releases so each package has its own binaries, fix postinstall URL encoding

## 0.2.3

### Patch Changes

- 65d0337: Use native GitHub runners for all 6 platforms (no cross-compilation)

## 0.2.2

### Patch Changes

- 5412c87: Rename orchestrator package to @acpfx/cli (npm rejected 'acpfx' as too similar to 'cpx').
  Fix darwin-x64 builds: use macos-14 runner (macos-13 retired).
  Switch to postinstall binary download pattern (no more platform npm packages).

## 0.2.1

### Patch Changes

- 5332dd2: Fix darwin-x64 binary builds: macos-13 runner retired, use macos-14 with cross-compilation

## 0.2.0

### Minor Changes

- d757640: Initial release: type-safe contracts, Rust orchestrator, manifest-driven event filtering

  - Rust schema crate as canonical event type source of truth with codegen to TypeScript + Zod
  - Node manifests (manifest.yaml) declaring consumes/emits contracts
  - Orchestrator event filtering: nodes only receive declared events
  - Rust orchestrator with ratatui TUI (--ui flag)
  - node-sdk with structured logging helpers
  - CI/CD with GitHub Actions and changesets
  - Platform-specific npm packages for Rust binaries (esbuild-style distribution)
