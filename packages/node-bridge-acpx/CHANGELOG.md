# @acpfx/bridge-acpx

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

### Patch Changes

- Updated dependencies [d757640]
  - @acpfx/core@0.2.0
  - @acpfx/node-sdk@0.2.0
