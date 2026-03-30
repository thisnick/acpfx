/**
 * acpfx mic — Audio capture: reads from microphone or file, emits audio.chunk events.
 *
 * Providers:
 * - file: reads a WAV file, emits chunks paced at real-time rate
 * - sox: captures from default microphone via sox `rec` command
 */

import { randomUUID } from "node:crypto";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AudioCaptureProvider } from "../providers/audio/types.js";

export type MicOptions = {
  provider?: string;
  path?: string;
  chunkMs?: string;
  noPace?: boolean;
};

export async function runMic(opts: MicOptions): Promise<void> {
  const provider = await createCaptureProvider(opts);
  const writer = createEventWriter(process.stdout);
  const streamId = randomUUID();
  const abort = new AbortController();

  // Handle SIGINT/SIGTERM for clean shutdown
  const onSignal = () => {
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // If stdin has data, read control events (e.g., for future echo cancellation)
  if (!process.stdin.isTTY) {
    // Non-blocking: read control events from stdin if piped
    readEvents(
      process.stdin,
      async (event) => {
        // Forward control events; future: handle control.state for muting
        if (event.type === "control.interrupt" || event.type === "control.state") {
          // Could use these to mute mic during playback
        }
      },
    ).catch(() => {
      // Stdin closed — that's fine
    });
  }

  try {
    for await (const chunk of provider.capture(abort.signal)) {
      if (abort.signal.aborted) break;

      await writer.write({
        type: "audio.chunk",
        streamId,
        format: provider.format.format,
        sampleRate: provider.format.sampleRate,
        channels: provider.format.channels,
        data: chunk.data.toString("base64"),
        durationMs: chunk.durationMs,
      });
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      await writer.write({
        type: "control.error",
        message: `Mic error: ${err instanceof Error ? err.message : String(err)}`,
        source: "mic",
      });
    }
  }

  await writer.end();

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}

async function createCaptureProvider(
  opts: MicOptions,
): Promise<AudioCaptureProvider> {
  const providerName = opts.provider ?? "sox";

  switch (providerName) {
    case "file": {
      if (!opts.path) {
        process.stderr.write(
          "[acpfx:mic] --path is required for file provider\n",
        );
        process.exit(1);
      }
      const { FileCaptureProvider } = await import(
        "../providers/audio/file.js"
      );
      return new FileCaptureProvider({
        path: opts.path,
        chunkMs: opts.chunkMs ? parseInt(opts.chunkMs, 10) : undefined,
        realtime: !opts.noPace,
      });
    }
    case "sox": {
      const { SoxCaptureProvider } = await import(
        "../providers/audio/sox.js"
      );
      return new SoxCaptureProvider();
    }
    default:
      throw new Error(`Unknown mic provider: ${providerName}`);
  }
}
