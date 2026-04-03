# @acpfx/tts-deepgram

Text-to-speech via Deepgram streaming API. Converts agent text deltas into audio chunks in real time.

## Install

```bash
npm install @acpfx/tts-deepgram
```

Requires a `DEEPGRAM_API_KEY` environment variable.

## Manifest

- **Consumes:** `agent.delta`, `agent.complete`, `agent.tool_start`, `control.interrupt`
- **Emits:** `audio.chunk`, `lifecycle.ready`, `lifecycle.done`, `control.error`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `voice` | string | `aura-2-apollo-en` | Deepgram voice model name |
| `sampleRate` | number | `16000` | Audio sample rate in Hz |
| `apiKey` | string | | Overrides `DEEPGRAM_API_KEY` env var |

## Pipeline Example

```yaml
nodes:
  tts:
    use: "@acpfx/tts-deepgram"
    settings: { voice: aura-2-aries-en }
    outputs: [player]
env:
  DEEPGRAM_API_KEY: ${DEEPGRAM_API_KEY}
```

## License

ISC
