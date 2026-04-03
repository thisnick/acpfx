# @acpfx/tts-pocket

Local text-to-speech via Pocket TTS. A lightweight ~100M parameter model that runs on-device, including on CPU -- no API key needed.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

The postinstall script downloads a prebuilt binary for your platform. Supported: macOS (Apple Silicon with Metal), Linux (x86_64, optional CUDA).

## Manifest

- **Consumes:** `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt`
- **Emits:** `audio.chunk`, `lifecycle.ready`, `lifecycle.done`, `log`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `voice` | string | | Voice name or path to WAV/safetensors file for voice cloning |
| `temperature` | number | `0.7` | Generation temperature (0 = deterministic) |
| `variant` | string | `b6369a24` | Model variant/config name |

## Pipeline Example

```yaml
nodes:
  tts:
    use: "@acpfx/tts-pocket"
    settings: { temperature: 0.7 }
    outputs: [player]
```

## Building from Source

```bash
cargo build --release -p node-tts-pocket
# With Metal (macOS):
cargo build --release -p node-tts-pocket --features metal
```

## External Links

- [Pocket TTS (Kyutai)](https://github.com/kyutai-labs/pocket-tts) -- Original Pocket TTS model
- [Pocket TTS (Rust port)](https://github.com/babybirdprd/pocket-tts) -- Rust/Candle implementation used by this node

## License

ISC
