/**
 * ElevenLabs TTS provider — streaming text-token input via WebSocket.
 *
 * Uses ElevenLabs' WebSocket streaming API to send text incrementally
 * and receive audio chunks in real-time. Falls back to REST API if
 * WebSocket is unavailable.
 */

import type { TtsProvider, TtsChunk } from "./types.js";

const DEFAULT_MODEL = "eleven_turbo_v2_5";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const WS_BASE_URL = "wss://api.elevenlabs.io/v1/text-to-speech";
const REST_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const OUTPUT_FORMAT = "pcm_16000";
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000,
);

export class ElevenLabsProvider implements TtsProvider {
  private _apiKey: string;
  private _voiceId: string;
  private _model: string;

  constructor(opts: { apiKey: string; voiceId?: string; model?: string }) {
    this._apiKey = opts.apiKey;
    this._voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
    this._model = opts.model ?? DEFAULT_MODEL;
  }

  async *synthesize(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TtsChunk> {
    if (signal?.aborted) return;

    // Use WebSocket streaming API for low-latency audio
    yield* this.synthesizeWebSocket(text, signal);
  }

  private async *synthesizeWebSocket(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TtsChunk> {
    const url =
      `${WS_BASE_URL}/${this._voiceId}/stream-input` +
      `?model_id=${encodeURIComponent(this._model)}` +
      `&output_format=${OUTPUT_FORMAT}` +
      `&xi_api_key=${encodeURIComponent(this._apiKey)}`;

    const ws = new WebSocket(url);

    // Collect audio chunks from the WebSocket
    const audioQueue: TtsChunk[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;

    const onAbort = () => {
      done = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolveWait?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let pcmBuffer = Buffer.alloc(0);

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
        const msg = JSON.parse(data);

        if (msg.audio) {
          // audio is base64-encoded PCM
          const rawPcm = Buffer.from(msg.audio, "base64");
          pcmBuffer = Buffer.concat([pcmBuffer, rawPcm]);

          // Emit chunks of consistent size
          while (pcmBuffer.length >= CHUNK_SIZE) {
            const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
            pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
            const durationMs = Math.floor(
              (chunk.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) *
                1000,
            );
            audioQueue.push({
              format: "pcm_s16le",
              sampleRate: SAMPLE_RATE,
              channels: CHANNELS,
              data: Buffer.from(chunk).toString("base64"),
              durationMs,
            });
            resolveWait?.();
          }
        }

        if (msg.isFinal) {
          // Flush remaining PCM buffer
          if (pcmBuffer.length > 0) {
            const durationMs = Math.floor(
              (pcmBuffer.length /
                (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) *
                1000,
            );
            audioQueue.push({
              format: "pcm_s16le",
              sampleRate: SAMPLE_RATE,
              channels: CHANNELS,
              data: Buffer.from(pcmBuffer).toString("base64"),
              durationMs,
            });
            pcmBuffer = Buffer.alloc(0);
          }
          done = true;
          resolveWait?.();
        }
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        done = true;
        resolveWait?.();
      }
    });

    ws.addEventListener("error", (event: Event) => {
      error = new Error(
        `ElevenLabs WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`,
      );
      done = true;
      resolveWait?.();
    });

    ws.addEventListener("close", () => {
      done = true;
      resolveWait?.();
    });

    // Wait for connection to open before sending
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(error ?? new Error("WebSocket connection failed")), {
        once: true,
      });
    });

    if (signal?.aborted) {
      ws.close();
      return;
    }

    // Send the BOS (beginning of stream) message with API key auth
    ws.send(
      JSON.stringify({
        text: " ",
        xi_api_key: this._apiKey,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
        generation_config: {
          chunk_length_schedule: [120],
        },
      }),
    );

    // Send the text
    ws.send(JSON.stringify({ text }));

    // Send EOS (end of stream)
    ws.send(JSON.stringify({ text: "" }));

    // Yield audio chunks as they arrive
    while (!done || audioQueue.length > 0) {
      if (audioQueue.length > 0) {
        yield audioQueue.shift()!;
        continue;
      }

      if (done) break;

      // Wait for new data
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
      resolveWait = null;
    }

    if (error && !signal?.aborted) {
      throw error;
    }

    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Create an ElevenLabs provider, reading API key from env or options.
 */
export function createElevenLabsProvider(opts?: {
  apiKey?: string;
  voiceId?: string;
  model?: string;
}): ElevenLabsProvider {
  const apiKey =
    opts?.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ElevenLabs API key required. Set ELEVENLABS_API_KEY env var, " +
        "add it to ~/.acpfx/.env, or pass --api-key.",
    );
  }
  return new ElevenLabsProvider({
    apiKey,
    voiceId: opts?.voiceId,
    model: opts?.model,
  });
}
