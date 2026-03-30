import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import {
  parseEvent,
  serializeEvent,
  isKnownEventType,
  type AnyEvent,
  type AudioChunkEvent,
  type SpeechPauseEvent,
  type TextDeltaEvent,
  type ControlInterruptEvent,
} from "../protocol.js";
import { readEvents, createEventWriter } from "../pipeline-io.js";

describe("protocol", () => {
  describe("parseEvent", () => {
    it("parses audio.chunk", () => {
      const event = parseEvent(
        '{"type":"audio.chunk","streamId":"s1","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAA","durationMs":20}',
      );
      assert.equal(event.type, "audio.chunk");
      assert.equal((event as AudioChunkEvent).streamId, "s1");
      assert.equal((event as AudioChunkEvent).sampleRate, 16000);
    });

    it("parses speech.pause", () => {
      const event = parseEvent(
        '{"type":"speech.pause","streamId":"s1","silenceMs":600,"pendingText":"fix the test"}',
      );
      assert.equal(event.type, "speech.pause");
      assert.equal((event as SpeechPauseEvent).pendingText, "fix the test");
    });

    it("parses text.delta", () => {
      const event = parseEvent(
        '{"type":"text.delta","requestId":"r1","delta":"hello","seq":0}',
      );
      assert.equal(event.type, "text.delta");
      assert.equal((event as TextDeltaEvent).delta, "hello");
    });

    it("parses unknown event types without error", () => {
      const event = parseEvent('{"type":"custom.event","data":"test"}');
      assert.equal(event.type, "custom.event");
      assert.equal((event as Record<string, unknown>).data, "test");
    });

    it("throws on invalid JSON", () => {
      assert.throws(() => parseEvent("not json"), SyntaxError);
    });

    it("throws on missing type field", () => {
      assert.throws(
        () => parseEvent('{"data":"test"}'),
        /missing 'type' field/,
      );
    });

    it("throws on non-object JSON", () => {
      assert.throws(() => parseEvent('"hello"'), /missing 'type' field/);
    });
  });

  describe("serializeEvent", () => {
    it("roundtrips audio.chunk", () => {
      const original: AudioChunkEvent = {
        type: "audio.chunk",
        streamId: "s1",
        format: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
        data: "AAAA",
        durationMs: 20,
      };
      const serialized = serializeEvent(original);
      const parsed = parseEvent(serialized);
      assert.deepEqual(parsed, original);
    });

    it("roundtrips control.interrupt", () => {
      const original: ControlInterruptEvent = {
        type: "control.interrupt",
        requestId: "r1",
        reason: "user_speech",
      };
      const serialized = serializeEvent(original);
      const parsed = parseEvent(serialized);
      assert.deepEqual(parsed, original);
    });

    it("roundtrips unknown event types", () => {
      const original: AnyEvent = {
        type: "vendor.custom",
        payload: { nested: true },
      };
      const serialized = serializeEvent(original);
      const parsed = parseEvent(serialized);
      assert.deepEqual(parsed, original);
    });
  });

  describe("isKnownEventType", () => {
    it("recognizes known types", () => {
      assert.equal(isKnownEventType("audio.chunk"), true);
      assert.equal(isKnownEventType("speech.pause"), true);
      assert.equal(isKnownEventType("text.delta"), true);
      assert.equal(isKnownEventType("control.interrupt"), true);
      assert.equal(isKnownEventType("control.error"), true);
    });

    it("rejects unknown types", () => {
      assert.equal(isKnownEventType("custom.event"), false);
      assert.equal(isKnownEventType(""), false);
    });
  });
});

