/**
 * ElevenLabs Scribe v2 Realtime STT provider.
 *
 * Uses WebSocket streaming for low-latency speech-to-text.
 * Sends audio chunks as JSON with base64-encoded audio,
 * receives partial and committed transcripts.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/speech-to-text/realtime
 * Auth: xi-api-key header
 * Audio: JSON { message_type: "input_audio_chunk", audio_base_64: "<b64>", commit: false }
 */

import type { SttProvider, SttResult } from "./types.js";

const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL = "scribe_v2_realtime";

export interface ElevenLabsSttEvents {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Streaming STT provider that keeps a WebSocket open and accepts
 * audio chunks incrementally. Sends JSON messages with base64 audio.
 */
export class ElevenLabsStreamingSttProvider {
  private _apiKey: string;
  private _language: string;
  private _ws: WebSocket | null = null;
  private _events: ElevenLabsSttEvents = {};
  private _connected = false;

  constructor(opts: { apiKey: string; language?: string }) {
    this._apiKey = opts.apiKey;
    this._language = opts.language ?? "en";
  }

  setEvents(events: ElevenLabsSttEvents): void {
    this._events = events;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const url =
      `${WS_URL}?model_id=${DEFAULT_MODEL}` +
      `&language_code=${encodeURIComponent(this._language)}` +
      `&sample_rate=16000` +
      `&encoding=pcm_s16le`;

    // Node.js 22+ WebSocket supports headers via options object
    this._ws = new WebSocket(url, {
      headers: { "xi-api-key": this._apiKey },
    } as unknown as string[]);

    const onAbort = () => {
      this.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    await new Promise<void>((resolve, reject) => {
      this._ws!.addEventListener("open", () => {
        this._connected = true;
        resolve();
      }, { once: true });

      this._ws!.addEventListener("error", () => {
        reject(new Error("ElevenLabs STT WebSocket connection failed"));
      }, { once: true });
    });

    this._ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
        const msg = JSON.parse(data);

        if (msg.message_type === "partial_transcript" && msg.text) {
          this._events.onPartial?.(msg.text);
        } else if (
          (msg.message_type === "committed_transcript" ||
            msg.message_type === "committed_transcript_with_timestamps") &&
          msg.text
        ) {
          this._events.onFinal?.(msg.text);
        } else if (
          msg.message_type === "auth_error" ||
          msg.message_type === "error"
        ) {
          this._events.onError?.(
            new Error(`ElevenLabs STT: ${msg.message ?? msg.error ?? msg.message_type}`),
          );
        }
      } catch {
        // Ignore parse errors
      }
    });

    this._ws.addEventListener("error", (event: Event) => {
      this._events.onError?.(
        new Error(`ElevenLabs STT WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`),
      );
    });

    this._ws.addEventListener("close", () => {
      this._connected = false;
    });
  }

  /**
   * Send a chunk of PCM audio data. Audio should be 16-bit signed LE at 16kHz mono.
   * Sent as JSON with base64-encoded audio (not binary frames).
   */
  sendAudio(pcmData: Buffer): void {
    if (!this._ws || !this._connected) return;

    this._ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcmData.toString("base64"),
        commit: false,
        sample_rate: 16000,
      }),
    );
  }

  /**
   * Commit current audio buffer — triggers final transcript for accumulated audio.
   */
  commit(): void {
    if (!this._ws || !this._connected) return;
    this._ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: 16000,
      }),
    );
  }

  /**
   * Signal end of audio and commit any pending transcription.
   */
  flush(): void {
    this.commit();
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
 * Batch-compatible wrapper using the REST API.
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
    const wavHeader = buildWavHeader(pcmData.length, opts.sampleRate, opts.channels);
    const wavData = Buffer.concat([wavHeader, pcmData]);

    const boundary = `----acpfx-${Date.now()}`;
    const parts: Buffer[] = [];

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(wavData);
    parts.push(Buffer.from("\r\n"));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n`,
    ));

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
  header.writeUInt16LE(1, 20);
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
        "add it to .env in the project root, or pass --api-key.",
    );
  }

  if (opts?.streaming) {
    return new ElevenLabsStreamingSttProvider({ apiKey, language: opts.language });
  }

  return new ElevenLabsBatchSttProvider({ apiKey, language: opts?.language });
}
