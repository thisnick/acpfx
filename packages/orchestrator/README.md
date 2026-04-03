# @acpfx/cli

The acpfx orchestrator. A Rust binary that spawns pipeline nodes as child processes, routes NDJSON events between them according to the YAML config, and optionally displays a real-time terminal dashboard (ratatui TUI).

## Install

```bash
npm install @acpfx/cli
```

The postinstall script downloads a prebuilt binary for your platform.

## Usage

```bash
# Run a pipeline
acpfx run --config pipeline.yaml

# Run with terminal dashboard
acpfx run --config pipeline.yaml --ui

# Onboarding wizard
acpfx onboard
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--config` | `examples/pipeline/elevenlabs.yaml` | Path to pipeline YAML config |
| `--dist` | `dist` | Path to built node artifacts |
| `--ready-timeout` | `10000` | ms to wait for each node's `lifecycle.ready` |
| `--ui` | off | Enable ratatui terminal dashboard |

## Node Resolution

When the orchestrator encounters a `use: "@acpfx/<name>"` entry in the pipeline YAML, it resolves the node in this order:

1. **Local JS bundle:** `dist/nodes/<name>.js` -- run via `node`
2. **Local native binary:** `dist/nodes/<name>` -- spawn directly
3. **npx fallback:** `npx -y @acpfx/<name>@latest` -- downloads and runs the latest published version

Users configure which nodes to use in their pipeline YAML files. See the [Config Format](#config-format) section above for examples.

## Available Nodes

| Package | Description |
|---------|-------------|
| [@acpfx/mic-speaker](../node-mic-speaker/README.md) | Native mic capture with acoustic echo cancellation |
| [@acpfx/mic-file](../node-mic-file/README.md) | WAV file playback as mic input (testing) |
| [@acpfx/stt-deepgram](../node-stt-deepgram/README.md) | Deepgram streaming STT |
| [@acpfx/stt-elevenlabs](../node-stt-elevenlabs/README.md) | ElevenLabs streaming STT |
| [@acpfx/stt-kyutai](../node-stt-kyutai/README.md) | Local on-device STT via Kyutai |
| [@acpfx/bridge-acpx](../node-bridge-acpx/README.md) | Agent bridge (Claude via ACP) |
| [@acpfx/tts-deepgram](../node-tts-deepgram/README.md) | Deepgram streaming TTS |
| [@acpfx/tts-elevenlabs](../node-tts-elevenlabs/README.md) | ElevenLabs streaming TTS |
| [@acpfx/tts-kyutai](../node-tts-kyutai/README.md) | Local on-device TTS via Kyutai |
| [@acpfx/tts-pocket](../node-tts-pocket/README.md) | Local lightweight TTS via Pocket TTS |
| [@acpfx/audio-player](../node-audio-player/README.md) | System speaker output with SFX |
| [@acpfx/recorder](../node-recorder/README.md) | Records events to JSONL + audio to WAV |
| [@acpfx/play-file](../node-play-file/README.md) | Writes audio chunks to WAV file |
| [@acpfx/echo](../node-echo/README.md) | Echoes events back (testing) |

## Building from Source

```bash
cargo build --release -p acpfx-orchestrator
```

## License

ISC
