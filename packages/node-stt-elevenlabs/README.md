# @acpfx/stt-elevenlabs

Speech-to-text via ElevenLabs streaming API. Streams partial and delta transcriptions in real time.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

Requires an `ELEVENLABS_API_KEY` environment variable.

## Manifest

- **Consumes:** `audio.chunk`
- **Emits:** `speech.partial`, `speech.delta`, `speech.final`, `speech.pause`, `lifecycle.ready`, `lifecycle.done`, `control.error`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `language` | string | `en` | Language code |
| `apiKey` | string | | Overrides `ELEVENLABS_API_KEY` env var |
| `pauseMs` | number | | Pause duration threshold in ms |
| `vadThreshold` | number | | VAD threshold 0-1 (higher = less sensitive) |
| `minSpeechDurationMs` | number | | Minimum speech duration in ms |
| `minSilenceDurationMs` | number | | Minimum silence duration in ms |

## Pipeline Example

```yaml
nodes:
  stt:
    use: "@acpfx/stt-elevenlabs"
    settings: { language: en }
    outputs: [bridge]
env:
  ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY}
```

## External Links

- [ElevenLabs](https://elevenlabs.io) -- AI voice platform
- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference) -- API reference

## License

ISC
