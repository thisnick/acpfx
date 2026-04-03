# @acpfx/stt-kyutai

Local speech-to-text via Kyutai moshi. Runs entirely on-device using Rust and Candle -- no API key needed.

## Install

```bash
npm install @acpfx/stt-kyutai
```

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

## License

ISC
