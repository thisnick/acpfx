import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEvent,
  serializeEvent,
  stampEvent,
  isKnownEventType,
  type AudioChunkEvent,
  type SpeechPauseEvent,
  type AgentDeltaEvent,
  type LifecycleReadyEvent,
  type ControlInterruptEvent,
} from "../protocol.js";

describe("protocol v2", () => {
  it("defines all event types with string literal type field", () => {
    const chunk: AudioChunkEvent = {
      type: "audio.chunk",
      trackId: "mic",
      format: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      data: "AAAA",
      durationMs: 100,
    };
    assert.equal(chunk.type, "audio.chunk");

    const pause: SpeechPauseEvent = {
      type: "speech.pause",
      trackId: "mic",
      pendingText: "hello",
      silenceMs: 600,
    };
    assert.equal(pause.type, "speech.pause");

    const delta: AgentDeltaEvent = {
      type: "agent.delta",
      requestId: "r1",
      delta: "The ",
      seq: 0,
    };
    assert.equal(delta.type, "agent.delta");

    const ready: LifecycleReadyEvent = {
      type: "lifecycle.ready",
      component: "mic",
    };
    assert.equal(ready.type, "lifecycle.ready");

    const interrupt: ControlInterruptEvent = {
      type: "control.interrupt",
      reason: "barge-in",
    };
    assert.equal(interrupt.type, "control.interrupt");
  });

  it("isKnownEventType recognizes all v2 types", () => {
    const known = [
      "audio.chunk", "audio.level",
      "speech.partial", "speech.delta", "speech.final", "speech.pause",
      "agent.submit", "agent.delta", "agent.complete",
      "control.interrupt", "control.state", "control.error",
      "lifecycle.ready", "lifecycle.done",
    ];
    for (const t of known) {
      assert.ok(isKnownEventType(t), `${t} should be known`);
    }
    assert.ok(!isKnownEventType("unknown.type"));
    assert.ok(!isKnownEventType("text.delta")); // v1 type, not in v2
  });

  it("parseEvent parses valid JSON", () => {
    const ev = parseEvent('{"type":"audio.chunk","trackId":"mic","format":"pcm","sampleRate":16000,"channels":1,"data":"AA==","durationMs":10}');
    assert.equal(ev.type, "audio.chunk");
  });

  it("parseEvent rejects invalid JSON", () => {
    assert.throws(() => parseEvent("not json"), SyntaxError);
    assert.throws(() => parseEvent('{"no":"type"}'), /missing 'type' field/);
    assert.throws(() => parseEvent('{"type":42}'), /missing 'type' field/);
  });

  it("serializeEvent round-trips", () => {
    const ev: LifecycleReadyEvent = { type: "lifecycle.ready", component: "stt" };
    const json = serializeEvent(ev);
    const parsed = parseEvent(json);
    assert.deepEqual(parsed, ev);
  });

  it("stampEvent adds ts and _from", () => {
    const ev: LifecycleReadyEvent = { type: "lifecycle.ready", component: "mic" };
    const stamped = stampEvent(ev, "mic");
    assert.equal(stamped._from, "mic");
    assert.equal(typeof stamped.ts, "number");
    assert.ok(stamped.ts > 0);
    // Original fields preserved
    assert.equal(stamped.component, "mic");
    assert.equal(stamped.type, "lifecycle.ready");
  });
});
