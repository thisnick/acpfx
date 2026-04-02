---
"@acpfx/core": minor
"@acpfx/node-sdk": minor
"@acpfx/mic-sox": minor
"@acpfx/mic-file": minor
"@acpfx/stt-deepgram": minor
"@acpfx/stt-elevenlabs": minor
"@acpfx/tts-deepgram": minor
"@acpfx/tts-elevenlabs": minor
"@acpfx/bridge-acpx": minor
"@acpfx/audio-player": minor
"@acpfx/play-file": minor
"@acpfx/recorder": minor
"@acpfx/echo": minor
"@acpfx/mic-aec": minor
---

Initial release: type-safe contracts, Rust orchestrator, manifest-driven event filtering

- Rust schema crate as canonical event type source of truth with codegen to TypeScript + Zod
- Node manifests (manifest.yaml) declaring consumes/emits contracts
- Orchestrator event filtering: nodes only receive declared events
- Rust orchestrator with ratatui TUI (--ui flag)
- node-sdk with structured logging helpers
- CI/CD with GitHub Actions and changesets
- Platform-specific npm packages for Rust binaries (esbuild-style distribution)
