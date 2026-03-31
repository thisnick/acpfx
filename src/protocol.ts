/**
 * Streaming Protocol v2 — Event type definitions for the DAG-based pipeline.
 *
 * Every event has a `type` field ("category.event").
 * The orchestrator stamps `ts` (wall-clock ms) and `_from` (source node name).
 */

// ---- Event Envelope ----

/** Fields added by the orchestrator to every routed event. */
export type OrchestratorStamp = {
  ts?: number;    // wall-clock ms since epoch, added by orchestrator
  _from?: string; // source node name, added by orchestrator
};

// ---- Audio ----

export type AudioChunkEvent = OrchestratorStamp & {
  type: "audio.chunk";
  trackId: string;
  format: string;
  sampleRate: number;
  channels: number;
  data: string; // base64-encoded PCM
  durationMs: number;
};

export type AudioLevelEvent = OrchestratorStamp & {
  type: "audio.level";
  trackId: string;
  rms: number;
  peak: number;
  dbfs: number;
};

// ---- Speech Recognition ----

export type SpeechPartialEvent = OrchestratorStamp & {
  type: "speech.partial";
  trackId: string;
  text: string;
};

export type SpeechDeltaEvent = OrchestratorStamp & {
  type: "speech.delta";
  trackId: string;
  text: string;
  replaces?: string;
};

export type SpeechFinalEvent = OrchestratorStamp & {
  type: "speech.final";
  trackId: string;
  text: string;
  confidence?: number;
};

export type SpeechPauseEvent = OrchestratorStamp & {
  type: "speech.pause";
  trackId: string;
  pendingText: string;
  silenceMs: number;
};

// ---- Agent/LLM ----

export type AgentSubmitEvent = OrchestratorStamp & {
  type: "agent.submit";
  requestId: string;
  text: string;
};

export type AgentDeltaEvent = OrchestratorStamp & {
  type: "agent.delta";
  requestId: string;
  delta: string;
  seq: number;
};

export type AgentCompleteEvent = OrchestratorStamp & {
  type: "agent.complete";
  requestId: string;
  text: string;
  tokenUsage?: { input: number; output: number };
};

// ---- Control ----

export type ControlInterruptEvent = OrchestratorStamp & {
  type: "control.interrupt";
  reason: string;
};

export type ControlStateEvent = OrchestratorStamp & {
  type: "control.state";
  component: string;
  state: string;
};

export type ControlErrorEvent = OrchestratorStamp & {
  type: "control.error";
  component: string;
  message: string;
  fatal: boolean;
};

// ---- Lifecycle ----

export type LifecycleReadyEvent = OrchestratorStamp & {
  type: "lifecycle.ready";
  component: string;
};

export type LifecycleDoneEvent = OrchestratorStamp & {
  type: "lifecycle.done";
  component: string;
};

// ---- Log ----

export type LogEvent = OrchestratorStamp & {
  type: "log";
  level: "info" | "warn" | "error" | "debug";
  component: string;
  message: string;
};

// ---- Union types ----

export type AudioEvent = AudioChunkEvent | AudioLevelEvent;

export type SpeechEvent =
  | SpeechPartialEvent
  | SpeechDeltaEvent
  | SpeechFinalEvent
  | SpeechPauseEvent;

export type AgentEvent =
  | AgentSubmitEvent
  | AgentDeltaEvent
  | AgentCompleteEvent;

export type ControlEvent =
  | ControlInterruptEvent
  | ControlStateEvent
  | ControlErrorEvent;

export type LifecycleEvent = LifecycleReadyEvent | LifecycleDoneEvent;
export type LogEventType = LogEvent;

export type PipelineEvent =
  | AudioEvent
  | SpeechEvent
  | AgentEvent
  | ControlEvent
  | LifecycleEvent
  | LogEvent;

/** An event with a `type` field that doesn't match a known type. Forwarded unchanged. */
export type UnknownEvent = OrchestratorStamp & {
  type: string;
  [key: string]: unknown;
};

export type AnyEvent = PipelineEvent | UnknownEvent;

// ---- Type discrimination ----

const KNOWN_TYPES = new Set([
  "audio.chunk",
  "audio.level",
  "speech.partial",
  "speech.delta",
  "speech.final",
  "speech.pause",
  "agent.submit",
  "agent.delta",
  "agent.complete",
  "control.interrupt",
  "control.state",
  "control.error",
  "lifecycle.ready",
  "lifecycle.done",
  "log",
]);

export function isKnownEventType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

// ---- Serialization ----

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

// ---- Helpers ----

/** Create an event with the given type and payload. */
export function createEvent<T extends AnyEvent>(event: T): T {
  return event;
}

/** Stamp an event with orchestrator metadata. */
export function stampEvent<T extends AnyEvent>(
  event: T,
  from: string,
): T & Required<OrchestratorStamp> {
  return { ...event, ts: Date.now(), _from: from };
}
