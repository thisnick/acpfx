/**
 * CLI handler for `acpfx run --config <path>`
 *
 * Loads a YAML config, starts the orchestrator, and handles SIGINT for clean shutdown.
 */

import { resolve } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { serializeEvent, type AnyEvent } from "./protocol.js";

export type RunOptions = {
  config: string;
  headless?: boolean;
};

export async function runPipeline(opts: RunOptions): Promise<void> {
  const configPath = resolve(opts.config);

  process.stderr.write(`[acpfx] Loading config: ${configPath}\n`);

  const orch = Orchestrator.fromFile(configPath, {
    onEvent: (event: AnyEvent) => {
      // Log all events to stderr in a compact format
      const { type, _from, ts, ...rest } = event;
      const elapsed = ts ? `+${ts - startTime}ms` : "";
      process.stderr.write(
        `[${_from ?? "?"}] ${elapsed} ${type} ${JSON.stringify(rest)}\n`,
      );
    },
    onError: (error: Error) => {
      process.stderr.write(`[acpfx] ERROR: ${error.message}\n`);
    },
  });

  const startTime = Date.now();

  // Handle SIGINT for clean shutdown
  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) {
      process.stderr.write("[acpfx] Force quit\n");
      process.exit(1);
    }
    stopping = true;
    process.stderr.write("\n[acpfx] Shutting down...\n");
    await orch.stop();
    process.exit(0);
  });

  try {
    process.stderr.write(`[acpfx] Starting pipeline...\n`);
    await orch.start();
    process.stderr.write(`[acpfx] All nodes ready\n`);

    // Keep running until SIGINT or all nodes exit
    await new Promise<void>(() => {
      // Intentionally never resolves — we run until SIGINT
    });
  } catch (err) {
    process.stderr.write(
      `[acpfx] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await orch.stop();
    process.exit(1);
  }
}
