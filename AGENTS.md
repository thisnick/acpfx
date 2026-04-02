# acpfx -- Observable Audio Pipeline Framework

## What is this?

acpfx is a pluggable, observable audio pipeline framework for voice agents and general audio/event processing. Nodes are child processes connected via NDJSON stdio; the graph topology is defined in YAML and can include cycles. The Rust orchestrator routes events between nodes, stamping each with `ts` and `_from`.

## Core Principles

1. **No hardcoded names or topology.** Node names in YAML are user-chosen. Code must never reference a specific node name. Use `process.env.ACPFX_NODE_NAME` for self-identification and settings for source filtering. The orchestrator is a dumb router.

2. **Everything is a node.** Nodes are child processes (TypeScript via `node`, native binaries, or `npx` packages) that speak NDJSON on stdin/stdout and log to stderr. A node's contract is declared in its `manifest.yaml`.

3. **Manifest-driven contracts.** Every node declares what it `consumes` and `emits` in a `manifest.yaml`. The orchestrator loads manifests at startup and filters events: a node only receives events whose type is in its `consumes` list. Empty consumes = permissive (accepts everything).

4. **Observable event bus.** All events flow through the orchestrator. Any node can observe the full event stream (recorder, UI, analytics). Events are category-namespaced (`audio.*`, `speech.*`, `agent.*`, etc.).

5. **Graph supports cycles.** The topology is a general directed graph, not a DAG. Cycles are valid and common (e.g., player -> mic for echo cancellation reference audio). The orchestrator handles cycle-aware topological ordering.

6. **Low latency, true streaming.** STT streams partials, LLM streams tokens, TTS streams audio chunks. No buffering between stages.

7. **Pluggable via npm.** Each node is its own package (`@acpfx/<name>`). Resolution: local `dist/` build -> npx fallback. Third-party nodes follow the same NDJSON contract.

## Running a Pipeline

The orchestrator is a Rust binary (`packages/orchestrator/`):

```bash
# Via cargo (development)
cargo run -p acpfx-orchestrator --release -- run --config examples/pipeline/elevenlabs.yaml

# Via pnpm (after cargo build)
pnpm start --config examples/pipeline/elevenlabs.yaml

# With terminal dashboard UI
pnpm start --config examples/pipeline/elevenlabs.yaml --ui
```

CLI flags for `acpfx run`:

| Flag | Default | Description |
|------|---------|-------------|
| `--config` | `examples/pipeline/elevenlabs.yaml` | Path to pipeline YAML config |
| `--dist` | `dist` | Path to built node artifacts |
| `--ready-timeout` | `10000` | ms to wait for each node's `lifecycle.ready` |
| `--ui` | off | Enable ratatui terminal dashboard |

## Config Format

Pipeline configs are YAML files with a `nodes` map and optional `env`:

```yaml
nodes:
  mic:
    use: '@acpfx/mic-sox'
    settings: {sampleRate: 16000, channels: 1}
    outputs: [stt]
  stt:
    use: '@acpfx/stt-deepgram'
    settings: {language: en, model: nova-3}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acpx'
    settings:
      agent: claude
      session: voice
      args: {approve-all: true}
    outputs: [tts, player]
  tts:
    use: '@acpfx/tts-deepgram'
    settings: {voice: aura-2-aries-en}
    outputs: [player]
  player:
    use: '@acpfx/audio-player'
    settings: {speechSource: tts}
    outputs: []
env:
  DEEPGRAM_API_KEY: ${DEEPGRAM_API_KEY}
```

Each node entry has:
- `use` -- package reference (`@acpfx/<name>`, external path, or binary)
- `settings` -- JSON passed via `ACPFX_SETTINGS` env var
- `outputs` -- list of node names this node sends events to

With AEC (cyclic graph -- player feeds reference audio back to mic):

```yaml
nodes:
  mic:
    use: '@acpfx/mic-aec'
    settings: {sampleRate: 16000, speechSource: player}
    outputs: [stt]
  # ... stt, bridge, tts as above ...
  player:
    use: '@acpfx/audio-player'
    settings: {speechSource: tts}
    outputs: [mic]       # <-- cycle: reference audio for AEC
```

### Manifest files

Co-located `manifest.yaml` at each package root:

```yaml
name: stt-deepgram
description: Speech-to-text via Deepgram streaming API
consumes:
  - audio.chunk
emits:
  - speech.partial
  - speech.final
  - speech.pause
  - lifecycle.ready
  - lifecycle.done
  - control.error
```

At build time, manifests are copied next to built artifacts as both `.manifest.yaml` and `.manifest.json`. The orchestrator reads the co-located manifest file. All nodes must also support `--manifest` (prints manifest JSON to stdout and exits).

## Package Overview

### Rust crates (`packages/`)

