/**
 * acpfx tts — Text-to-speech: reads text.delta/text.complete events,
 * buffers to sentence boundaries, synthesizes audio via provider,
 * and emits audio.chunk events.
 *
 * Handles control.interrupt by canceling in-flight synthesis and flushing buffers.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type {
  AnyEvent,
  TextDeltaEvent,
  TextCompleteEvent,
  ControlInterruptEvent,
} from "../protocol.js";
import type { TtsProvider } from "../providers/tts/types.js";

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
  // Load .env for API keys
  await loadEnv();

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

  let textBuffer = "";
  let currentRequestId: string | null = null;
  let activeAbort: AbortController | null = null;
  let streamId = randomUUID();

  async function flushSentences(): Promise<void> {
    // Find sentence boundaries in the buffer
    const parts = textBuffer.split(SENTENCE_BOUNDARY);

    if (parts.length <= 1) {
      // No complete sentence yet — keep buffering
      return;
    }

    // Keep the last incomplete part in the buffer
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
      if (abort.signal.aborted) return; // Expected on interrupt
      await writer.write({
        type: "control.error",
        message: `TTS error: ${err instanceof Error ? err.message : String(err)}`,
        source: "tts",
      });
    }
  }

  function handleInterrupt(): void {
    // Cancel any in-flight synthesis
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    // Discard buffered text
    textBuffer = "";
    // New stream ID for next synthesis
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
        const e = event as TextCompleteEvent;
        currentRequestId = null;
        // Flush any remaining buffered text
        await flushAll();
        activeAbort = null;
        // Forward the text.complete event
        await writer.write(event);
        return;
      }

      if (event.type === "control.interrupt") {
        handleInterrupt();
        // Forward the interrupt event
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

  await writer.end();
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

async function loadEnv(): Promise<void> {
  const envPath = path.join(os.homedir(), ".acpfx", ".env");
  try {
    const content = await fs.readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional
  }
}
