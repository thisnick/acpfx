# @acpfx/bridge-acpx

## 0.4.0

### Minor Changes

- a994112: Add conditional output routing, responseMode tagging, SMS reply, and lazy STT/TTS connections

  - Orchestrator: `whenFieldEquals` conditional filter on output edges for field-based routing
  - Bridge: tags all agent events with `responseMode: "voice" | "text"` based on input source
  - Phone node: channel binding (activeSmsContact/activeCallContact), SMS reply with delta accumulation and chunking at 1500 chars, `from` removed from prompt.text (pipeline is channel-agnostic)
  - TTS: lazy connection — warm-up on `agent.submit`, disconnect on `agent.complete`, zero idle connections
  - STT: lazy connection — connect on first `audio.chunk`, disconnect on `audio.end`
  - Pipeline configs: phone-agent YAMLs use whenFieldEquals to route voice→TTS and text→phone

### Patch Changes

- Updated dependencies [a994112]
  - @acpfx/core@0.5.0
  - @acpfx/node-sdk@0.3.3

## 0.3.0

### Minor Changes

- 1122668: Add phone-otacon node for telephony integration, audio player pacing, and prompt.text support

  - New `@acpfx/phone-otacon` node: bidirectional phone audio + SMS via Otacon server with auto-answer whitelist
  - New `prompt.text` event type for non-voice text input (SMS), queued in bridge when agent is busy
  - Audio player now paces output with 500ms lookahead to prevent Bluetooth stutter
  - All audio (speech + SFX) goes through unified pacing queue
  - Bridge queues prompt.text when agent is streaming, drains after completion

## 0.2.7

### Patch Changes

- Updated dependencies [921de4c]
  - @acpfx/core@0.4.2
  - @acpfx/node-sdk@0.3.2

## 0.2.6

### Patch Changes

- 05c4208: Embed manifest.yaml via include_str in native binaries (no hardcoded inline). Fix realpathSync for npx symlink manifest resolution. Remove speaker dep from audio-player.
- Updated dependencies [05c4208]
  - @acpfx/core@0.4.1
  - @acpfx/node-sdk@0.3.1

## 0.2.5

### Patch Changes

- 44bd51c: Fix npx: bundle all deps (except yaml CJS) so transitive deps like zod are available at runtime

## 0.2.4

### Patch Changes

- 2e9998d: Fix npx execution: add #!/usr/bin/env node shebang to built dist/index.js

## 0.2.3

### Patch Changes

- 0045e6e: Fix npm publishing: each package now builds its own dist/index.js + manifest.json via prepack, so npx resolution works correctly

## 0.2.2

### Patch Changes

- Updated dependencies [0e6838e]
  - @acpfx/core@0.4.0
  - @acpfx/node-sdk@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [79c6694]
- Updated dependencies [a0320a1]
  - @acpfx/core@0.3.0
  - @acpfx/node-sdk@0.2.1

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
