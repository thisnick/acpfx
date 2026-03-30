/**
 * Audio provider interfaces for mic (capture) and play (playback).
 */

export type AudioFormat = {
  format: string; // e.g., "pcm_s16le"
  sampleRate: number;
  channels: number;
};

export type AudioCaptureChunk = {
  data: Buffer;
  durationMs: number;
};

export interface AudioCaptureProvider {
  /**
   * Start capturing audio. Yields chunks as they become available.
   * For file provider: reads the file and yields chunks paced at real-time rate.
   * For sox provider: captures from microphone.
   */
  capture(signal?: AbortSignal): AsyncGenerator<AudioCaptureChunk>;

  /** Audio format of captured chunks */
  readonly format: AudioFormat;
}

export interface AudioPlaybackProvider {
  /**
   * Start playback session. Call write() to send audio chunks,
   * flush() to ensure all audio is played, close() to finish.
   */
  start(): Promise<void>;
  write(data: Buffer): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;

  /** Expected audio format */
  readonly format: AudioFormat;
}
