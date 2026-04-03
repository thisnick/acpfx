# @acpfx/stt-deepgram

Speech-to-text via Deepgram streaming API. Streams partial transcriptions in real time with configurable VAD and endpointing.

## Install

```bash
npm install @acpfx/stt-deepgram
```

Requires a `DEEPGRAM_API_KEY` environment variable.

## Manifest

- **Consumes:** `audio.chunk`
- **Emits:** `speech.partial`, `speech.final`, `speech.pause`, `lifecycle.ready`, `lifecycle.done`, `control.error`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `language` | string | `en` | Language code |
| `model` | string | `nova-3` | Deepgram model name |
| `utteranceEndMs` | number | `1000` | Silence ms before utterance end |
| `endpointing` | number | `300` | VAD endpointing threshold in ms |
| `apiKey` | string | | Overrides `DEEPGRAM_API_KEY` env var |

## Pipeline Example

```yaml
nodes:
  stt:
    use: "@acpfx/stt-deepgram"
    settings: { language: en, model: nova-3 }
    outputs: [bridge]
env:
  DEEPGRAM_API_KEY: ${DEEPGRAM_API_KEY}
```

## License

ISC
