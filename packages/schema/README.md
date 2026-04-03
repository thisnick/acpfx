# acpfx-schema

Canonical event type definitions for acpfx pipelines. This Rust crate is the single source of truth for all event types. It includes a codegen binary that generates TypeScript types, Zod schemas, and JSON Schema.

## Usage

```bash
# Generate TypeScript types and Zod schemas
cargo run -p acpfx-schema --bin acpfx-codegen
```

This produces:
- `packages/core/src/generated-types.ts`
- `packages/core/src/generated-zod.ts`
- `packages/core/src/schema.json`

Generated files are checked in. CI verifies no drift.

## Event Categories

| Category | Events |
|----------|--------|
| `audio` | `audio.chunk`, `audio.level` |
| `speech` | `speech.partial`, `speech.delta`, `speech.final`, `speech.pause` |
| `agent` | `agent.submit`, `agent.delta`, `agent.complete`, `agent.thinking`, `agent.tool_start`, `agent.tool_done` |
| `control` | `control.interrupt`, `control.state`, `control.error` |
| `lifecycle` | `lifecycle.ready`, `lifecycle.done` |
| `player` | `player.status` |
| `log` | `log` |

## License

ISC
