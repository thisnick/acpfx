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

/**
 * A TTS provider that supports persistent WebSocket streaming.
 * Text chunks are sent incrementally over an open connection,
 * and audio chunks are yielded as they arrive — no per-sentence reconnection.
 */
export interface StreamingTtsProvider extends TtsProvider {
  readonly supportsStreaming: true;

  /** Open a WebSocket connection and send BOS. Resolves when connection is ready. Returns an async iterable of audio chunks. */
  startStream(signal?: AbortSignal): Promise<AsyncGenerator<TtsChunk>>;

  /** Send a text chunk to the open WebSocket. */
  sendText(chunk: string): void;

  /** Send EOS and yield remaining audio. The generator from startStream() will complete. */
  endStream(): void;

  /** Close the WebSocket immediately, discarding pending audio. */
  abort(): void;
}

export function isStreamingProvider(
  provider: TtsProvider,
): provider is StreamingTtsProvider {
  return "supportsStreaming" in provider && (provider as StreamingTtsProvider).supportsStreaming === true;
}
