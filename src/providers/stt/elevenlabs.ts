/**
 * ElevenLabs Scribe v2 Realtime STT provider.
 *
 * Uses WebSocket streaming for low-latency (~150ms) speech-to-text.
 * Sends audio chunks incrementally, receives partial and final transcripts.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/speech-to-text/realtime
 * Auth: xi-api-key query param or in initial config message
 * Audio: pcm_16000 (16-bit signed LE, 16kHz mono)
 */

import type { SttProvider, SttResult } from "./types.js";

const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export interface ElevenLabsSttEvents {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Streaming STT provider that keeps a WebSocket open and accepts
 * audio chunks incrementally.
 */
export class ElevenLabsStreamingSttProvider {
  private _apiKey: string;
  private _language: string;
  private _ws: WebSocket | null = null;
  private _events: ElevenLabsSttEvents = {};
  private _connected = false;
  private _error: Error | null = null;

  constructor(opts: { apiKey: string; language?: string }) {
    this._apiKey = opts.apiKey;
    this._language = opts.language ?? "en";
  }

  setEvents(events: ElevenLabsSttEvents): void {
    this._events = events;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const url =
      `${WS_URL}?model_id=scribe_v2` +
      `&language_code=${encodeURIComponent(this._language)}` +
      `&sample_rate=16000` +
      `&encoding=pcm_s16le`;

    this._ws = new WebSocket(url);
    this._error = null;

    const onAbort = () => {
      this.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      this._ws!.addEventListener("open", () => {
        this._connected = true;

        // Send initial config with auth
        this._ws!.send(
          JSON.stringify({
            type: "configure",
            xi_api_key: this._apiKey,
          }),
        );

        resolve();
      }, { once: true });

      this._ws!.addEventListener("error", () => {
        reject(this._error ?? new Error("ElevenLabs STT WebSocket connection failed"));
      }, { once: true });
    });

    // Handle incoming messages
    this._ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
        const msg = JSON.parse(data);

        if (msg.type === "partial_transcript" && msg.text) {
          this._events.onPartial?.(msg.text);
        } else if (msg.type === "committed_transcript" && msg.text) {
          this._events.onFinal?.(msg.text);
        } else if (msg.type === "auth_error" || msg.type === "error") {
          this._error = new Error(
            `ElevenLabs STT error: ${msg.message ?? msg.type}`,
          );
          this._events.onError?.(this._error);
        }
      } catch (err) {
        // Ignore parse errors on non-JSON messages
      }
    });

    this._ws.addEventListener("error", (event: Event) => {
      this._error = new Error(
        `ElevenLabs STT WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`,
      );
      this._events.onError?.(this._error);
    });

    this._ws.addEventListener("close", () => {
      this._connected = false;
    });
  }

  /**
   * Send a chunk of PCM audio data to the STT service.
   * Audio should be 16-bit signed LE PCM at 16kHz mono.
   */
  sendAudio(pcmData: Buffer): void {
    if (!this._ws || !this._connected) return;

    // ElevenLabs realtime STT expects base64-encoded audio in a JSON message
    this._ws.send(
      JSON.stringify({
        type: "input_audio_chunk",
        audio: pcmData.toString("base64"),
      }),
    );
  }

  /**
   * Signal end of audio input. The service will finalize any pending transcription.
   */
  flush(): void {
    if (!this._ws || !this._connected) return;
    this._ws.send(JSON.stringify({ type: "flush" }));
  }

  close(): void {
    this._connected = false;
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._connected;
  }
}

/**
 * Batch-compatible wrapper that uses the REST API for non-streaming use.
 * Falls back to the standard /v1/speech-to-text endpoint.
 */
export class ElevenLabsBatchSttProvider implements SttProvider {
  private _apiKey: string;
  private _language: string;

  constructor(opts: { apiKey: string; language?: string }) {
    this._apiKey = opts.apiKey;
    this._language = opts.language ?? "en";
  }

  async transcribe(
    pcmData: Buffer,
    opts: { sampleRate: number; channels: number },
    signal?: AbortSignal,
  ): Promise<SttResult> {
    // Build a WAV file from PCM data
    const wavHeader = buildWavHeader(pcmData.length, opts.sampleRate, opts.channels);
    const wavData = Buffer.concat([wavHeader, pcmData]);

    // Use multipart form upload
    const boundary = `----acpfx-${Date.now()}`;
    const parts: Buffer[] = [];

    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(wavData);
    parts.push(Buffer.from("\r\n"));

    // Model part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n`,
    ));

    // Language part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\n${this._language}\r\n`,
    ));

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": this._apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs STT API error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as { text?: string };
    return { text: result.text?.trim() ?? "" };
  }
}

function buildWavHeader(dataSize: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

export function createElevenLabsSttProvider(opts?: {
  apiKey?: string;
  language?: string;
  streaming?: boolean;
}): SttProvider | ElevenLabsStreamingSttProvider {
  const apiKey = opts?.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ElevenLabs API key required. Set ELEVENLABS_API_KEY env var, " +
        "add it to ~/.acpfx/.env, or pass --api-key.",
    );
  }

  if (opts?.streaming) {
    return new ElevenLabsStreamingSttProvider({ apiKey, language: opts.language });
  }

  return new ElevenLabsBatchSttProvider({ apiKey, language: opts?.language });
}
