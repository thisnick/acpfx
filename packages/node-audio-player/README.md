# @acpfx/audio-player

Audio mixer with SFX support. Plays speech audio through the system speaker, with optional sound effects for agent thinking and tool use.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

## Manifest

- **Consumes:** `audio.chunk`, `agent.thinking`, `agent.tool_start`, `agent.tool_done`, `agent.delta`, `agent.complete`, `control.interrupt`
- **Emits:** `audio.chunk`, `player.status`, `lifecycle.ready`, `lifecycle.done`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `speechSource` | string | | Node name whose `audio.chunk` events are speech |
| `sampleRate` | number | `16000` | Audio sample rate in Hz |
| `thinkingClip` | string | | Path to thinking SFX audio clip |
| `toolClip` | string | | Path to tool-use SFX audio clip |
| `sfxVolume` | number | `0.3` | SFX volume multiplier (0-1) |

## Pipeline Example

```yaml
nodes:
  player:
    use: "@acpfx/audio-player"
    settings: { speechSource: tts, sampleRate: 16000 }
    outputs: [mic]  # reference audio for AEC
```

## License

ISC
