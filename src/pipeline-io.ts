/**
 * NDJSON reader/writer with backpressure support.
 *
 * Reads newline-delimited JSON from a Readable stream and emits parsed events.
 * Writes serialized events to a Writable stream, respecting backpressure.
 */

import { type Readable, type Writable } from "node:stream";
import { type AnyEvent, parseEvent, serializeEvent } from "./protocol.js";

export type EventHandler = (event: AnyEvent) => void | Promise<void>;
export type ErrorHandler = (error: Error, line: string) => void | Promise<void>;

/**
 * Reads NDJSON lines from a readable stream, parsing each as a pipeline event.
 * Calls `onEvent` for each parsed event, `onError` for malformed lines.
 * Awaits async handlers and pauses the input stream during processing.
 * Returns a promise that resolves when the stream ends and all handlers complete.
 */
export function readEvents(
  input: Readable,
  onEvent: EventHandler,
  onError?: ErrorHandler,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let processing = false;
    let ended = false;

    async function processLines(): Promise<void> {
      if (processing) return;
      processing = true;
      input.pause();

      try {
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length === 0) continue;

          try {
            const event = parseEvent(line);
            await onEvent(event);
          } catch (err) {
            if (onError) {
              await onError(
                err instanceof Error ? err : new Error(String(err)),
                line,
              );
            }
          }
        }

        if (ended) {
          // Process any remaining data without a trailing newline
          const line = buffer.trim();
          buffer = "";
          if (line.length > 0) {
            try {
              const event = parseEvent(line);
              await onEvent(event);
            } catch (err) {
              if (onError) {
                await onError(
                  err instanceof Error ? err : new Error(String(err)),
                  line,
                );
              }
            }
          }
          resolve();
        } else {
          input.resume();
        }
      } catch (err) {
        reject(err);
      } finally {
        processing = false;
      }
    }

    input.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      processLines();
    });

    input.on("end", () => {
      ended = true;
      processLines();
    });

    input.on("error", reject);
  });
}

/**
 * Creates a writer that serializes events as NDJSON to a writable stream.
 * Respects backpressure: if the stream is full, waits for drain before continuing.
 */
export function createEventWriter(output: Writable): {
  write: (event: AnyEvent) => Promise<boolean>;
  end: () => Promise<void>;
  destroyed: boolean;
} {
  let destroyed = false;

  output.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      destroyed = true;
      return; // Suppress — downstream closed the pipe
    }
    throw err;
  });

  function write(event: AnyEvent): Promise<boolean> {
    if (destroyed) return Promise.resolve(false);
    const line = serializeEvent(event) + "\n";
    try {
      const ok = output.write(line);
      if (ok) return Promise.resolve(true);
      return new Promise((resolve) => {
        output.once("drain", () => resolve(!destroyed));
      });
    } catch {
      destroyed = true;
      return Promise.resolve(false);
    }
  }

  function end(): Promise<void> {
    if (destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      output.end(() => resolve());
    });
  }

  return {
    write,
    end,
    get destroyed() {
      return destroyed;
    },
  };
}