| Package | Description |
|---------|-------------|
| `orchestrator` | Rust CLI -- spawns nodes, routes events, manifest filtering, TUI |
| `schema` | Canonical event type definitions; source of truth for codegen |
| `sys-voice` | Rust crate for native audio I/O (used by mic-aec) |
| `node-mic-aec` | Native Rust mic capture with acoustic echo cancellation |

### TypeScript node packages (`packages/node-*`)

| Package | Consumes | Emits | Description |
|---------|----------|-------|-------------|
| `node-mic-sox` | `control.interrupt` | `audio.chunk`, `audio.level` | Mic capture via sox/rec |
| `node-mic-file` | `control.interrupt` | `audio.chunk`, `audio.level` | WAV file playback as mic input |
| `node-stt-deepgram` | `audio.chunk` | `speech.*` | Deepgram streaming STT |
| `node-stt-elevenlabs` | `audio.chunk` | `speech.*` | ElevenLabs streaming STT |
| `node-bridge-acpx` | `speech.partial`, `speech.pause`, `control.interrupt` | `agent.*`, `control.interrupt` | Agent bridge (Claude via ACP) |
| `node-tts-deepgram` | `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt` | `audio.chunk` | Deepgram streaming TTS |
| `node-tts-elevenlabs` | `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt` | `audio.chunk` | ElevenLabs streaming TTS |
| `node-audio-player` | `audio.chunk`, `agent.*`, `control.interrupt` | `audio.chunk`, `player.status` | System speaker output with SFX |
| `node-recorder` | all event types | `lifecycle.*` | Records events to JSONL + audio to WAV |
| `node-play-file` | `audio.chunk`, `control.interrupt` | `lifecycle.*` | Writes audio chunks to WAV file |
| `node-echo` | all event types | all event types | Echoes events back (testing) |

### Shared TypeScript packages

| Package | Description |
|---------|-------------|
| `core` | Generated types, Zod schemas, manifest utilities, protocol helpers |
| `node-sdk` | Node authoring SDK: `emit()`, `log.*`, `onEvent()`, `handleManifestFlag()` |

### npm distribution (`npm/`)

| Directory | Description |
|-----------|-------------|
| `npm/acpfx` | Platform-specific orchestrator binaries (`@acpfx/cli`) |
| `npm/mic-aec` | Platform-specific mic-aec binaries |

## Event Protocol

Events are JSON objects with a `type` field. The orchestrator stamps each with `ts` (epoch ms) and `_from` (source node name). See **docs/PROTOCOL.md** for the full type reference.

**Categories:**
- `audio` -- `audio.chunk`, `audio.level`
- `speech` -- `speech.partial`, `speech.delta`, `speech.final`, `speech.pause`
- `agent` -- `agent.submit`, `agent.delta`, `agent.complete`, `agent.thinking`, `agent.tool_start`, `agent.tool_done`
- `control` -- `control.interrupt`, `control.state`, `control.error`
- `lifecycle` -- `lifecycle.ready`, `lifecycle.done`
- `log` -- `log`
- `player` -- `player.status`

**Routing rules:**
- Data events route via configured `outputs` edges, filtered by the destination's `consumes` manifest.
- `control.interrupt` broadcasts to all transitive downstream nodes that declare it in `consumes`.
- `log` events broadcast to all nodes that consume them (beyond direct outputs).

## Development

### Build

```bash
pnpm install                              # install TS dependencies
pnpm build                                # esbuild all TS nodes to dist/
cargo build --release -p acpfx-orchestrator  # build orchestrator
```

### Codegen (schema -> TypeScript)

```bash
cargo run -p acpfx-schema --bin acpfx-codegen
```

Produces `packages/core/src/generated-types.ts`, `generated-zod.ts`, and `schema.json`. Generated files are checked in. CI verifies no drift.

### Testing

```bash
cargo test --workspace      # Rust tests (schema, orchestrator, config)
cargo clippy --workspace    # Rust lints
pnpm check                  # TypeScript type checking
```

### Writing a new node

1. Create `packages/node-<name>/` with `src/index.ts`, `manifest.yaml`, `package.json`
2. Use `@acpfx/node-sdk` for `emit()`, `log.*`, `onEvent()`, `handleManifestFlag()`
3. Emit `lifecycle.ready` when initialized
4. Process only events declared in your `consumes` manifest
5. Add to the `nodePackages` array in `scripts/build.js`

## Things to Avoid

- **Never hardcode node names** -- use `ACPFX_NODE_NAME` env var and settings.
- **Never assume a specific graph topology** -- nodes should work in any valid wiring.
- **Don't buffer when you can stream** -- latency is critical for voice.
- **Don't put business logic in the orchestrator** -- it is a dumb event router.
- **stderr is for crashes only** -- use `log.*` from node-sdk for structured logging on stdout.
