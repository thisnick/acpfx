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

  // Logging helper — suppressed when UI is active
  let hasUi = false;
  const log = (msg: string) => { if (!hasUi) process.stderr.write(`[acpfx] ${msg}\n`); };

  log(`Loading config: ${configPath}`);

  const { loadConfig } = await import("./config.js");
  const config = loadConfig(configPath);
  hasUi = Object.values(config.nodes).some(
    (n) => n.use.includes("ui-cli") || n.use.includes("ui-web"),
  );

  const orch = Orchestrator.fromFile(configPath, {
    onEvent: hasUi
      ? undefined
      : (event: AnyEvent) => {
          const { type, _from, ts } = event;
          // Skip noisy events
          if (type === "audio.chunk" || type === "audio.level") return;
          const elapsed = ts ? `+${ts - startTime}ms` : "";
          // Show relevant fields without huge data blobs
          const { _from: _f, ts: _t, type: _ty, ...rest } = event;
          delete (rest as Record<string, unknown>).data;
          process.stderr.write(
            `[${_from ?? "?"}] ${elapsed} ${type} ${JSON.stringify(rest)}\n`,
          );
        },
    onError: (error: Error) => {
      if (!hasUi) {
        process.stderr.write(`[acpfx] ERROR: ${error.message}\n`);
      }
    },
  });

  const startTime = Date.now();

  // Handle SIGINT for clean shutdown
  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) {
      log("Force quit");
      process.exit(1);
    }
    stopping = true;
    log("Shutting down...");
    await orch.stop();
    process.exit(0);
  });

  try {
    log("Starting pipeline...");
    await orch.start();
    log("All nodes ready");

    // Keep running until SIGINT or all nodes exit
    await new Promise<void>(() => {
      // Intentionally never resolves — we run until SIGINT
    });
  } catch (err) {
    log(
      `Fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    await orch.stop();
    process.exit(1);
  }
}
