# @acpfx/stt-kyutai

Local speech-to-text via Kyutai moshi. Runs entirely on-device -- no API key needed. Uses MLX on macOS (Apple Silicon) and PyTorch on Linux/Windows (CUDA when available).

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

Requires [uv](https://docs.astral.sh/uv/) for Python dependency management. GPU acceleration is auto-detected at runtime.

## Manifest

- **Consumes:** `audio.chunk`
- **Emits:** `speech.partial`, `speech.final`, `speech.pause`, `lifecycle.ready`, `lifecycle.done`, `log`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `model` | string | `kyutai/stt-1b-en_fr` | HuggingFace model ID |
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

## GPU Acceleration

| Platform | Acceleration | How |
|----------|-------------|-----|
| macOS | MLX (Apple Silicon) | Automatic, with int8 quantization |
| Linux/Windows | CUDA (PyTorch) | Automatic when NVIDIA GPU detected |
| All | CPU | Fallback, works everywhere |

## External Links

- [Kyutai](https://kyutai.org) -- Open-weight AI research lab
- [Delayed Streams Modeling](https://github.com/kyutai-labs/delayed-streams-modeling) -- Kyutai's streaming speech model architecture

## License

ISC
