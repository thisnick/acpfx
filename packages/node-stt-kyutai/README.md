# @acpfx/stt-kyutai

Local speech-to-text via Kyutai moshi. Runs entirely on-device using Rust and Candle -- no API key needed.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

The postinstall script downloads a prebuilt binary for your platform. Supported: macOS (Apple Silicon with Metal), Linux (x86_64, optional CUDA).

## Manifest

- **Consumes:** `audio.chunk`
- **Emits:** `speech.partial`, `speech.final`, `speech.pause`, `lifecycle.ready`, `lifecycle.done`, `log`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `model` | string | `kyutai/stt-1b-en_fr-candle` | HuggingFace model ID |
| `language` | string | `en` | Language code |
| `device` | string | `auto` | Compute device: `auto`, `cpu`, `cuda`, or `metal` |

## Pipeline Example

```yaml
nodes:
  mic:
    use: "@acpfx/mic-speaker"
    settings: { speaker: player }
    outputs: [stt]
  stt:
    use: "@acpfx/stt-kyutai"
    settings: { language: en, device: auto }
    outputs: [bridge]
```

## Building from Source

```bash
cargo build --release -p node-stt-kyutai
# With Metal (macOS):
cargo build --release -p node-stt-kyutai --features metal
```

## External Links

- [Kyutai](https://kyutai.org) -- Open-weight AI research lab
- [Delayed Streams Modeling](https://github.com/kyutai-labs/delayed-streams-modeling) -- Kyutai's streaming speech model architecture

## License

ISC
