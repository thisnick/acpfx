# @acpfx/echo

Echoes all received events back. A passthrough node useful for testing and debugging pipeline wiring.

## Install

```bash
npm install @acpfx/echo
```

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
