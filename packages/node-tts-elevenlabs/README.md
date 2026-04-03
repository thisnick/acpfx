# @acpfx/tts-elevenlabs

Text-to-speech via ElevenLabs streaming API. Converts agent text deltas into audio chunks in real time.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

Requires an `ELEVENLABS_API_KEY` environment variable.

## Manifest

- **Consumes:** `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt`
- **Emits:** `audio.chunk`, `lifecycle.ready`, `lifecycle.done`, `control.error`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `voiceId` | string | | ElevenLabs voice ID |
| `model` | string | | ElevenLabs model name |
| `apiKey` | string | | Overrides `ELEVENLABS_API_KEY` env var |

## Pipeline Example

```yaml
nodes:
  tts:
    use: "@acpfx/tts-elevenlabs"
    settings: { voiceId: "your-voice-id" }
    outputs: [player]
env:
  ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY}
```

## External Links

- [ElevenLabs](https://elevenlabs.io) -- AI voice platform
- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference) -- API reference

## License

ISC
