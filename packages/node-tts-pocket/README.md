# @acpfx/tts-pocket

Local text-to-speech via Pocket TTS. A lightweight ~100M parameter model that runs on-device, including on CPU -- no API key needed.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

The postinstall script downloads a prebuilt binary for your platform. On Linux/Windows with an NVIDIA GPU (Ampere or newer, compute capability 8.0+), a CUDA-accelerated binary is downloaded automatically. Otherwise falls back to CPU (~6x realtime on Apple Silicon).

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

## GPU Acceleration

| Platform | Acceleration | Requirement |
|----------|-------------|-------------|
| macOS | Metal | Apple Silicon (automatic) |
| Linux/Windows | CUDA | NVIDIA Ampere+ (RTX 3090, A100, etc.) |
| All | CPU | Fallback, ~6x realtime on Apple Silicon |

## Building from Source

```bash
cargo build --release -p node-tts-pocket
# With Metal (macOS):
cargo build --release -p node-tts-pocket --features metal
# With CUDA (Linux/Windows, requires CUDA toolkit):
cargo build --release -p node-tts-pocket --features cuda
```

## External Links

- [Pocket TTS (Kyutai)](https://github.com/kyutai-labs/pocket-tts) -- Original Pocket TTS model
- [Pocket TTS (Rust port)](https://github.com/babybirdprd/pocket-tts) -- Rust/Candle implementation used by this node

## License

ISC
