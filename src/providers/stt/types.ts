/**
 * STT provider interface — all speech-to-text providers implement this.
 */

export type SttResult = {
  text: string;
};

export interface SttProvider {
  /**
   * Transcribe a buffer of PCM audio data.
   * The audio should be 16-bit signed LE PCM at the given sample rate.
   * Returns the transcribed text.
   */
  transcribe(
    pcmData: Buffer,
    opts: { sampleRate: number; channels: number },
    signal?: AbortSignal,
  ): Promise<SttResult>;
}
