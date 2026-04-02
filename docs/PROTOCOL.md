# acpfx Event Protocol

This document describes the NDJSON event protocol used by acpfx nodes and the orchestrator. The canonical source of truth is the Rust schema crate at `packages/schema/`.

## Wire Format

Events are newline-delimited JSON (NDJSON). Each event is a single JSON object with a `type` field that identifies the event kind.

**Node-emitted event:**
```json
{"type":"speech.final","trackId":"mic-0","text":"hello world","confidence":0.95}
```

**After orchestrator stamping:**
```json
{"type":"speech.final","trackId":"mic-0","text":"hello world","confidence":0.95,"ts":1711929600000,"_from":"stt"}
```

The orchestrator adds two fields to every routed event:
- `ts` -- wall-clock milliseconds since Unix epoch
- `_from` -- the name of the source node (as declared in the YAML config)

All field names use camelCase on the wire (e.g., `trackId`, `requestId`, `durationMs`, `sampleRate`).

## Event Categories

There are 7 categories and 19 event types total.

### audio (2 types)

Audio data flowing through the pipeline.

**`audio.chunk`** -- PCM audio data

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `format` | string | PCM format (e.g., `s16le`) |
| `sampleRate` | u32 | Sample rate in Hz |
| `channels` | u16 | Number of audio channels |
| `data` | string | Base64-encoded PCM data |
| `durationMs` | u32 | Duration of this chunk in ms |
| `kind` | string? | `"speech"` or `"sfx"` (optional) |

**`audio.level`** -- Real-time audio level metrics

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `rms` | f64 | RMS amplitude |
| `peak` | f64 | Peak amplitude |
| `dbfs` | f64 | Level in dBFS |

### speech (4 types)

Speech recognition results from STT nodes.

**`speech.partial`** -- In-progress recognition result

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `text` | string | Current partial transcript |

**`speech.delta`** -- Incremental speech update (replaces previous partial)

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `text` | string | New text |
| `replaces` | string? | Text being replaced (optional) |

**`speech.final`** -- Finalized recognition result

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `text` | string | Final transcript |
| `confidence` | f64? | Recognition confidence 0-1 (optional) |

**`speech.pause`** -- Silence detected after speech

| Field | Type | Description |
|-------|------|-------------|
| `trackId` | string | Audio track identifier |
| `pendingText` | string | Accumulated text before pause |
| `silenceMs` | u32 | Duration of silence in ms |

### agent (6 types)

LLM/agent interaction events.

**`agent.submit`** -- Text submitted to the agent

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Unique request identifier |
| `text` | string | Submitted prompt text |

**`agent.delta`** -- Incremental response token

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Request identifier |
| `delta` | string | New text fragment |
| `seq` | u64 | Sequence number |

**`agent.complete`** -- Agent response finished

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Request identifier |
| `text` | string | Full response text |
| `tokenUsage` | object? | `{input: u64, output: u64}` (optional) |

**`agent.thinking`** -- Agent is processing (before first token)

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Request identifier |

**`agent.tool_start`** -- Agent started a tool call

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Request identifier |
| `toolCallId` | string | Tool call identifier |
| `title` | string? | Human-readable tool name (optional) |

**`agent.tool_done`** -- Tool call completed

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Request identifier |
| `toolCallId` | string | Tool call identifier |
| `status` | string | Result status (e.g., `"completed"`, `"failed"`) |

### control (3 types)

Control signals for pipeline coordination.

**`control.interrupt`** -- Stop current processing (barge-in, cancellation)

| Field | Type | Description |
|-------|------|-------------|
| `reason` | string | Why the interrupt was triggered |

**`control.state`** -- Node state change notification

| Field | Type | Description |
|-------|------|-------------|
| `component` | string | Node component name |
| `state` | string | New state |

**`control.error`** -- Error report from a node

