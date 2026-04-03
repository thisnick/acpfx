# @acpfx/play-file

Writes received audio chunks to a WAV file. Useful for recording pipeline output during testing.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

## Manifest

- **Consumes:** `audio.chunk`, `control.interrupt`, `lifecycle.done`
- **Emits:** `lifecycle.ready`, `lifecycle.done`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `path` | string | **(required)** | Output WAV file path |

## Pipeline Example

```yaml
nodes:
  output:
    use: "@acpfx/play-file"
    settings: { path: ./output.wav }
```

## License

ISC
