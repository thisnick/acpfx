# @acpfx/mic-aec

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
