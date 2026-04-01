/**
 * Echo node — trivial test node that reads NDJSON stdin and echoes each event
 * back to stdout unchanged. Emits lifecycle.ready on startup.
 */

import { emit, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

emit({ type: "lifecycle.ready", component: "echo" });

const rl = onEvent((event) => {
  // Echo back unchanged
  emit(event);
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  rl.close();
  process.exit(0);
});
