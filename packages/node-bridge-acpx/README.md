# @acpfx/bridge-acpx

Agent bridge connecting speech events to Claude via ACP (Agent Control Protocol). Forwards transcribed speech to the agent and streams back responses as deltas.

## Usage

This package is a pipeline node for [@acpfx/cli](../orchestrator/README.md). See the CLI package for installation and usage.

Requires [acpx](https://github.com/anthropics/acpx) to be available (`npx acpx@latest`).

## Manifest

- **Consumes:** `speech.partial`, `speech.pause`, `control.interrupt`
- **Emits:** `agent.submit`, `agent.delta`, `agent.complete`, `agent.thinking`, `agent.tool_start`, `agent.tool_done`, `control.interrupt`, `control.error`, `lifecycle.ready`, `lifecycle.done`

## Settings

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `agent` | string | **(required)** | Agent to connect to (e.g., `claude`) |
| `session` | string | | Session type (e.g., `voice`) |
| `verbose` | boolean | | Enable verbose logging |

Additional arguments are passed through to the agent.

## Pipeline Example

```yaml
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    settings:
      agent: claude
      session: voice
      args: { approve-all: true }
    outputs: [tts, player]
```

## Credits

This node connects to Claude via [acpx](https://github.com/anthropics/acpx), an Agent Communication Protocol (ACP) CLI by Anthropic.

## License

ISC
