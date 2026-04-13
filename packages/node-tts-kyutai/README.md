# @acpfx/tts-kyutai

Local text-to-speech via Kyutai moshi. Runs on-device with GPU acceleration for high-quality voice synthesis -- no API key needed.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

Uses MLX acceleration on Apple Silicon Macs for fast on-device inference.

## Manifest

- **Consumes:** `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt`
- **Emits:** `audio.chunk`, `lifecycle.ready`, `lifecycle.done`, `log`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `model` | string | `kyutai/tts-1.6b-en_fr` | HuggingFace model ID |
| `voice` | string | `expresso/ex03-ex01_calm_001_channel1_1143s.wav` | Voice name or path to `.safetensors` file |
| `device` | string | `auto` | Compute device: `auto`, `cpu`, `cuda`, or `metal` |

## Pipeline Example

```yaml
nodes:
  tts:
    use: "@acpfx/tts-kyutai"
    settings: { voice: "expresso/ex03-ex01_calm_001_channel1_1143s.wav", device: auto }
    outputs: [player]
```

## External Links

- [Kyutai](https://kyutai.org) -- Open-weight AI research lab
- [Delayed Streams Modeling](https://github.com/kyutai-labs/delayed-streams-modeling) -- Kyutai's streaming speech model architecture

## License

ISC
