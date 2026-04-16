# acpfx

## 0.8.0

### Minor Changes

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

### Patch Changes

- 7fb514e: TUI: add scrollable agent transcript, text wrapping, and focus improvements

  - Agent transcript panel now scrolls with mouse wheel and arrow keys (Up/Down/PgUp/PgDn/Home/End)
  - Auto-scroll follows new content, disables on manual scroll up, re-enables on End key
  - Text wrapping uses actual terminal width instead of hardcoded 100 chars
  - Prompt text now wraps for long spoken input
  - Per-node speech panels use ratatui Wrap for overflow handling
  - Speech panel height grows dynamically based on content
  - Mouse click and scroll wheel auto-focus the target panel
  - Focus indicated by cyan border color

## 0.7.1

### Patch Changes

- 3aee7f1: Fix Kyutai TTS interrupt during flush and PTT race condition

  - Make flush_remaining() interruptible by accepting a check_interrupted callback that polls for control.interrupt between generation steps
  - Update finish_generation() to detect interrupts during flush and discard buffered output
  - Route idle-branch agent.complete through finish_generation() for consistent interrupt handling
  - Fix PTT race condition: add monotonic seq counter to mute events and gap-aware re-activation in HoldState to prevent stale timeout-mute from killing active capture
  - Add interrupt unit tests and CI step for Python node tests

## 0.7.0

### Minor Changes

- a994112: Add conditional output routing, responseMode tagging, SMS reply, and lazy STT/TTS connections

  - Orchestrator: `whenFieldEquals` conditional filter on output edges for field-based routing
  - Bridge: tags all agent events with `responseMode: "voice" | "text"` based on input source
  - Phone node: channel binding (activeSmsContact/activeCallContact), SMS reply with delta accumulation and chunking at 1500 chars, `from` removed from prompt.text (pipeline is channel-agnostic)
  - TTS: lazy connection — warm-up on `agent.submit`, disconnect on `agent.complete`, zero idle connections
  - STT: lazy connection — connect on first `audio.chunk`, disconnect on `audio.end`
  - Pipeline configs: phone-agent YAMLs use whenFieldEquals to route voice→TTS and text→phone

## 0.6.0

### Minor Changes

- 1d5b797: Embed npm package versions at compile time for faster npx resolution, and sync Cargo.toml versions during changeset versioning
- 921de4c: Independent mic/speaker for push-to-talk mode: hold Space to capture, release to finalize.

  - sys-voice: add PlaybackHandle + IndependentCaptureHandle with per-platform backends (macOS VoiceProcessingIO capture-only, Linux PulseAudio, Windows WASAPI)
  - mic-speaker: mode setting (ptt/continuous), independent capture created/dropped on mute/unmute, audio.start/end events for STT session boundaries, control.interrupt on unmute
  - STT nodes: turnDetection setting to disable VAD/endpointing, audio.start/end handlers for PTT finalization, proper end-of-stream signaling (Deepgram Finalize, ElevenLabs manual commit, Kyutai buffer flush)
  - UI: don't show "Interrupted" on the emitting node
  - All example pipelines default to hold-to-unmute with turnDetection off

- 26e1d1f: UI improvements: --verbose flag, scrollable conversation history, manifest-driven toggle controls, push-to-talk, node.status event, interrupt-on-unmute

## 0.5.2

### Patch Changes

- 49d1170: Load env vars from ~/.acpfx/config.json and .acpfx/config.json into pipeline at startup

## 0.5.1

### Patch Changes

- 8d72303: Orchestrator falls back to --acpfx-manifest flag when no co-located manifest file exists (production/npx mode)

## 0.5.0

### Minor Changes

- 3354da7: Per-component configuration in onboarding TUI: edit node arguments, manage connections, edit/rename/delete existing pipelines with backtracking navigation

### Patch Changes

- d71ad78: Convert stt-kyutai from Rust/Candle to Python with MLX (macOS) and PyTorch (Linux/Windows) backends. Auto-detects GPU at runtime — no compile-time CUDA issues. Same TtsBackend/SttBackend DRY architecture as tts-kyutai.

## 0.4.5

### Patch Changes

- c520c3f: Add Windows uv install instructions to error message. Clarify --dist flag is dev only.

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

- a0320a1: Add manifest argument/env schema, config system, pipeline resolver, and onboarding TUI

  - **Manifest schema**: Node manifests now declare typed `arguments` (string/number/boolean with defaults, enums, required) and `env` var requirements. Codegen produces TypeScript types + Zod schemas.
  - **All 12 node manifests updated** with arguments and env declarations derived from source code audit.
  - **Build-time validation**: `scripts/validate-manifests.ts` validates against generated Zod schema. Orchestrator validates settings at startup.
  - **Config system**: `~/.acpfx/config.json` (global) and `.acpfx/config.json` (project) with env var layering. New CLI: `acpfx config`, `acpfx config set/get`.
  - **Pipeline resolver**: `acpfx run [name]` resolves pipelines from .acpfx/pipelines/, ~/.acpfx/pipelines/, or bundled examples. `acpfx pipelines` lists available pipelines.
  - **Onboarding TUI**: `acpfx onboard` for interactive pipeline creation from templates or scratch. Auto-triggered on first `acpfx run` with no default pipeline.

## 0.2.6

### Patch Changes

- ea30448: Skip binary builds when package version unchanged — only build orchestrator if @acpfx/cli was published, only build mic-speaker if @acpfx/mic-speaker was published

## 0.2.5

### Patch Changes

- baf94bd: Upgrade GitHub Actions to Node.js 24 compatible versions

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
