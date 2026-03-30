/**
 * TTS provider interface — all providers implement this.
 */

export type TtsChunk = {
  format: string;
  sampleRate: number;
  channels: number;
  data: string; // base64-encoded audio
  durationMs: number;
};

export interface TtsProvider {
  /**
   * Synthesize text into audio chunks.
   * Returns an async generator that yields audio chunks as they become available.
   * Should respect the abort signal for cancellation.
   */
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<TtsChunk>;
}
