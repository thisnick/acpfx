# @acpfx/cli

The acpfx orchestrator. A Rust binary that spawns pipeline nodes as child processes, routes NDJSON events between them according to the YAML config, and optionally displays a real-time terminal dashboard (ratatui TUI).

## Install

```bash
npm install @acpfx/cli
```

The postinstall script downloads a prebuilt binary for your platform.

## Usage

```bash
# Run a pipeline
acpfx run --config pipeline.yaml

# Run with terminal dashboard
acpfx run --config pipeline.yaml --ui

# Onboarding wizard
acpfx onboard
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--config` | `examples/pipeline/elevenlabs.yaml` | Path to pipeline YAML config |
| `--dist` | `dist` | Path to built node artifacts |
| `--ready-timeout` | `10000` | ms to wait for each node's `lifecycle.ready` |
| `--ui` | off | Enable ratatui terminal dashboard |

## Building from Source

```bash
cargo build --release -p acpfx-orchestrator
```

## License

ISC
