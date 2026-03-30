/**
 * ElevenLabs TTS provider — streaming text-token input via WebSocket.
 *
 * Supports two modes:
 * 1. Batch: synthesize(text) opens a WebSocket per call (legacy, used by non-streaming callers)
 * 2. Streaming: startStream() opens one persistent WebSocket, sendText() streams tokens,
 *    endStream() closes gracefully. Audio chunks yield as they arrive from the WebSocket.
 */

import type { StreamingTtsProvider, TtsChunk } from "./types.js";

const DEFAULT_MODEL = "eleven_turbo_v2_5";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const WS_BASE_URL = "wss://api.elevenlabs.io/v1/text-to-speech";
const OUTPUT_FORMAT = "pcm_16000";
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000,
);

/** Per-stream state, scoped to one WebSocket session. */
type StreamSession = {
  ws: WebSocket;
  audioQueue: TtsChunk[];
  pcmBuffer: Buffer;
  done: boolean;
  error: Error | null;
  resolveWait: (() => void) | null;
  signal?: AbortSignal;
  abortHandler: (() => void) | null;
};

export class ElevenLabsProvider implements StreamingTtsProvider {
  readonly supportsStreaming = true as const;

  private _apiKey: string;
  private _voiceId: string;
  private _model: string;
  private _session: StreamSession | null = null;

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
    const gen = await this.startStream(signal);
    this.sendText(text);
    this.endStream();
    yield* gen;
  }

  async startStream(signal?: AbortSignal): Promise<AsyncGenerator<TtsChunk>> {
    // If there's an old session, kill it
    if (this._session) {
      this._killSession(this._session);
      this._session = null;
    }

    const session: StreamSession = {
      ws: null!,
      audioQueue: [],
      pcmBuffer: Buffer.alloc(0),
      done: false,
      error: null,
      resolveWait: null,
      signal,
      abortHandler: null,
    };

    const url =
      `${WS_BASE_URL}/${this._voiceId}/stream-input` +
      `?model_id=${encodeURIComponent(this._model)}` +
      `&output_format=${OUTPUT_FORMAT}` +
      `&xi_api_key=${encodeURIComponent(this._apiKey)}`;

    const ws = new WebSocket(url);
    session.ws = ws;
    this._session = session;

    session.abortHandler = () => {
      session.done = true;
      try { ws.close(); } catch { /* ignore */ }
      session.resolveWait?.();
    };
    signal?.addEventListener("abort", session.abortHandler, { once: true });

    // All handlers are scoped to `session` — a new stream won't be affected
    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
        const msg = JSON.parse(data);

        if (msg.audio) {
          const rawPcm = Buffer.from(msg.audio, "base64");
          session.pcmBuffer = Buffer.concat([session.pcmBuffer, rawPcm]);

          while (session.pcmBuffer.length >= CHUNK_SIZE) {
            const chunk = session.pcmBuffer.subarray(0, CHUNK_SIZE);
            session.pcmBuffer = session.pcmBuffer.subarray(CHUNK_SIZE);
            const durationMs = Math.floor(
              (chunk.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
            );
            session.audioQueue.push({
              format: "pcm_s16le",
              sampleRate: SAMPLE_RATE,
              channels: CHANNELS,
              data: Buffer.from(chunk).toString("base64"),
              durationMs,
            });
            session.resolveWait?.();
          }
        }

        if (msg.isFinal) {
          if (session.pcmBuffer.length > 0) {
            const durationMs = Math.floor(
              (session.pcmBuffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
            );
            session.audioQueue.push({
              format: "pcm_s16le",
              sampleRate: SAMPLE_RATE,
              channels: CHANNELS,
              data: Buffer.from(session.pcmBuffer).toString("base64"),
              durationMs,
            });
            session.pcmBuffer = Buffer.alloc(0);
          }
          session.done = true;
          session.resolveWait?.();
        }
      } catch (err) {
        session.error = err instanceof Error ? err : new Error(String(err));
        session.done = true;
        session.resolveWait?.();
      }
    });

    ws.addEventListener("error", (event: Event) => {
      session.error = new Error(
        `ElevenLabs WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`,
      );
      session.done = true;
      session.resolveWait?.();
    });

    ws.addEventListener("close", () => {
      session.done = true;
      session.resolveWait?.();
    });

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        () => reject(session.error ?? new Error("WebSocket connection failed")),
        { once: true },
      );
    });

    if (signal?.aborted) {
      ws.close();
      return (async function* () {})();
    }

    // Send BOS with voice settings
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

    // Return generator that drains audio from this session
    const self = this;
    return (async function* (): AsyncGenerator<TtsChunk> {
      while (!session.done || session.audioQueue.length > 0) {
        if (session.audioQueue.length > 0) {
          yield session.audioQueue.shift()!;
          continue;
        }
        if (session.done) break;

        await new Promise<void>((resolve) => {
          session.resolveWait = resolve;
        });
        session.resolveWait = null;
      }

      if (session.error && !signal?.aborted) {
        throw session.error;
      }

      self._cleanupSession(session);
    })();
  }

  sendText(chunk: string): void {
    const s = this._session;
    if (!s || s.ws.readyState !== WebSocket.OPEN) return;
    s.ws.send(JSON.stringify({ text: chunk }));
  }

  endStream(): void {
    const s = this._session;
    if (!s || s.ws.readyState !== WebSocket.OPEN) return;
    s.ws.send(JSON.stringify({ text: "" }));
  }

  abort(): void {
    if (this._session) {
      this._killSession(this._session);
      this._session = null;
    }
  }

  private _killSession(session: StreamSession): void {
    session.done = true;
    session.audioQueue = [];
    session.pcmBuffer = Buffer.alloc(0);
    try { session.ws.close(); } catch { /* ignore */ }
    session.resolveWait?.();
    this._cleanupSession(session);
  }

  private _cleanupSession(session: StreamSession): void {
    if (session.abortHandler && session.signal) {
      session.signal.removeEventListener("abort", session.abortHandler);
    }
    session.abortHandler = null;
    session.signal = undefined;
    if (this._session === session) {
      this._session = null;
    }
  }
}

export function createElevenLabsProvider(opts?: {
  apiKey?: string;
  voiceId?: string;
  model?: string;
}): ElevenLabsProvider {
  const apiKey = opts?.apiKey ?? process.env.ELEVENLABS_API_KEY;
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
