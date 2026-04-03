# @acpfx/recorder

Records all pipeline events to JSONL and audio tracks to WAV files. Observes the full event stream for debugging and analysis.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

## Manifest

- **Consumes:** all event types
- **Emits:** `lifecycle.ready`, `lifecycle.done`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `outputDir` | string | `./recordings` | Directory to write recordings to |

## Pipeline Example

```yaml
nodes:
  recorder:
    use: "@acpfx/recorder"
    settings: { outputDir: ./recordings }
```

Wire the recorder as an output of any node whose events you want to capture.

## License

ISC
