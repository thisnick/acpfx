/**
 * acpfx play — Audio playback: reads audio.chunk events, plays to speaker or file.
 *
 * Providers:
 * - file: writes incoming audio to a WAV file
 * - sox: plays to default speaker via sox `play` command
 *
 * Handles control.interrupt by stopping playback immediately.
 */

import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AnyEvent, AudioChunkEvent } from "../protocol.js";
import type { AudioPlaybackProvider } from "../providers/audio/types.js";

export type PlayOptions = {
  provider?: string;
  path?: string;
};

export async function runPlay(opts: PlayOptions): Promise<void> {
  const provider = await createPlaybackProvider(opts);
  const writer = createEventWriter(process.stdout);

  await provider.start();

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "audio.chunk") {
        const e = event as AudioChunkEvent;
        const pcmData = Buffer.from(e.data, "base64");
        await provider.write(pcmData);
        return;
      }

      if (event.type === "control.interrupt") {
        // Stop playback immediately — flush buffers
        await provider.flush();
        // Forward the interrupt
        await writer.write(event);
        return;
      }

      // Forward non-audio events
      await writer.write(event);
    },
    async (error: Error, _line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "play",
      });
    },
  );

  await provider.close();
  await writer.end();
}

async function createPlaybackProvider(
  opts: PlayOptions,
): Promise<AudioPlaybackProvider> {
  const providerName = opts.provider ?? "sox";

  switch (providerName) {
    case "file": {
      if (!opts.path) {
        process.stderr.write(
          "[acpfx:play] --path is required for file provider\n",
        );
        process.exit(1);
      }
      const { FilePlaybackProvider } = await import(
        "../providers/audio/file.js"
      );
      return new FilePlaybackProvider({ path: opts.path });
    }
    case "sox": {
      const { SoxPlaybackProvider } = await import(
        "../providers/audio/sox.js"
      );
      return new SoxPlaybackProvider();
    }
    default:
      throw new Error(`Unknown play provider: ${providerName}`);
  }
}
