# @acpfx/play-file

Writes received audio chunks to a WAV file. Useful for recording pipeline output during testing.

## Install

```bash
npm install @acpfx/play-file
```

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
