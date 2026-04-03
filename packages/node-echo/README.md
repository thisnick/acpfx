# @acpfx/echo

Echoes all received events back. A passthrough node useful for testing and debugging pipeline wiring.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

## Manifest

- **Consumes:** all event types
- **Emits:** all event types (mirrors input)

## Pipeline Example

```yaml
nodes:
  echo:
    use: "@acpfx/echo"
    outputs: [recorder]
```

## License

ISC
