# @acpfx/tts-pocket

Local text-to-speech via Pocket TTS. A lightweight ~100M parameter model that runs on-device, including on CPU -- no API key needed.

## Install

```bash
npm install @acpfx/tts-pocket
```

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

## License

ISC
