# acpfx — Observable Audio Pipeline Framework

## What is this?

acpfx is a pluggable, observable audio pipeline framework. Its primary use case today is voice agents (mic → STT → LLM → TTS → speaker), but the architecture is general: any graph of audio/event processing nodes connected via NDJSON stdio.

## Core Principles

### 1. No hardcoded names or architecture
- Node names in YAML configs are user-chosen. No code should reference a specific node name (e.g., don't check `_from === "bridge"`; use `process.env.ACPFX_NODE_NAME` or settings).
- The graph topology is defined entirely in YAML. The orchestrator is a dumb router — it doesn't know what nodes do, only how they're connected.
- Any node can be swapped: different STT (ElevenLabs, Deepgram, Whisper), different TTS (ElevenLabs, Deepgram, native), different agents (Claude via ACP, OpenAI direct, voice-to-voice native), different I/O (mic, WebSocket, file, Twilio).

### 2. Everything is a node
- Nodes are child processes that speak NDJSON on stdin/stdout and log to stderr.
- Nodes can be TypeScript (fork), native binaries (spawn), or npm packages (npx).
- A node's contract is declared in its `manifest.yaml` (consumes/emits lists) and enforced by the orchestrator at routing time.
- Every node must: emit `lifecycle.ready`, process declared events on stdin, emit declared events on stdout, support the `--manifest` flag.

### 3. Observable event bus
- All events flow through the orchestrator, stamped with `ts` and `_from`.
- Events are component-name-independent — nodes use `_from` for source identification, configured via settings (e.g., `speechSource: tts`), never hardcoded.
- Any node can observe the full event stream (UI, recorder, WebSocket bridge, analytics).

### 4. Input/output independence
- Input can be: local mic (sox), file playback, WebSocket stream (Twilio, browser), RTP.
- Output can be: local speaker, file recording, WebSocket stream, multiple outputs simultaneously.
- Recording, mixing, and routing are all just nodes in the graph.

### 5. Low latency end-to-end
- True streaming: STT streams partials, LLM streams tokens, TTS streams audio chunks.
- No buffering between stages — events flow as they arrive.
- Barge-in: mic is ALWAYS listening. Never mute the mic. Interrupt detection triggers immediately on first speech partial.

### 6. Pluggable via npm
- Each node is its own npm package (`@acpfx/<name>`).
- Resolution: local dist → npx fallback. `npx @acpfx/stt-deepgram` just works.
- Third-party nodes follow the same contract — publish an npm package with a `bin` entry that speaks NDJSON.

## Architecture Examples

### Simple voice agent
```
mic → stt → bridge → tts → player
```

### Voice agent with echo cancellation
```
mic → aec → stt → bridge → tts → player → aec (reference)
```

### Conference call
```
twilio-in-1 → mixer → stt → bridge → tts → twilio-out-1
twilio-in-2 → mixer                      → twilio-out-2
```

### Recording + WebSocket streaming
```
mic → stt → bridge → tts → player → recorder
                               → ws-out (browser frontend)
```

### Voice-to-voice (no STT/TTS)
```
mic → native-voice-agent → player
```

## Event Protocol

Events are JSON objects with a `type` field. The orchestrator adds `ts` (wall clock) and `_from` (source node name). Categories:

- `audio.*` — audio chunks, levels
- `speech.*` — STT partials, finals, pause detection
- `agent.*` — submit, delta, complete, thinking, tool_start, tool_done
- `control.*` — interrupt, error, state
- `lifecycle.*` — ready, done
- `player.*` — playback status

## Manifest Contract System

Every node declares its contract in `manifest.yaml` at its package root:

```yaml
name: stt-deepgram
consumes:
  - audio.chunk
emits:
  - speech.partial
  - speech.final
  - speech.pause
  - lifecycle.ready
  - lifecycle.done
  - log
  - control.error
```

**Manifest IS the contract.** The orchestrator loads manifests at startup and filters events: a node only receives events whose type is in its `consumes` list. This replaces ad-hoc event ignoring in node code.

**Manifest retrieval:** Co-located `<name>.manifest.yaml` next to the built artifact (copied by build script). Fallback: run `<node> --manifest` which prints JSON and exits. All nodes must support `--manifest`.

**Upstream dependencies are OK if declared.** A node can consume `agent.thinking` (coupling to the agent) as long as it's in the manifest. The manifest makes implicit dependencies explicit.

**Validation:** At startup the orchestrator warns on zero-overlap edges (A emits nothing B consumes). In strict mode (`strict: true` in YAML), missing manifests error.

## Event Schema and Codegen

The canonical event schema is defined in Rust (`packages/schema/`). TypeScript types are generated from it:

```
cargo run -p acpfx-schema --bin acpfx-codegen
```

This produces:
- `packages/core/src/generated-types.ts` — TypeScript discriminated unions
- `packages/core/src/generated-zod.ts` — Zod schemas for runtime validation
- `schema.json` — JSON Schema for external tooling

Generated files are checked in. CI verifies no drift.

## Control Event Routing

- **Data events** (audio, speech, agent, player, log): routed via DAG edges, filtered by destination's `consumes`.
- **`control.interrupt`**: broadcast to ALL transitive downstream nodes that declare it in `consumes`. Uses precomputed downstream sets, not just direct outputs.
- **`control.error` / `control.state`**: routed via edges like data events (informational, not action signals).
- STT nodes don't declare `consumes: control.interrupt` → they never receive it (no more ignore-interrupt hacks).

## Structured Logging

Nodes emit structured log events on stdout as part of their NDJSON stream:

```json
{"type": "log", "level": "info", "component": "stt-deepgram", "message": "Connected to Deepgram STT"}
```

Use the node-sdk helpers (`@acpfx/node-sdk`):

```typescript
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";
log.info("Connected");   // emits {"type":"log","level":"info",...} on stdout
log.error("Failed");     // same, with level "error"
```

**stderr is a true error channel** — only for unexpected crashes/panics. The orchestrator does not parse or convert stderr lines.

## Orchestrator

The orchestrator is a Rust binary at `packages/orchestrator/`. Run with:

```
cargo run -p acpfx-orchestrator --release -- run --config acpfx.yaml
```

Or via `pnpm start --config acpfx.yaml`.

The `--ui` flag enables a ratatui terminal dashboard that renders each node in its own bordered box with category-based widgets driven by manifests. No separate UI node needed in YAML configs.

## Things to avoid

- **Never mute the mic** — barge-in requires always-on listening.
- **Never hardcode node names** — use `ACPFX_NODE_NAME` env var or settings for self-identification, settings for source filtering.
- **Never assume a specific graph topology** — nodes should work in any valid wiring.
- **Don't buffer when you can stream** — latency is critical for voice.
- **Don't put business logic in the orchestrator** — it's a dumb event router.

## Future directions

- **Plugin system**: nodes as npm packages with a registry/discovery mechanism.
- **Web UI**: WebSocket bridge node → browser frontend (replace or complement CLI UI).
- **Native UI**: desktop app wrapping the pipeline.
- **Twilio/WebRTC I/O**: phone call and browser-based voice input/output.
- **Voice-to-voice**: native multimodal models that skip STT/TTS entirely.
- **Example configs**: move YAML configs to `examples/` directory, keep root clean.
