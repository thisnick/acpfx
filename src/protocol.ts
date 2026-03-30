/**
 * NDJSON streaming protocol event type definitions.
 *
 * All inter-component communication uses newline-delimited JSON.
 * Each line has a `type` field. Unknown types are forwarded unchanged.
 */

// --- Audio events ---

export type AudioChunkEvent = {
  type: "audio.chunk";
  streamId: string;
  format: string;
  sampleRate: number;
  channels: number;
  data: string; // base64-encoded PCM
  durationMs: number;
};

// --- Speech events ---

export type SpeechPartialEvent = {
  type: "speech.partial";
  streamId: string;
  text: string;
};

export type SpeechFinalEvent = {
  type: "speech.final";
  streamId: string;
  text: string;
};

export type SpeechPauseEvent = {
  type: "speech.pause";
  streamId: string;
  silenceMs: number;
  pendingText: string;
};

export type SpeechResumeEvent = {
  type: "speech.resume";
  streamId: string;
};

// --- Text events ---

export type TextDeltaEvent = {
  type: "text.delta";
  requestId: string;
  delta: string;
  seq: number;
};

export type TextCompleteEvent = {
  type: "text.complete";
  requestId: string;
  text: string;
};

// --- Control events ---

export type ControlInterruptEvent = {
  type: "control.interrupt";
  requestId: string;
  reason: string;
};

export type ControlStateEvent = {
  type: "control.state";
  state: "listening" | "processing" | "speaking";
};

export type ControlErrorEvent = {
  type: "control.error";
  message: string;
  source?: string;
};

// --- Union types ---

export type AudioEvent = AudioChunkEvent;

export type SpeechEvent =
  | SpeechPartialEvent
  | SpeechFinalEvent
  | SpeechPauseEvent
  | SpeechResumeEvent;

export type TextEvent = TextDeltaEvent | TextCompleteEvent;

export type ControlEvent =
  | ControlInterruptEvent
  | ControlStateEvent
  | ControlErrorEvent;

export type PipelineEvent =
  | AudioEvent
  | SpeechEvent
  | TextEvent
  | ControlEvent;

/**
 * An unknown event is any JSON object with a `type` field that doesn't
 * match a known event type. These are forwarded unchanged.
 */
export type UnknownEvent = {
  type: string;
  [key: string]: unknown;
};

export type AnyEvent = PipelineEvent | UnknownEvent;

// --- Type guards ---

const KNOWN_TYPES = new Set([
  "audio.chunk",
  "speech.partial",
  "speech.final",
  "speech.pause",
  "speech.resume",
  "text.delta",
  "text.complete",
  "control.interrupt",
  "control.state",
  "control.error",
]);

export function isKnownEventType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

export function parseEvent(json: string): AnyEvent {
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
    throw new Error("Invalid event: missing 'type' field");
  }
  return obj as AnyEvent;
}

export function serializeEvent(event: AnyEvent): string {
  return JSON.stringify(event);
}
