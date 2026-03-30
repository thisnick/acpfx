/**
 * acpfx tap — Debug inspector that logs all events to stderr while passing them through.
 */

import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AnyEvent } from "../protocol.js";

export async function runTap(opts: { json?: boolean }): Promise<void> {
  const writer = createEventWriter(process.stdout);
  const useJson = opts.json ?? false;

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      // Log to stderr
      if (useJson) {
        process.stderr.write(JSON.stringify(event) + "\n");
      } else {
        const ts = new Date().toISOString().slice(11, 23);
        process.stderr.write(`[${ts}] ${formatEvent(event)}\n`);
      }

      // Pass through to stdout
      await writer.write(event);
    },
    (error: Error, line: string) => {
      process.stderr.write(`[tap:error] ${error.message} — line: ${line}\n`);
      // Forward invalid lines as control.error events
      writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "tap",
      });
    },
  );

  await writer.end();
}

function formatEvent(event: AnyEvent): string {
  const { type, ...rest } = event;
  const summary = summarize(rest);
  return `${type}${summary ? "  " + summary : ""}`;
}

function summarize(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "data" && typeof value === "string" && value.length > 40) {
      parts.push(`data=[${value.length} chars]`);
    } else if (typeof value === "string") {
      const display = value.length > 60 ? value.slice(0, 57) + "..." : value;
      parts.push(`${key}="${display}"`);
    } else if (typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}
