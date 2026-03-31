/**
 * Echo node — trivial test node that reads NDJSON stdin and echoes each event
 * back to stdout unchanged. Emits lifecycle.ready on startup.
 */

import { createInterface } from "node:readline";

// Emit lifecycle.ready
const ready = JSON.stringify({ type: "lifecycle.ready", component: "echo" });
process.stdout.write(ready + "\n");

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  // Echo back unchanged
  process.stdout.write(line + "\n");
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  rl.close();
  process.exit(0);
});
