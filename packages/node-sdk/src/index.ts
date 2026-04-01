/**
 * Node SDK — shared helpers for acpfx TS nodes.
 *
 * Provides emit(), log(), onEvent(), and handleManifestFlag().
 * log() emits structured log events on stdout (not stderr).
 */

import { createInterface, type Interface } from "node:readline";
/**
 * Re-export handleManifestFlag from core — handles the --manifest flag.
 * If --manifest is in process.argv, prints the manifest as JSON and exits.
 */
export { handleManifestFlag } from "@acpfx/core";

const NODE_NAME = process.env.ACPFX_NODE_NAME ?? "unknown";

/** Emit an NDJSON event on stdout. */
export function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** Emit a structured log event on stdout. */
export function log(level: "info" | "warn" | "error" | "debug", message: string): void {
  emit({ type: "log", level, component: NODE_NAME, message });
}

/** Convenience: log.info / log.warn / log.error / log.debug */
log.info = (message: string): void => log("info", message);
log.warn = (message: string): void => log("warn", message);
log.error = (message: string): void => log("error", message);
log.debug = (message: string): void => log("debug", message);

export type EventHandler = (event: Record<string, unknown>) => void;

/**
 * Listen for NDJSON events on stdin. Returns the readline interface
 * for attaching close handlers.
 */
export function onEvent(handler: EventHandler): Interface {
  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handler(event);
    } catch {
      // ignore malformed JSON
    }
  });

  return rl;
}
