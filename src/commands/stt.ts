/**
 * acpfx stt — Speech-to-text: reads audio.chunk events, accumulates audio,
 * and sends to STT provider for transcription. Emits speech.partial and
 * speech.final events.
 *
 * Accumulates audio chunks and sends to the STT API when enough audio has
 * been collected (configurable via --chunk-ms, default 3000ms). Also flushes
 * when the audio stream ends (no more audio.chunk events arriving).
 */

import { randomUUID } from "node:crypto";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AnyEvent, AudioChunkEvent } from "../protocol.js";
import type { SttProvider } from "../providers/stt/types.js";
import type { ElevenLabsStreamingSttProvider } from "../providers/stt/elevenlabs.js";

const DEFAULT_CHUNK_MS = 3000;
const FLUSH_IDLE_MS = 500; // Flush if no audio arrives for this long

export type SttOptions = {
  provider?: string;
  apiKey?: string;
  language?: string;
  chunkMs?: string;
};

export async function runStt(opts: SttOptions): Promise<void> {

  const providerName = opts.provider ?? "elevenlabs";

  // Use streaming path for ElevenLabs
  if (providerName === "elevenlabs") {
    return runSttStreaming(opts);
  }

  // Batch path for other providers (openai, etc.)
  return runSttBatch(opts);
}

/**
 * Streaming STT: sends audio chunks in real-time via WebSocket,
 * receives partial/final transcripts immediately.
 * Much lower latency than batch (~150ms vs ~3000ms).
 */
async function runSttStreaming(opts: SttOptions): Promise<void> {
  const { ElevenLabsStreamingSttProvider } = await import(
    "../providers/stt/elevenlabs.js"
  );
  const { createElevenLabsSttProvider } = await import(
    "../providers/stt/elevenlabs.js"
  );

  let streamingProvider: InstanceType<typeof ElevenLabsStreamingSttProvider>;
  try {
    const p = createElevenLabsSttProvider({
      apiKey: opts.apiKey,
      language: opts.language,
      streaming: true,
    });
    streamingProvider = p as InstanceType<typeof ElevenLabsStreamingSttProvider>;
  } catch (err) {
    process.stderr.write(
      `[acpfx:stt] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const writer = createEventWriter(process.stdout);
  const streamId = randomUUID();

  // Wire up transcript events
  streamingProvider.setEvents({
    onPartial: (text: string) => {
      writer.write({
        type: "speech.partial",
        streamId,
        text,
      });
    },
    onFinal: (text: string) => {
      if (text.trim().length > 0) {
        writer.write({
          type: "speech.final",
          streamId,
          text: text.trim(),
        });
      }
    },
    onError: (error: Error) => {
      writer.write({
        type: "control.error",
        message: `STT error: ${error.message}`,
        source: "stt",
      });
    },
  });

  // Connect WebSocket
  try {
    await streamingProvider.connect();
  } catch (err) {
    process.stderr.write(
      `[acpfx:stt] Failed to connect: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "audio.chunk") {
        const e = event as AudioChunkEvent;
        const pcm = Buffer.from(e.data, "base64");
        streamingProvider.sendAudio(pcm);

        // Forward audio.chunk for downstream consumers (VAD)
        await writer.write(event);
        return;
      }

      // Forward unknown events unchanged
      await writer.write(event);
    },
    async (error: Error, _line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "stt",
      });
    },
  );

  // Flush and close
  streamingProvider.flush();
  // Give a moment for final transcripts to arrive
  await new Promise((resolve) => setTimeout(resolve, 500));
  streamingProvider.close();

  await writer.end();
}

/**
 * Batch STT: buffers audio chunks, sends to API in segments.
 * Higher latency but works with any provider (OpenAI Whisper, etc.).
 */
async function runSttBatch(opts: SttOptions): Promise<void> {
  let provider: SttProvider;
  try {
    provider = await createProvider(opts);
  } catch (err) {
    process.stderr.write(
      `[acpfx:stt] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const writer = createEventWriter(process.stdout);
  const chunkMs = parseInt(opts.chunkMs ?? String(DEFAULT_CHUNK_MS), 10);

  const streamId = randomUUID();
  let pcmBuffers: Buffer[] = [];
  let accumulatedMs = 0;
  let sampleRate = 16000;
  let channels = 1;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let transcribing = false;

  async function flushAudio(): Promise<void> {
    if (pcmBuffers.length === 0 || transcribing) return;

    const pcmData = Buffer.concat(pcmBuffers);
    pcmBuffers = [];
    const durationMs = accumulatedMs;
    accumulatedMs = 0;

    if (pcmData.length === 0) return;

    transcribing = true;
    try {
      const result = await provider.transcribe(pcmData, {
        sampleRate,
        channels,
      });

      if (result.text.length > 0) {
        await writer.write({
          type: "speech.final",
          streamId,
          text: result.text,
        });
      }
    } catch (err) {
      await writer.write({
        type: "control.error",
        message: `STT error: ${err instanceof Error ? err.message : String(err)}`,
        source: "stt",
      });
    } finally {
      transcribing = false;
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushAudio();
    }, FLUSH_IDLE_MS);
  }

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "audio.chunk") {
        const e = event as AudioChunkEvent;

        // Decode base64 PCM data
        const pcm = Buffer.from(e.data, "base64");
        pcmBuffers.push(pcm);
        accumulatedMs += e.durationMs;
        sampleRate = e.sampleRate;
        channels = e.channels;

        // Also forward the audio.chunk for downstream consumers (e.g., VAD)
        await writer.write(event);

        // Flush when we have enough audio
        if (accumulatedMs >= chunkMs) {
          if (flushTimer) clearTimeout(flushTimer);
          await flushAudio();
        } else {
          scheduleFlush();
        }
        return;
      }

      // Forward unknown events unchanged
      await writer.write(event);
    },
    async (error: Error, _line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "stt",
      });
    },
  );

  // Flush any remaining audio
  if (flushTimer) clearTimeout(flushTimer);
  await flushAudio();

  await writer.end();
}

async function createProvider(opts: SttOptions): Promise<SttProvider> {
  const providerName = opts.provider ?? "elevenlabs";

  switch (providerName) {
    case "openai": {
      const { createOpenAiSttProvider } = await import(
        "../providers/stt/openai.js"
      );
      return createOpenAiSttProvider({
        apiKey: opts.apiKey,
        language: opts.language,
      });
    }
    case "elevenlabs": {
      const { ElevenLabsBatchSttProvider } = await import(
        "../providers/stt/elevenlabs.js"
      );
      const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ElevenLabs API key required. Set ELEVENLABS_API_KEY env var, " +
            "add it to .env in the project root, or pass --api-key.",
        );
      }
      return new ElevenLabsBatchSttProvider({ apiKey, language: opts.language });
    }
    default:
      throw new Error(`Unknown STT provider: ${providerName}`);
  }
}
