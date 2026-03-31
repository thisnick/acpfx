/**
 * ui-cli node entry point — reads NDJSON events from stdin,
 * renders the Ink dashboard, emits lifecycle.ready.
 *
 * This is the file that gets spawned as a child process by the orchestrator.
 * It imports the Dashboard component from ui-cli.tsx and feeds events to it.
 */

import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline";
import { Dashboard } from "./ui-cli-components.js";

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// Create an async iterable from stdin NDJSON
function createEventStream(): AsyncIterable<Record<string, unknown>> {
  const rl = createInterface({ input: process.stdin });
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      queue.push(event);
      resolve?.();
    } catch {
      // ignore
    }
  });

  rl.on("close", () => {
    done = true;
    resolve?.();
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          while (queue.length === 0 && !done) {
            await new Promise<void>((r) => {
              resolve = r;
            });
            resolve = null;
          }
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

// Emit lifecycle.ready
emit({ type: "lifecycle.ready", component: "ui-cli" });

const eventStream = createEventStream();

// Render the dashboard — Ink takes over the terminal
render(React.createElement(Dashboard, { eventStream }));

process.on("SIGTERM", () => {
  process.exit(0);
});
