# @acpfx/tts-kyutai

Local text-to-speech via Kyutai moshi. Runs on-device with GPU acceleration for high-quality voice synthesis -- no API key needed.

## Install

```bash
npm install @acpfx/tts-kyutai
```

## Manifest

- **Consumes:** `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt`
- **Emits:** `audio.chunk`, `lifecycle.ready`, `lifecycle.done`, `log`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `model` | string | `kyutai/tts-1.6b-en_fr` | HuggingFace model ID |
| `voice` | string | `expresso/ex03-ex01_happy_001_channel1_334s.wav` | Voice name or path to `.safetensors` file |
| `device` | string | `auto` | Compute device: `auto`, `cpu`, `cuda`, or `metal` |

## Pipeline Example

```yaml
nodes:
  tts:
    use: "@acpfx/tts-kyutai"
    settings: { voice: "expresso/ex03-ex01_happy_001_channel1_334s.wav", device: auto }
    outputs: [player]
```

## License

ISC
