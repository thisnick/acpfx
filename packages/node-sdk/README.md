# @acpfx/node-sdk

SDK for authoring acpfx pipeline nodes. Provides the standard primitives for emitting events, logging, and handling the NDJSON stdio protocol.

## Install

```bash
npm install @acpfx/node-sdk
```

## API

- **`emit(event)`** -- Send an event to stdout (NDJSON)
- **`log.info(msg)` / `log.warn(msg)` / `log.error(msg)`** -- Structured logging via `log` events
- **`onEvent(callback)`** -- Register a handler for incoming events on stdin
- **`handleManifestFlag()`** -- Handle `--manifest` CLI flag (prints manifest JSON and exits)

## Usage

```typescript
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

onEvent((event) => {
  if (event.type === "audio.chunk") {
    // process audio...
  }
});

emit({ type: "lifecycle.ready" });
```

## License

ISC
