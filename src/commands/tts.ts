/**
 * acpfx tts — Text-to-speech: reads text.delta/text.complete events,
 * synthesizes audio via provider, and emits audio.chunk events.
 *
 * For streaming providers (ElevenLabs): sends text deltas directly to an open
 * WebSocket — no sentence buffering. Audio starts arriving before all text is in.
 *
 * For non-streaming providers (say): buffers to sentence boundaries, then synthesizes.
 *
 * Handles control.interrupt by canceling in-flight synthesis and flushing buffers.
 */

import { randomUUID } from "node:crypto";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type {
  AnyEvent,
  TextDeltaEvent,
  TextCompleteEvent,
  ControlInterruptEvent,
} from "../protocol.js";
import type { TtsProvider, StreamingTtsProvider } from "../providers/tts/types.js";
import { isStreamingProvider } from "../providers/tts/types.js";

// Sentence boundary pattern: split on .?!\n followed by whitespace or end
const SENTENCE_BOUNDARY = /(?<=[.?!\n])\s+/;

export type TtsOptions = {
  provider?: string;
  apiKey?: string;
  voiceId?: string;
  model?: string;
  voice?: string; // for macOS say
};

export async function runTts(opts: TtsOptions): Promise<void> {


  let provider: TtsProvider;
  try {
    provider = await createProvider(opts);
  } catch (err) {
    process.stderr.write(
      `[acpfx:tts] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  const writer = createEventWriter(process.stdout);

  if (isStreamingProvider(provider)) {
    await runStreamingTts(provider, writer);
  } else {
    await runBufferedTts(provider, writer);
  }

  await writer.end();
}

/**
 * Streaming path: open one WebSocket per request, send text deltas immediately.
 */
async function runStreamingTts(
  provider: StreamingTtsProvider,
  writer: { write: (event: AnyEvent) => Promise<boolean>; destroyed: boolean },
): Promise<void> {
  let streamId = randomUUID();
  let audioGen: AsyncGenerator<import("../providers/tts/types.js").TtsChunk> | null = null;
  let audioDrainPromise: Promise<void> | null = null;
  let abortCtrl: AbortController | null = null;
  let streamReady: Promise<void> | null = null;

  /** Start draining audio from the generator and writing to stdout. */
  function startAudioDrain(): void {
    if (!audioGen) return;
    const gen = audioGen;
    audioDrainPromise = (async () => {
      try {
        for await (const chunk of gen) {
          if (writer.destroyed) break;
          await writer.write({
            type: "audio.chunk",
            streamId,
            format: chunk.format,
            sampleRate: chunk.sampleRate,
            channels: chunk.channels,
            data: chunk.data,
            durationMs: chunk.durationMs,
          });
        }
      } catch (err) {
        if (abortCtrl?.signal.aborted) return;
        await writer.write({
          type: "control.error",
          message: `TTS error: ${err instanceof Error ? err.message : String(err)}`,
          source: "tts",
        });
      }
    })();
  }

  function handleInterrupt(): void {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    provider.abort();
    audioGen = null;
    audioDrainPromise = null;
    streamReady = null;
    streamId = randomUUID();
  }

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "text.delta") {
        const e = event as TextDeltaEvent;

        // Skip empty deltas — they can confuse the WebSocket API
        if (e.delta.length === 0) return;

        // On first non-empty delta of a new request, open the WebSocket and wait for it
        if (!audioGen) {
          abortCtrl = new AbortController();
          streamReady = provider.startStream(abortCtrl.signal).then((gen) => {
            audioGen = gen;
            startAudioDrain();
          });
          await streamReady;
        }

        // Send the text chunk directly — no buffering
        provider.sendText(e.delta);
        return;
      }

      if (event.type === "text.complete") {
        if (audioGen) {
          // Signal end of text input
          provider.endStream();
          // Wait for all audio to drain
          if (audioDrainPromise) {
            await audioDrainPromise;
          }
          audioGen = null;
          audioDrainPromise = null;
          abortCtrl = null;
        }
        // Forward the text.complete event
        await writer.write(event);
        return;
      }

      if (event.type === "control.interrupt") {
        handleInterrupt();
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
        source: "tts",
      });
    },
  );

  // If stream was still open when stdin ended, close it
  if (audioGen) {
    provider.endStream();
    if (audioDrainPromise) {
      await audioDrainPromise;
    }
  }
}

/**
 * Buffered path: accumulate text to sentence boundaries, then synthesize.
 * Used for non-streaming providers like macOS `say`.
 */
async function runBufferedTts(
  provider: TtsProvider,
  writer: { write: (event: AnyEvent) => Promise<boolean>; destroyed: boolean },
): Promise<void> {
  let textBuffer = "";
  let currentRequestId: string | null = null;
  let activeAbort: AbortController | null = null;
  let streamId = randomUUID();

  async function flushSentences(): Promise<void> {
    const parts = textBuffer.split(SENTENCE_BOUNDARY);
    if (parts.length <= 1) return;

    const lastPart = parts.pop()!;
    const completeSentences = parts.join(" ");
    textBuffer = lastPart;

    if (completeSentences.trim().length === 0) return;
    await synthesizeAndEmit(completeSentences);
  }

  async function flushAll(): Promise<void> {
    const text = textBuffer.trim();
    textBuffer = "";
    if (text.length === 0) return;
    await synthesizeAndEmit(text);
  }

  async function synthesizeAndEmit(text: string): Promise<void> {
    if (activeAbort?.signal.aborted) return;

    const abort = activeAbort ?? new AbortController();
    activeAbort = abort;

    try {
      for await (const chunk of provider.synthesize(text, abort.signal)) {
        if (abort.signal.aborted) break;
        await writer.write({
          type: "audio.chunk",
          streamId,
          format: chunk.format,
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
          data: chunk.data,
          durationMs: chunk.durationMs,
        });
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      await writer.write({
        type: "control.error",
        message: `TTS error: ${err instanceof Error ? err.message : String(err)}`,
        source: "tts",
      });
    }
  }

  function handleInterrupt(): void {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    textBuffer = "";
    streamId = randomUUID();
  }

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "text.delta") {
        const e = event as TextDeltaEvent;
        currentRequestId = e.requestId;
        textBuffer += e.delta;
        await flushSentences();
        return;
      }

      if (event.type === "text.complete") {
        currentRequestId = null;
        await flushAll();
        activeAbort = null;
        await writer.write(event);
        return;
      }

      if (event.type === "control.interrupt") {
        handleInterrupt();
        await writer.write(event);
        return;
      }

      await writer.write(event);
    },
    async (error: Error, _line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "tts",
      });
    },
  );
}

async function createProvider(opts: TtsOptions): Promise<TtsProvider> {
  const providerName = opts.provider ?? "elevenlabs";

  switch (providerName) {
    case "say": {
      const { SayProvider } = await import("../providers/tts/say.js");
      return new SayProvider({ voice: opts.voice });
    }
    case "elevenlabs": {
      const { createElevenLabsProvider } = await import(
        "../providers/tts/elevenlabs.js"
      );
      return createElevenLabsProvider({
        apiKey: opts.apiKey,
        voiceId: opts.voiceId,
        model: opts.model,
      });
    }
    default:
      throw new Error(`Unknown TTS provider: ${providerName}`);
  }
}

