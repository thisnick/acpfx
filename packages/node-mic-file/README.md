# @acpfx/mic-file

Plays back a WAV file as if it were microphone input. Useful for testing and development without a live microphone.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

## Manifest

- **Consumes:** `control.interrupt`
- **Emits:** `audio.chunk`, `audio.level`, `lifecycle.ready`, `lifecycle.done`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `path` | string | **(required)** | Path to WAV file to play back |
| `realtime` | boolean | | Play back at real-time speed |
| `chunkMs` | number | | Chunk duration in milliseconds |

## Pipeline Example

```yaml
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings: { path: ./test-audio.wav, realtime: true }
    outputs: [stt]
```

## License

ISC