| Field | Type | Description |
|-------|------|-------------|
| `component` | string | Node component name |
| `message` | string | Error description |
| `fatal` | bool | Whether the error is unrecoverable |

### lifecycle (2 types)

Node startup and shutdown signals.

**`lifecycle.ready`** -- Node is initialized and ready to process events

| Field | Type | Description |
|-------|------|-------------|
| `component` | string | Node component name |

**`lifecycle.done`** -- Node is shutting down

| Field | Type | Description |
|-------|------|-------------|
| `component` | string | Node component name |

### log (1 type)

**`log`** -- Structured log event

| Field | Type | Description |
|-------|------|-------------|
| `level` | string | `"info"`, `"warn"`, `"error"`, or `"debug"` |
| `component` | string | Source component name |
| `message` | string | Log message |

### player (1 type)

**`player.status`** -- Playback status update

| Field | Type | Description |
|-------|------|-------------|
| `playing` | any | What is currently playing (string or false/null) |
| `agentState` | any | Agent state as seen by the player |
| `sfxActive` | bool | Whether SFX is currently active |

## Routing Rules

### Edge routing (default)

Events emitted by a node are sent to its configured `outputs` list. Before delivery, the orchestrator checks the destination node's manifest `consumes` list -- if the event type is not listed, the event is dropped. An empty `consumes` list means the node accepts all events (permissive mode).

### Interrupt broadcast

`control.interrupt` is special: instead of following only direct output edges, it propagates to **all transitive downstream nodes** that declare `control.interrupt` in their `consumes`. The orchestrator precomputes downstream sets at startup using DFS traversal.

This means a bridge node emitting `control.interrupt` will reach the TTS and player nodes even if they are multiple hops away, as long as they declare `consumes: [control.interrupt]`. STT nodes that omit `control.interrupt` from their manifest never receive it.

### Log broadcast

`log` events are broadcast beyond direct outputs: they are sent to all nodes that declare `log` in their `consumes`, regardless of edge connectivity.

## Manifest Contract System

Every node declares its event contract in `manifest.yaml`:

```yaml
name: tts-deepgram
description: Text-to-speech via Deepgram streaming API
consumes:
  - agent.delta
  - agent.complete
  - agent.tool_start
  - control.interrupt
emits:
  - audio.chunk
  - lifecycle.ready
  - lifecycle.done
  - control.error
```

**Key behaviors:**
- The orchestrator loads manifests from co-located files (`<node>.manifest.yaml` or `.manifest.json`) next to the built artifact.
- If no manifest is found, the node runs in permissive mode (accepts all events) with a warning.
- At startup, the orchestrator warns on zero-overlap edges (source emits nothing the destination consumes).
- Manifests make implicit coupling explicit: if a player node needs `agent.thinking` events, it declares that in `consumes`.

## Schema and Codegen

The Rust crate `packages/schema/` defines all event types as Rust structs with serde + schemars derives. The codegen binary produces TypeScript types and Zod schemas:

```bash
cargo run -p acpfx-schema --bin acpfx-codegen
```

Output files (checked in, CI verifies no drift):
- `packages/core/src/generated-types.ts` -- TypeScript discriminated unions
- `packages/core/src/generated-zod.ts` -- Zod schemas for runtime validation
- `schema.json` -- JSON Schema for external tooling

## Node SDK

TypeScript nodes use `@acpfx/node-sdk`:

```typescript
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();  // handle --manifest flag, exit if present

onEvent((event) => {
  // process incoming events
});

emit({ type: "lifecycle.ready", component: "my-node" });
log.info("Connected to upstream service");
```

- `emit(event)` -- write NDJSON to stdout
- `log.info/warn/error/debug(message)` -- emit structured `log` event on stdout
- `onEvent(handler)` -- listen for NDJSON events on stdin
- `handleManifestFlag()` -- if `--manifest` in argv, print manifest JSON and exit

**stderr is reserved for unexpected crashes/panics.** All normal logging goes through `log.*` on stdout.
