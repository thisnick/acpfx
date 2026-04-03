# @acpfx/cli

The acpfx orchestrator — spawns pipeline nodes as child processes, routes NDJSON events between them, runs first-time setup (model downloads), and displays a real-time terminal dashboard.

## Install

```bash
npx @acpfx/cli@latest onboard
```

The onboarding wizard walks you through choosing a pipeline template, configuring API keys, and running your first pipeline. A prebuilt binary is downloaded for your platform.

## Usage

```bash
# Run a pipeline by name (resolved from .acpfx/pipelines/ or ~/.acpfx/pipelines/)
acpfx run deepgram
acpfx run local-gpu

# Run with explicit config path
acpfx run --config path/to/pipeline.yaml

# Run headless (no TUI, logs to stderr)
acpfx run deepgram --headless

# Interactive onboarding
acpfx onboard

# Manage configuration
acpfx config set env.DEEPGRAM_API_KEY sk-...
acpfx config get defaultPipeline
acpfx config set defaultPipeline deepgram --global

# List and create pipelines
acpfx pipelines
acpfx pipelines create
```

## Pipeline Resolution

When you run `acpfx run <name>`, the pipeline is resolved in this order:

1. **Direct path** — if `<name>` contains `/` or ends with `.yaml`, load as file path
2. **Project-local** — `.acpfx/pipelines/<name>.yaml`
3. **Global** — `~/.acpfx/pipelines/<name>.yaml`
4. **Bundled** — `examples/pipeline/<name>.yaml` (dev builds only)

If no pipeline is specified and no default is configured, the onboarding wizard runs automatically.

## CLI Flags (`acpfx run`)

| Flag | Default | Description |
|------|---------|-------------|
| `<pipeline>` | | Pipeline name or path (positional) |
| `--config` | | Explicit path to YAML config (overrides positional) |
| `--dist` | `dist` | Path to built node artifacts |
| `--ready-timeout` | `10000` | ms to wait for each node's `lifecycle.ready` |
| `--headless` | off | Disable TUI, log events to stderr |
| `--setup-timeout` | `600000` | ms for node setup phase (model downloads) |
| `--skip-setup` | off | Skip the `--acpfx-setup-check` phase |

## Node Resolution

When the orchestrator encounters `use: "@acpfx/<name>"` in pipeline YAML, it resolves the node binary:

1. **Local JS bundle** — `dist/nodes/<name>.js` → run via `node`
2. **Local native binary** — `dist/nodes/<name>` → spawn directly
3. **npx fallback** — `npx -y @acpfx/<name>@latest` → download and run latest published version

## Setup Phase

Before spawning nodes, the orchestrator runs a setup check:

1. For each node, runs `<binary> --acpfx-setup-check` (5s timeout)
2. If any node reports `{"needed": true}`, runs `<binary> --acpfx-setup` to download models
3. Progress is displayed to stderr; auth errors show clear instructions (e.g., `huggingface-cli login`)
4. Skip with `--skip-setup`

## Available Nodes

| Package | Type | Description |
|---------|------|-------------|
| [@acpfx/mic-speaker](../node-mic-speaker/README.md) | Rust | Native mic capture with AEC |
| [@acpfx/mic-file](../node-mic-file/README.md) | TS | WAV file playback as mic input |
| [@acpfx/stt-deepgram](../node-stt-deepgram/README.md) | TS | [Deepgram](https://deepgram.com) streaming STT |
| [@acpfx/stt-elevenlabs](../node-stt-elevenlabs/README.md) | TS | [ElevenLabs](https://elevenlabs.io) streaming STT |
| [@acpfx/stt-kyutai](../node-stt-kyutai/README.md) | Rust | Local STT via [Kyutai moshi](https://github.com/kyutai-labs/delayed-streams-modeling) |
| [@acpfx/bridge-acpx](../node-bridge-acpx/README.md) | TS | Agent bridge (Claude via [acpx](https://github.com/anthropics/acpx)) |
| [@acpfx/tts-deepgram](../node-tts-deepgram/README.md) | TS | [Deepgram](https://deepgram.com) streaming TTS |
| [@acpfx/tts-elevenlabs](../node-tts-elevenlabs/README.md) | TS | [ElevenLabs](https://elevenlabs.io) streaming TTS |
| [@acpfx/tts-kyutai](../node-tts-kyutai/README.md) | Python | Local TTS via [Kyutai moshi](https://kyutai.org) (MLX on Mac, PyTorch+CUDA on Linux) |
| [@acpfx/tts-pocket](../node-tts-pocket/README.md) | Rust | Local lightweight TTS via [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) |
| [@acpfx/audio-player](../node-audio-player/README.md) | TS | Audio mixer with SFX |
| [@acpfx/recorder](../node-recorder/README.md) | TS | Records events + audio to files |
| [@acpfx/play-file](../node-play-file/README.md) | TS | Writes audio chunks to WAV |
| [@acpfx/echo](../node-echo/README.md) | TS | Echoes events back (testing) |

## Pipeline Templates

Built-in templates available via `acpfx onboard`:

| Name | STT | TTS | Requires |
|------|-----|-----|----------|
| `deepgram` | Deepgram | Deepgram | `DEEPGRAM_API_KEY` |
| `elevenlabs` | ElevenLabs | ElevenLabs | `ELEVENLABS_API_KEY` |
| `local` | Kyutai (on-device) | Pocket TTS (CPU) | No API key |
| `local-gpu` | Kyutai (on-device) | Kyutai TTS (GPU) | No API key |

## Building from Source

```bash
cargo build --release -p acpfx-orchestrator
```

## License

ISC
