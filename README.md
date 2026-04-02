# acpfx

Observable audio pipeline framework for voice agents.

Speak to coding agents like Claude Code through your microphone. Hear their responses through your speaker. See everything in a real-time terminal dashboard.

## Architecture

```
mic → stt → bridge → tts → player
              ↓
         ACP agent
       (Claude Code)
```

Nodes are child processes connected via NDJSON stdio. The graph topology is defined in YAML and supports cycles (e.g., player → mic for echo cancellation). The Rust orchestrator routes events between nodes, filtering by each node's declared manifest contract.

## Quick Start

```bash
# Install dependencies
pnpm install

# Build TypeScript nodes
pnpm build

# Build Rust orchestrator
cargo build --release -p acpfx-orchestrator

# Set up API keys
echo 'DEEPGRAM_API_KEY=...' > .env
echo 'dotenv' > .envrc && direnv allow

# Run with terminal dashboard
pnpm start --config examples/pipeline/deepgram-sysvoice.yaml --ui

# Run headless
pnpm start --config examples/pipeline/deepgram-sysvoice.yaml
```

## Config

Pipelines are YAML files. Each node has `use` (implementation), `settings`, and `outputs` (event routing):

```yaml
nodes:
  mic:
    use: "@acpfx/mic-aec"
    settings: { sampleRate: 16000, speechSource: player }
    outputs: [stt]
  stt:
    use: "@acpfx/stt-deepgram"
    settings: { language: en, model: nova-3 }
    outputs: [bridge]
  bridge:
    use: "@acpfx/bridge-acpx"
    settings: { agent: claude, session: voice }
    outputs: [tts, player]
  tts:
    use: "@acpfx/tts-deepgram"
    settings: { voice: aura-2-aries-en }
    outputs: [player]
  player:
    use: "@acpfx/audio-player"
    settings: { speechSource: tts, noLocalPlayback: true }
    outputs: [mic]  # cycle: reference audio for AEC
```

See `examples/pipeline/` for more configurations (Deepgram, ElevenLabs, with/without AEC).

## Packages

### Rust

| Package | Description |
|---------|-------------|
| `packages/orchestrator` | Rust orchestrator — event routing, manifest filtering, ratatui TUI |
| `packages/schema` | Canonical event types (source of truth), codegen to TypeScript + Zod |
| `packages/sys-voice` | Native audio I/O with OS-level AEC |
| `packages/node-mic-aec` | Mic capture with acoustic echo cancellation |

### TypeScript Nodes

| Package | Description |
|---------|-------------|
| `node-mic-sox` | Mic capture via sox |
| `node-mic-file` | WAV file input (for testing) |
| `node-stt-deepgram` | Deepgram streaming STT |
| `node-stt-elevenlabs` | ElevenLabs streaming STT |
| `node-bridge-acpx` | ACP agent bridge (Claude via acpx) |
| `node-tts-deepgram` | Deepgram streaming TTS |
| `node-tts-elevenlabs` | ElevenLabs streaming TTS |
| `node-audio-player` | Speaker output with SFX |
| `node-play-file` | WAV file output (for testing) |
| `node-recorder` | Records events + audio + generates timeline |
| `node-echo` | Passthrough (for testing) |

### Shared

| Package | Description |
|---------|-------------|
| `core` | Generated types, Zod schemas, manifest utilities |
| `node-sdk` | Node authoring SDK: `emit()`, `log.*`, `onEvent()` |

## Manifest Contracts

Every node declares what it consumes and emits in a `manifest.yaml`:

```yaml
name: stt-deepgram
consumes: [audio.chunk]
emits: [speech.partial, speech.final, speech.pause, lifecycle.ready, lifecycle.done]
```

The orchestrator filters events at runtime — nodes only receive what they declared. See [AGENTS.md](AGENTS.md) for details.

## Event Protocol

Events are NDJSON with a `type` field, stamped by the orchestrator with `ts` and `_from`:

| Category | Events |
|----------|--------|
| `audio` | `audio.chunk`, `audio.level` |
| `speech` | `speech.partial`, `speech.delta`, `speech.final`, `speech.pause` |
| `agent` | `agent.submit`, `agent.delta`, `agent.complete`, `agent.thinking`, `agent.tool_start`, `agent.tool_done` |
| `control` | `control.interrupt`, `control.state`, `control.error` |
| `lifecycle` | `lifecycle.ready`, `lifecycle.done` |
| `log` | `log` |
| `player` | `player.status` |

Full protocol reference: [docs/PROTOCOL.md](docs/PROTOCOL.md)

## Development

```bash
pnpm install                                    # install TS deps
pnpm build                                      # build TS nodes
cargo build --release -p acpfx-orchestrator     # build orchestrator
cargo test --workspace                          # Rust tests
pnpm check                                      # TypeScript type check
cargo run -p acpfx-schema --bin acpfx-codegen   # regenerate types from schema
```

## Requirements

- Node.js 22+, pnpm
- Rust (via rustup)
- sox (`brew install sox`) — for mic-sox node
- API keys for STT/TTS providers (Deepgram, ElevenLabs)
- acpx (`npx acpx@latest`) — for the ACP agent bridge
