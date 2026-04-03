# @acpfx/mic-speaker

Native microphone capture with acoustic echo cancellation (AEC). Uses OS-level audio APIs via Rust for low-latency capture and speaker reference for echo cancellation.

## Install

```bash
npm install @acpfx/mic-speaker
```

The postinstall script downloads a prebuilt binary for your platform. Supported: macOS (Apple Silicon), Linux (x86_64).

## Manifest

- **Consumes:** `audio.chunk` (speaker reference for AEC), `control.interrupt`
- **Emits:** `audio.chunk`, `audio.level`, `lifecycle.ready`, `lifecycle.done`, `control.error`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `sampleRate` | number | `16000` | Target sample rate in Hz |
| `chunkMs` | number | `100` | Chunk duration in milliseconds |
| `speaker` | string | `player` | Node name whose audio to use as speaker reference for AEC |
| `debugDir` | string | | Directory to write debug WAV recordings |

## Pipeline Example

```yaml
nodes:
  mic:
    use: "@acpfx/mic-speaker"
    settings: { sampleRate: 16000, speaker: player }
    outputs: [stt]
  player:
    use: "@acpfx/audio-player"
    settings: { speechSource: tts }
    outputs: [mic]  # cycle: reference audio for AEC
```

## Building from Source

```bash
cargo build --release -p mic-speaker
```

## License

ISC
