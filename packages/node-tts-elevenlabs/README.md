# @acpfx/tts-elevenlabs

Text-to-speech via ElevenLabs streaming API. Converts agent text deltas into audio chunks in real time.

## Install

```bash
npm install @acpfx/tts-elevenlabs
```

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

## License

ISC
