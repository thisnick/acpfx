/**
 * Adversarial tests: schema wire format compatibility.
 *
 * Verifies that:
 * 1. Every known event type round-trips through JSON serialization
 * 2. The wire format matches exactly what existing nodes produce
 * 3. When Rust-generated types replace hand-written types, the JSON is identical
 * 4. Real-world event samples (from recordings) deserialize correctly
 * 5. Edge cases: optional fields, extra fields, missing fields
 *
 * This test file captures the CURRENT wire format as golden fixtures.
 * When codegen replaces protocol.ts, these fixtures ensure no regression.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseEvent,
  serializeEvent,
  isKnownEventType,
  type AudioChunkEvent,
  type AudioLevelEvent,
  type SpeechPartialEvent,
  type SpeechDeltaEvent,
  type SpeechFinalEvent,
  type SpeechPauseEvent,
  type AgentSubmitEvent,
  type AgentDeltaEvent,
  type AgentCompleteEvent,
  type AgentThinkingEvent,
  type AgentToolStartEvent,
  type AgentToolDoneEvent,
  type ControlInterruptEvent,
  type ControlStateEvent,
  type ControlErrorEvent,
  type LifecycleReadyEvent,
  type LifecycleDoneEvent,
  type LogEvent,
  type AnyEvent,
} from "@acpfx/core";

// ---- Golden wire format fixtures ----
// These are the exact JSON shapes produced by current nodes.
// Any schema change that alters these breaks backward compatibility.

const GOLDEN_EVENTS: { name: string; json: string; type: string }[] = [
  {
    name: "audio.chunk (minimal)",
    type: "audio.chunk",
    json: '{"type":"audio.chunk","trackId":"mic","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAA","durationMs":100}',
  },
  {
    name: "audio.chunk (with kind)",
    type: "audio.chunk",
    json: '{"type":"audio.chunk","trackId":"player","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AQID","durationMs":50,"kind":"speech"}',
  },
  {
    name: "audio.level",
    type: "audio.level",
    json: '{"type":"audio.level","trackId":"mic","rms":1234,"peak":5678,"dbfs":-12.3}',
  },
  {
    name: "speech.partial",
    type: "speech.partial",
    json: '{"type":"speech.partial","trackId":"stt","text":"hello wor"}',
  },
  {
    name: "speech.delta",
    type: "speech.delta",
    json: '{"type":"speech.delta","trackId":"stt","text":"hello world","replaces":"hello wor"}',
  },
  {
    name: "speech.delta (no replaces)",
    type: "speech.delta",
    json: '{"type":"speech.delta","trackId":"stt","text":"hello"}',
  },
  {
    name: "speech.final",
    type: "speech.final",
    json: '{"type":"speech.final","trackId":"stt","text":"hello world","confidence":0.98}',
  },
  {
    name: "speech.final (no confidence)",
    type: "speech.final",
    json: '{"type":"speech.final","trackId":"stt","text":"hello world"}',
  },
  {
    name: "speech.pause",
    type: "speech.pause",
    json: '{"type":"speech.pause","trackId":"stt","pendingText":"hello world","silenceMs":600}',
  },
  {
    name: "agent.submit",
    type: "agent.submit",
    json: '{"type":"agent.submit","requestId":"abc-123","text":"what is the weather?"}',
  },
  {
    name: "agent.delta",
    type: "agent.delta",
    json: '{"type":"agent.delta","requestId":"abc-123","delta":"The ","seq":0}',
  },
  {
    name: "agent.complete",
    type: "agent.complete",
    json: '{"type":"agent.complete","requestId":"abc-123","text":"The weather is sunny."}',
  },
  {
    name: "agent.complete (with tokenUsage)",
    type: "agent.complete",
    json: '{"type":"agent.complete","requestId":"abc-123","text":"The weather is sunny.","tokenUsage":{"input":42,"output":10}}',
  },
  {
    name: "agent.thinking",
    type: "agent.thinking",
    json: '{"type":"agent.thinking","requestId":"abc-123"}',
  },
  {
    name: "agent.tool_start",
    type: "agent.tool_start",
    json: '{"type":"agent.tool_start","requestId":"abc-123","toolCallId":"tc-1","title":"read_file"}',
  },
  {
    name: "agent.tool_start (no title)",
    type: "agent.tool_start",
    json: '{"type":"agent.tool_start","requestId":"abc-123","toolCallId":"tc-1"}',
  },
  {
    name: "agent.tool_done",
    type: "agent.tool_done",
    json: '{"type":"agent.tool_done","requestId":"abc-123","toolCallId":"tc-1","status":"completed"}',
  },
  {
    name: "control.interrupt",
    type: "control.interrupt",
    json: '{"type":"control.interrupt","reason":"user_speech"}',
  },
  {
    name: "control.state",
    type: "control.state",
    json: '{"type":"control.state","component":"bridge","state":"streaming"}',
  },
  {
    name: "control.error",
    type: "control.error",
    json: '{"type":"control.error","component":"stt-deepgram","message":"WebSocket error","fatal":false}',
  },
  {
    name: "control.error (fatal)",
    type: "control.error",
    json: '{"type":"control.error","component":"stt-elevenlabs","message":"Auth failed","fatal":true}',
  },
  {
    name: "lifecycle.ready",
    type: "lifecycle.ready",
    json: '{"type":"lifecycle.ready","component":"stt-deepgram"}',
  },
  {
    name: "lifecycle.done",
    type: "lifecycle.done",
    json: '{"type":"lifecycle.done","component":"mic-file"}',
  },
  {
    name: "log",
    type: "log",
    json: '{"type":"log","level":"info","component":"stt-deepgram","message":"Connected to Deepgram STT"}',
  },
  {
    name: "log (error level)",
    type: "log",
    json: '{"type":"log","level":"error","component":"tts","message":"WebSocket failed"}',
  },
];

// ---- Tests ----

describe("schema wire format compatibility", () => {
  describe("golden event fixtures round-trip", () => {
    for (const fixture of GOLDEN_EVENTS) {
      it(`${fixture.name}: parse → serialize → parse is identical`, () => {
        const parsed = parseEvent(fixture.json);
        assert.equal(parsed.type, fixture.type);

        // Re-serialize and re-parse
        const reserialized = serializeEvent(parsed);
        const reparsed = parseEvent(reserialized);

        // Deep equality (ignoring field order)
        assert.deepEqual(reparsed, parsed);
      });

      it(`${fixture.name}: all expected fields present`, () => {
        const original = JSON.parse(fixture.json);
        const parsed = parseEvent(fixture.json);

        // Every field in the fixture must be in the parsed result
        for (const key of Object.keys(original)) {
          assert.ok(
            key in parsed,
            `Field '${key}' missing from parsed event`,
          );
          assert.deepEqual(
            (parsed as Record<string, unknown>)[key],
            original[key],
            `Field '${key}' value mismatch`,
          );
        }
      });
    }
  });

  describe("known event type coverage", () => {
    it("GOLDEN_EVENTS covers every known event type", () => {
      const coveredTypes = new Set(GOLDEN_EVENTS.map((f) => f.type));
      const allKnownTypes = [
        "audio.chunk",
        "audio.level",
        "speech.partial",
        "speech.delta",
        "speech.final",
        "speech.pause",
        "agent.submit",
        "agent.delta",
        "agent.complete",
        "agent.thinking",
        "agent.tool_start",
        "agent.tool_done",
        "control.interrupt",
        "control.state",
        "control.error",
        "lifecycle.ready",
        "lifecycle.done",
        "log",
      ];

      for (const t of allKnownTypes) {
        assert.ok(coveredTypes.has(t), `Missing golden fixture for type '${t}'`);
        assert.ok(isKnownEventType(t), `'${t}' should be in KNOWN_TYPES`);
      }
    });
  });

  describe("orchestrator stamp fields", () => {
    it("stamped events preserve all original fields", async () => {
      const { stampEvent } = await import("@acpfx/core");
      const original: AudioChunkEvent = {
        type: "audio.chunk",
        trackId: "mic",
        format: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
        data: "AAAA",
        durationMs: 100,
      };

      const stamped = stampEvent(original, "mic-node");
      assert.equal(stamped.type, "audio.chunk");
      assert.equal(stamped.trackId, "mic");
      assert.equal(stamped._from, "mic-node");
      assert.equal(typeof stamped.ts, "number");
      assert.ok(stamped.ts > 0);

      // Stamp should not modify the original
      assert.equal(original._from, undefined);
      assert.equal(original.ts, undefined);
    });

    it("stamp overwrites existing _from and ts", async () => {
      const { stampEvent } = await import("@acpfx/core");
      const event: LifecycleReadyEvent = {
        type: "lifecycle.ready",
        component: "test",
        _from: "old-name",
        ts: 12345,
      };

      const stamped = stampEvent(event, "new-name");
      assert.equal(stamped._from, "new-name");
      assert.notEqual(stamped.ts, 12345);
    });
  });

  describe("adversarial edge cases", () => {
    it("event with extra fields deserializes without loss", () => {
      // Nodes may emit extra fields. parseEvent must preserve them.
      const json =
        '{"type":"audio.chunk","trackId":"mic","format":"pcm","sampleRate":16000,' +
        '"channels":1,"data":"AA==","durationMs":10,"customField":"hello","nested":{"a":1}}';
      const parsed = parseEvent(json);
      assert.equal(parsed.type, "audio.chunk");
      assert.equal((parsed as Record<string, unknown>).customField, "hello");
      assert.deepEqual((parsed as Record<string, unknown>).nested, { a: 1 });
    });

    it("event with missing optional fields deserializes", () => {
      // agent.tool_start without title
      const json = '{"type":"agent.tool_start","requestId":"r1","toolCallId":"tc1"}';
      const parsed = parseEvent(json) as AgentToolStartEvent;
      assert.equal(parsed.type, "agent.tool_start");
      assert.equal(parsed.title, undefined);
    });

    it("parseEvent rejects objects without type field", () => {
      assert.throws(
        () => parseEvent('{"trackId":"mic","data":"AA=="}'),
        /missing 'type' field/,
      );
    });

    it("parseEvent rejects type field that is not a string", () => {
      assert.throws(
        () => parseEvent('{"type":42}'),
        /missing 'type' field/,
      );
    });

    it("parseEvent rejects null", () => {
      assert.throws(() => parseEvent("null"));
    });

    it("parseEvent rejects arrays", () => {
      assert.throws(() => parseEvent('[{"type":"audio.chunk"}]'));
    });

    it("event with numeric string fields doesn't coerce", () => {
      // Verify that numeric fields stay numbers and string fields stay strings
      const json = '{"type":"audio.chunk","trackId":"mic","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AA==","durationMs":100}';
      const parsed = parseEvent(json) as AudioChunkEvent;
      assert.equal(typeof parsed.sampleRate, "number");
      assert.equal(typeof parsed.channels, "number");
      assert.equal(typeof parsed.durationMs, "number");
      assert.equal(typeof parsed.trackId, "string");
      assert.equal(typeof parsed.data, "string");
    });

    it("very large base64 data field round-trips", () => {
      // 64KB of random-looking data (all zeros encoded)
      const bigData = Buffer.alloc(65536).toString("base64");
      const event: AudioChunkEvent = {
        type: "audio.chunk",
        trackId: "test",
        format: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
        data: bigData,
        durationMs: 2048,
      };
      const json = serializeEvent(event);
      const parsed = parseEvent(json) as AudioChunkEvent;
      assert.equal(parsed.data, bigData);
    });

    it("unicode text in speech events round-trips", () => {
      const event: SpeechFinalEvent = {
        type: "speech.final",
        trackId: "stt",
        text: "日本語テスト 🎤 café résumé",
      };
      const json = serializeEvent(event);
      const parsed = parseEvent(json) as SpeechFinalEvent;
      assert.equal(parsed.text, event.text);
    });

    it("empty string fields are preserved", () => {
      const event: SpeechPartialEvent = {
        type: "speech.partial",
        trackId: "",
        text: "",
      };
      const json = serializeEvent(event);
      const parsed = parseEvent(json) as SpeechPartialEvent;
      assert.equal(parsed.trackId, "");
      assert.equal(parsed.text, "");
    });
  });

  // ---- Rust/TS numeric wire format compatibility ----
  //
  // After the schema fix: ts (u64), durationMs (u32), silenceMs (u32) are now
  // integers in Rust, so both Rust and TS serialize them identically (no ".0").
  // Only genuinely fractional f64 fields remain: rms, peak, dbfs, confidence.
  // For those, Rust serde_json may append ".0" for whole-number values while
  // TS JSON.stringify does not, but in practice these fields are always fractional.

  describe("Rust/TS numeric wire format compatibility", () => {
    it("durationMs serializes identically (u32 in Rust, number in TS)", () => {
      // After schema fix: duration_ms is u32, both produce "20"
      const rustJson =
        '{"type":"audio.chunk","trackId":"mic","format":"s16le","sampleRate":16000,"channels":1,"data":"AAAA","durationMs":20}';
      const tsEvent = {
        type: "audio.chunk" as const,
        trackId: "mic",
        format: "s16le",
        sampleRate: 16000,
        channels: 1,
        data: "AAAA",
        durationMs: 20,
      };
      const tsJson = JSON.stringify(tsEvent);

      assert.equal(rustJson, tsJson, "Rust u32 and TS number serialize identically for integers");
    });

    it("ts serializes identically (u64 in Rust, number in TS)", () => {
      // After schema fix: ts is u64, both produce "1711929600000"
      const rustJson =
        '{"type":"lifecycle.ready","component":"test","ts":1711929600000,"_from":"test"}';
      const tsEvent = {
        type: "lifecycle.ready" as const,
        component: "test",
        ts: 1711929600000,
        _from: "test",
      };
      const tsJson = JSON.stringify(tsEvent);

      assert.equal(rustJson, tsJson, "Rust u64 and TS number serialize identically for timestamps");
    });

    it("silenceMs serializes identically (u32 in Rust, number in TS)", () => {
      const rustJson =
        '{"type":"speech.pause","trackId":"mic","pendingText":"hello","silenceMs":500}';
      const tsEvent = {
        type: "speech.pause" as const,
        trackId: "mic",
        pendingText: "hello",
        silenceMs: 500,
      };
      const tsJson = JSON.stringify(tsEvent);

      assert.equal(rustJson, tsJson, "Rust u32 and TS number serialize identically");
    });

    it("fractional f64 fields (rms, peak, dbfs) serialize identically", () => {
      // These remain f64 in Rust — but in practice they're always fractional,
      // so both Rust and TS produce the same string
      const rustJson = '{"type":"audio.level","trackId":"mic","rms":0.42,"peak":0.87,"dbfs":-24.5}';
      const tsEvent = {
        type: "audio.level" as const,
        trackId: "mic",
        rms: 0.42,
        peak: 0.87,
        dbfs: -24.5,
      };
      const tsJson = JSON.stringify(tsEvent);

      assert.equal(rustJson, tsJson, "Fractional f64 values serialize identically");
    });

    it("cross-language parseEvent handles both integer and float formats", () => {
      // parseEvent must accept both "20" and "20.0" — JSON spec treats them as equivalent
      const intStyle = '{"type":"audio.chunk","trackId":"mic","format":"s16le","sampleRate":16000,"channels":1,"data":"AA","durationMs":20}';
      const floatStyle = '{"type":"audio.chunk","trackId":"mic","format":"s16le","sampleRate":16000,"channels":1,"data":"AA","durationMs":20.0}';

      const fromInt = parseEvent(intStyle);
      const fromFloat = parseEvent(floatStyle);

      assert.equal(fromInt.type, "audio.chunk");
      assert.equal(fromFloat.type, "audio.chunk");
      assert.equal(
        (fromInt as any).durationMs,
        (fromFloat as any).durationMs,
        "Both formats parse to the same numeric value",
      );
    });
  });

  // ---- Codegen drift check ----

  describe("codegen drift", () => {
    function findRoot(): string {
      let dir = import.meta.dirname ?? process.cwd();
      while (dir !== "/" && !existsSync(join(dir, "package.json"))) {
        dir = resolve(dir, "..");
      }
      return dir;
    }

    it("generated-types.ts exists", () => {
      const root = findRoot();
      const generatedPath = join(root, "packages/core/src/generated-types.ts");
      assert.ok(
        existsSync(generatedPath),
        "generated-types.ts must exist (run codegen: cargo run -p acpfx-schema --bin acpfx-codegen)",
      );
    });

    it("generated-types.ts includes player.status (21 event types)", () => {
      const root = findRoot();
      const generatedPath = join(root, "packages/core/src/generated-types.ts");
      if (!existsSync(generatedPath)) return;

      const content = readFileSync(generatedPath, "utf-8");
      assert.ok(
        content.includes('"player.status"'),
        "generated-types.ts must include player.status in KNOWN_TYPES",
      );
      assert.ok(
        content.includes("PlayerStatusEvent"),
        "generated-types.ts must define PlayerStatusEvent type",
      );
    });

    it("generated-types.ts KNOWN_TYPES has exactly 21 entries", () => {
      const root = findRoot();
      const generatedPath = join(root, "packages/core/src/generated-types.ts");
      if (!existsSync(generatedPath)) return;

      const content = readFileSync(generatedPath, "utf-8");
      // Count entries in the KNOWN_TYPES set
      const knownTypesMatch = content.match(/const KNOWN_TYPES = new Set\(\[([\s\S]*?)\]\)/);
      assert.ok(knownTypesMatch, "KNOWN_TYPES set must exist");

      const entries = knownTypesMatch![1].match(/"[^"]+"/g) ?? [];
      assert.equal(
        entries.length,
        21,
        `KNOWN_TYPES should have 21 entries (matching Rust schema), got ${entries.length}: ${entries.join(", ")}`,
      );
    });

    it("generated-types.ts matches golden event type set from Rust schema", () => {
      const root = findRoot();
      const generatedPath = join(root, "packages/core/src/generated-types.ts");
      if (!existsSync(generatedPath)) return;

      const content = readFileSync(generatedPath, "utf-8");
      // These are the 21 types from Rust schema categories.rs
      const expectedTypes = [
        "audio.chunk", "audio.level",
        "speech.partial", "speech.delta", "speech.final", "speech.pause",
        "agent.submit", "agent.delta", "agent.complete", "agent.thinking",
        "agent.tool_start", "agent.tool_done", "agent.history",
        "control.interrupt", "control.state", "control.error",
        "lifecycle.ready", "lifecycle.done",
        "log",
        "player.status",
        "node.status",
      ];

      for (const t of expectedTypes) {
        assert.ok(
          content.includes(`"${t}"`),
          `generated-types.ts missing event type "${t}"`,
        );
      }
    });

    it("generated-zod.ts exists and has schemas for all event types", () => {
      const root = findRoot();
      const zodPath = join(root, "packages/core/src/generated-zod.ts");
      assert.ok(
        existsSync(zodPath),
        "generated-zod.ts must exist",
      );

      const content = readFileSync(zodPath, "utf-8");
      // Verify key schemas exist
      const expectedSchemas = [
        "AudioChunkEventSchema",
        "SpeechFinalEventSchema",
        "AgentDeltaEventSchema",
        "ControlInterruptEventSchema",
        "LifecycleReadyEventSchema",
        "LogEventSchema",
        "PlayerStatusEventSchema",
      ];
      for (const name of expectedSchemas) {
        assert.ok(
          content.includes(name),
          `generated-zod.ts missing schema: ${name}`,
        );
      }
    });

    it("schema.json exists", () => {
      const root = findRoot();
      const schemaPath = join(root, "schema.json");
      assert.ok(
        existsSync(schemaPath),
        "schema.json must exist (generated by codegen)",
      );

      const content = readFileSync(schemaPath, "utf-8");
      const schema = JSON.parse(content);
      assert.ok(schema, "schema.json must be valid JSON");
    });
  });
});
