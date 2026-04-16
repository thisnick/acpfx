# @acpfx/core

## 0.5.1

### Patch Changes

- a3e4495: Replace subprocess-based ACPX bridge with native Rust ACP client

  - New `@acpfx/bridge-acp` Rust crate: direct JSON-RPC 2.0 over NDJSON to the agent process
  - Agent spawned once at startup, persistent connection — zero subprocess overhead per prompt
  - Streaming responses via non-blocking send_request + async message channel
  - Session persistence scoped by CWD + agent + session name
  - Session replay on load: prior conversation displayed as agent.history events in TUI (not routed to TTS)
  - Permission handling: auto-approve via bypassPermissions mode
  - Agent-initiated requests handled: fs/read_text_file, fs/write_text_file, session/request_permission
  - New agent.history event type in schema for TUI-only session replay
  - Removed old TypeScript bridge-acpx package
  - Pipeline configs updated: bridge-acpx → bridge-acp, args → permissionMode
  - CI: added bridge-acp integration tests

## 0.5.0

### Minor Changes

- a994112: Add conditional output routing, responseMode tagging, SMS reply, and lazy STT/TTS connections

  - Orchestrator: `whenFieldEquals` conditional filter on output edges for field-based routing
  - Bridge: tags all agent events with `responseMode: "voice" | "text"` based on input source
  - Phone node: channel binding (activeSmsContact/activeCallContact), SMS reply with delta accumulation and chunking at 1500 chars, `from` removed from prompt.text (pipeline is channel-agnostic)
  - TTS: lazy connection — warm-up on `agent.submit`, disconnect on `agent.complete`, zero idle connections
  - STT: lazy connection — connect on first `audio.chunk`, disconnect on `audio.end`
  - Pipeline configs: phone-agent YAMLs use whenFieldEquals to route voice→TTS and text→phone

## 0.4.2

### Patch Changes

- 921de4c: Independent mic/speaker for push-to-talk mode: hold Space to capture, release to finalize.

  - sys-voice: add PlaybackHandle + IndependentCaptureHandle with per-platform backends (macOS VoiceProcessingIO capture-only, Linux PulseAudio, Windows WASAPI)
  - mic-speaker: mode setting (ptt/continuous), independent capture created/dropped on mute/unmute, audio.start/end events for STT session boundaries, control.interrupt on unmute
  - STT nodes: turnDetection setting to disable VAD/endpointing, audio.start/end handlers for PTT finalization, proper end-of-stream signaling (Deepgram Finalize, ElevenLabs manual commit, Kyutai buffer flush)
  - UI: don't show "Interrupted" on the emitting node
  - All example pipelines default to hold-to-unmute with turnDetection off

## 0.4.1

### Patch Changes

- 05c4208: Embed manifest.yaml via include_str in native binaries (no hardcoded inline). Fix realpathSync for npx symlink manifest resolution. Remove speaker dep from audio-player.

## 0.4.0

### Minor Changes

- 0e6838e: Add local on-device STT and TTS nodes (no API keys required). Introduces --acpfx-\* flag convention with setup phase for first-time model downloads, dynamic release pipeline with dual CPU/CUDA builds, MLX acceleration on Mac, and TUI improvements for speech event display.

## 0.3.0

### Minor Changes

- a0320a1: Add manifest argument/env schema, config system, pipeline resolver, and onboarding TUI

  - **Manifest schema**: Node manifests now declare typed `arguments` (string/number/boolean with defaults, enums, required) and `env` var requirements. Codegen produces TypeScript types + Zod schemas.
  - **All 12 node manifests updated** with arguments and env declarations derived from source code audit.
  - **Build-time validation**: `scripts/validate-manifests.ts` validates against generated Zod schema. Orchestrator validates settings at startup.
  - **Config system**: `~/.acpfx/config.json` (global) and `.acpfx/config.json` (project) with env var layering. New CLI: `acpfx config`, `acpfx config set/get`.
  - **Pipeline resolver**: `acpfx run [name]` resolves pipelines from .acpfx/pipelines/, ~/.acpfx/pipelines/, or bundled examples. `acpfx pipelines` lists available pipelines.
  - **Onboarding TUI**: `acpfx onboard` for interactive pipeline creation from templates or scratch. Auto-triggered on first `acpfx run` with no default pipeline.

### Patch Changes

- 79c6694: Consolidate mic-aec and mic-sox into unified mic-speaker node

  - **Remove `node-mic-aec` and `node-mic-sox`**: Replaced by the native `node-mic-speaker` package with built-in AEC support.
  - **Add `node-mic-speaker`**: Rust-based mic capture + speaker output with acoustic echo cancellation in a single node.
  - **Simplify pipeline configs**: Remove deprecated AEC/sysvoice pipeline variants; update remaining configs to use `@acpfx/mic-speaker`.
  - **Update audio-player**: Streamline to work with the new mic-speaker node.
  - **Update orchestrator**: Onboarding, templates, and node runner adjusted for consolidated mic node.
  - **Update tests**: Reflect removed packages and new node structure.

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