describe("pipeline-io", () => {
  describe("readEvents", () => {
    it("reads multiple NDJSON lines", async () => {
      const events: AnyEvent[] = [];
      const input = Readable.from([
        '{"type":"speech.partial","streamId":"s1","text":"hello"}\n',
        '{"type":"speech.final","streamId":"s1","text":"hello world"}\n',
      ]);

      await readEvents(input, (event) => { events.push(event); });

      assert.equal(events.length, 2);
      assert.equal(events[0].type, "speech.partial");
      assert.equal(events[1].type, "speech.final");
    });

    it("handles chunked input (line split across chunks)", async () => {
      const events: AnyEvent[] = [];
      const input = Readable.from([
        '{"type":"text.del',
        'ta","requestId":"r1","delta":"hi","seq":0}\n',
      ]);

      await readEvents(input, (event) => { events.push(event); });

      assert.equal(events.length, 1);
      assert.equal(events[0].type, "text.delta");
    });

    it("handles multiple events in a single chunk", async () => {
      const events: AnyEvent[] = [];
      const lines =
        '{"type":"speech.partial","streamId":"s1","text":"a"}\n{"type":"speech.final","streamId":"s1","text":"ab"}\n';
      const input = Readable.from([lines]);

      await readEvents(input, (event) => { events.push(event); });

      assert.equal(events.length, 2);
    });

    it("handles trailing data without newline", async () => {
      const events: AnyEvent[] = [];
      const input = Readable.from([
        '{"type":"speech.final","streamId":"s1","text":"done"}',
      ]);

      await readEvents(input, (event) => { events.push(event); });

      assert.equal(events.length, 1);
      assert.equal(events[0].type, "speech.final");
    });

    it("calls error handler for invalid JSON", async () => {
      const events: AnyEvent[] = [];
      const errors: { error: Error; line: string }[] = [];
      const input = Readable.from([
        "not valid json\n",
        '{"type":"speech.final","streamId":"s1","text":"ok"}\n',
      ]);

      await readEvents(
        input,
        (event) => { events.push(event); },
        (error, line) => { errors.push({ error, line }); },
      );

      assert.equal(events.length, 1);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].line, "not valid json");
    });

    it("skips empty lines", async () => {
      const events: AnyEvent[] = [];
      const input = Readable.from([
        "\n\n",
        '{"type":"speech.final","streamId":"s1","text":"ok"}\n',
        "\n",
      ]);

      await readEvents(input, (event) => { events.push(event); });

      assert.equal(events.length, 1);
    });
  });

  describe("createEventWriter", () => {
    it("writes NDJSON lines", async () => {
      const output = new PassThrough();
      const writer = createEventWriter(output);
      const chunks: string[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

      await writer.write({
        type: "text.delta",
        requestId: "r1",
        delta: "hello",
        seq: 0,
      });
      await writer.write({
        type: "text.complete",
        requestId: "r1",
        text: "hello world",
      });
      await writer.end();

      const result = chunks.join("");
      const lines = result.trim().split("\n");
      assert.equal(lines.length, 2);

      const first = JSON.parse(lines[0]);
      assert.equal(first.type, "text.delta");
      assert.equal(first.delta, "hello");

      const second = JSON.parse(lines[1]);
      assert.equal(second.type, "text.complete");
    });

    it("preserves unknown event fields", async () => {
      const output = new PassThrough();
      const writer = createEventWriter(output);
      const chunks: string[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

      await writer.write({
        type: "vendor.custom",
        foo: "bar",
        nested: { deep: true },
      });
      await writer.end();

      const result = chunks.join("");
      const parsed = JSON.parse(result.trim());
      assert.equal(parsed.type, "vendor.custom");
      assert.equal(parsed.foo, "bar");
      assert.deepEqual(parsed.nested, { deep: true });
    });
  });

  describe("roundtrip: write then read", () => {
    it("events survive write → read cycle", async () => {
      const pipe = new PassThrough();
      const writer = createEventWriter(pipe);

      const originalEvents: AnyEvent[] = [
        {
          type: "audio.chunk",
          streamId: "s1",
          format: "pcm_s16le",
          sampleRate: 16000,
          channels: 1,
          data: "AAAA",
          durationMs: 20,
        },
        {
          type: "speech.pause",
          streamId: "s1",
          silenceMs: 600,
          pendingText: "fix the test",
        },
        {
          type: "text.delta",
          requestId: "r1",
          delta: "Looking at",
          seq: 0,
        },
        {
          type: "control.interrupt",
          requestId: "r1",
          reason: "user_speech",
        },
        {
          type: "vendor.unknown",
          custom: "data",
        },
      ];

      // Write all events then close
      for (const event of originalEvents) {
        await writer.write(event);
      }
      await writer.end();

      // Read them back
      const readBack: AnyEvent[] = [];
      await readEvents(pipe, (event) => { readBack.push(event); });

      assert.equal(readBack.length, originalEvents.length);
      for (let i = 0; i < originalEvents.length; i++) {
        assert.deepEqual(readBack[i], originalEvents[i]);
      }
    });
  });

  describe("unicode and edge cases", () => {
    it("handles unicode text in events", async () => {
      const pipe = new PassThrough();
      const writer = createEventWriter(pipe);

      const event: AnyEvent = {
        type: "text.delta",
        requestId: "r1",
        delta: "Hello \u{1F600} world \u4F60\u597D",
        seq: 0,
      };
      await writer.write(event);
      await writer.end();

      const events: AnyEvent[] = [];
      await readEvents(pipe, (e) => { events.push(e); });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], event);
    });

    it("handles empty string fields", async () => {
      const event = parseEvent(
        '{"type":"speech.final","streamId":"","text":""}',
      );
      assert.equal(event.type, "speech.final");
    });
  });
});
