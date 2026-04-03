/**
 * Node SDK — shared helpers for acpfx TS nodes.
 *
 * Provides emit(), log(), onEvent(), and handleAcpfxFlags().
 * log() emits structured log events on stdout (not stderr).
 */

import { createInterface, type Interface } from "node:readline";
/**
 * Re-export handleAcpfxFlags from core — handles all --acpfx-* convention flags.
 * Call at the top of your node's entry point before any async work.
 */
export { handleAcpfxFlags, handleManifestFlag } from "@acpfx/core";

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
