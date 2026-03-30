/**
 * OpenAI Whisper STT provider.
 *
 * Sends PCM audio (converted to WAV on the fly) to OpenAI's
 * audio/transcriptions endpoint using the whisper-1 model.
 */

import type { SttProvider, SttResult } from "./types.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "whisper-1";
const TIMEOUT_MS = 30_000;

export class OpenAiSttProvider implements SttProvider {
  private _apiKey: string;
  private _language: string | undefined;

  constructor(opts: { apiKey: string; language?: string }) {
    this._apiKey = opts.apiKey;
    this._language = opts.language;
  }

  async transcribe(
    pcmData: Buffer,
    opts: { sampleRate: number; channels: number },
    signal?: AbortSignal,
  ): Promise<SttResult> {
    // Wrap PCM in a WAV container for the API
    const wavData = pcmToWav(pcmData, opts.sampleRate, opts.channels);

    // Build multipart form data manually (no external deps)
    const boundary = `----acpfx${Date.now()}${Math.random().toString(36).slice(2)}`;
    const formParts: Buffer[] = [];

    // file field
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
    );
    formParts.push(wavData);
    formParts.push(Buffer.from("\r\n"));

    // model field
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${MODEL}\r\n`,
      ),
    );

    // language field (optional)
    if (this._language) {
      formParts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this._language}\r\n`,
        ),
      );
    }

    // response_format
    formParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
      ),
    );

    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    const response = await fetch(TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `OpenAI Whisper API error ${response.status}: ${errorText || response.statusText}`,
      );
    }

    const result = (await response.json()) as { text?: string };
    return { text: result.text?.trim() ?? "" };
  }
}

/**
 * Wrap raw PCM data in a WAV container.
 * Assumes 16-bit signed LE PCM.
 */
function pcmToWav(
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const header = Buffer.alloc(headerSize);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset);
  offset += 4;
  header.writeUInt32LE(fileSize - 8, offset);
  offset += 4;
  header.write("WAVE", offset);
  offset += 4;

  // fmt chunk
  header.write("fmt ", offset);
  offset += 4;
  header.writeUInt32LE(16, offset); // chunk size
  offset += 4;
  header.writeUInt16LE(1, offset); // PCM format
  offset += 2;
  header.writeUInt16LE(channels, offset);
  offset += 2;
  header.writeUInt32LE(sampleRate, offset);
  offset += 4;
  header.writeUInt32LE(byteRate, offset);
  offset += 4;
  header.writeUInt16LE(blockAlign, offset);
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data chunk
  header.write("data", offset);
  offset += 4;
  header.writeUInt32LE(dataSize, offset);

  return Buffer.concat([header, pcmData]);
}

/**
 * Create an OpenAI STT provider, reading API key from env or options.
 */
export function createOpenAiSttProvider(opts?: {
  apiKey?: string;
  language?: string;
}): OpenAiSttProvider {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenAI API key required. Set OPENAI_API_KEY env var or pass --api-key.",
    );
  }
  return new OpenAiSttProvider({ apiKey, language: opts?.language });
}
