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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AnyEvent, AudioChunkEvent } from "../protocol.js";
import type { SttProvider } from "../providers/stt/types.js";

const DEFAULT_CHUNK_MS = 3000;
const FLUSH_IDLE_MS = 500; // Flush if no audio arrives for this long

export type SttOptions = {
  provider?: string;
  apiKey?: string;
  language?: string;
  chunkMs?: string;
};

export async function runStt(opts: SttOptions): Promise<void> {
  await loadEnv();

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
  const providerName = opts.provider ?? "openai";

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
    default:
      throw new Error(`Unknown STT provider: ${providerName}`);
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
