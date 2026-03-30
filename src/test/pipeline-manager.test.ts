import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { resolve } from "node:path";

/**
 * Tests for pipeline-manager.ts.
 *
 * Since the pipeline manager spawns shell pipelines, we test it by
 * using simple echo/cat commands as mock pipelines.
 */

function cliPath(): string {
  return resolve(import.meta.dirname, "../cli.js");
}

describe("pipeline manager", () => {
  it("spawns input and output pipelines and routes events", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    // Use cat as a simple passthrough pipeline for both input and output.
    // Input pipeline: cat passes control events through to its stdout.
    // Output pipeline: cat passes text events through to its stdout.
    const pipelines = startPipelines({
      input: "cat",
      output: "cat",
      verbose: false,
    });

    const inputEvents: unknown[] = [];
    const outputEvents: unknown[] = [];

    pipelines.onInputEvent((event) => {
      inputEvents.push(event);
    });

    pipelines.onOutputEvent((event) => {
      outputEvents.push(event);
    });

    // Write a control event to input pipeline — cat echoes it back
    await pipelines.writeToInput({
      type: "control.state",
      state: "listening",
    });

    // Write a text event to output pipeline — cat echoes it back
    await pipelines.writeToOutput({
      type: "text.delta",
      requestId: "r1",
      delta: "hello",
      seq: 0,
    });

    // Give a moment for events to flow through cat
    await sleep(100);

    assert.ok(
      inputEvents.length >= 1,
      `Expected at least 1 input event, got ${inputEvents.length}`,
    );
    assert.equal((inputEvents[0] as Record<string, unknown>).type, "control.state");

    assert.ok(
      outputEvents.length >= 1,
      `Expected at least 1 output event, got ${outputEvents.length}`,
    );
    assert.equal((outputEvents[0] as Record<string, unknown>).type, "text.delta");

    await pipelines.shutdown();
  });

  it("shutdown terminates pipelines", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    const pipelines = startPipelines({
      input: "cat",
      output: "cat",
      verbose: false,
    });

    pipelines.onInputEvent(() => {});
    pipelines.onOutputEvent(() => {});

    await pipelines.shutdown();

    // After shutdown, both pipeline promises should resolve
    await Promise.all([pipelines.inputDone, pipelines.outputDone]);
  });

  it("forwards control.interrupt to output pipeline", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    const pipelines = startPipelines({
      input: "cat",
      output: "cat",
      verbose: false,
    });

    const outputEvents: unknown[] = [];

    pipelines.onInputEvent(() => {});
    pipelines.onOutputEvent((event) => {
      outputEvents.push(event);
    });

    // Simulate bridge writing control.interrupt to output pipeline
    await pipelines.writeToOutput({
      type: "control.interrupt",
      requestId: "r1",
      reason: "user_speech",
    });

    await sleep(100);

    assert.ok(
      outputEvents.length >= 1,
      `Expected at least 1 output event, got ${outputEvents.length}`,
    );
    assert.equal(
      (outputEvents[0] as Record<string, unknown>).type,
      "control.interrupt",
    );

    await pipelines.shutdown();
  });

  it("forwards control.state to input pipeline", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    const pipelines = startPipelines({
      input: "cat",
      output: "cat",
      verbose: false,
    });

    const inputEvents: unknown[] = [];

    pipelines.onInputEvent((event) => {
      inputEvents.push(event);
    });
    pipelines.onOutputEvent(() => {});

    await pipelines.writeToInput({
      type: "control.state",
      state: "processing",
    });

    await sleep(100);

    assert.ok(
      inputEvents.length >= 1,
      `Expected at least 1 input event, got ${inputEvents.length}`,
    );
    const ev = inputEvents[0] as Record<string, unknown>;
    assert.equal(ev.type, "control.state");
    assert.equal(ev.state, "processing");

    await pipelines.shutdown();
  });

  it("works with actual acpfx tap as pipeline", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    // Use tap as the pipeline — it forwards all events through
    const pipelines = startPipelines({
      input: `node ${cliPath()} tap`,
      output: `node ${cliPath()} tap`,
      verbose: false,
    });

    const inputEvents: unknown[] = [];
    const outputEvents: unknown[] = [];

    pipelines.onInputEvent((event) => {
      inputEvents.push(event);
    });
    pipelines.onOutputEvent((event) => {
      outputEvents.push(event);
    });

    // Write events and verify they pass through tap
    await pipelines.writeToInput({
      type: "speech.pause",
      streamId: "s1",
      silenceMs: 600,
      pendingText: "hello",
    });

    await pipelines.writeToOutput({
      type: "text.delta",
      requestId: "r1",
      delta: "world",
      seq: 0,
    });

    await sleep(200);

    assert.ok(inputEvents.length >= 1, "Expected input events through tap");
    assert.equal((inputEvents[0] as Record<string, unknown>).type, "speech.pause");

    assert.ok(outputEvents.length >= 1, "Expected output events through tap");
    assert.equal((outputEvents[0] as Record<string, unknown>).type, "text.delta");

    await pipelines.shutdown();
  });

  it("works with multi-stage pipeline", async () => {
    const { startPipelines } = await import("../bridge/pipeline-manager.js");

    // Two taps chained together
    const pipelines = startPipelines({
      input: `node ${cliPath()} tap | node ${cliPath()} tap`,
      output: "cat",
      verbose: false,
    });

    const inputEvents: unknown[] = [];

    pipelines.onInputEvent((event) => {
      inputEvents.push(event);
    });
    pipelines.onOutputEvent(() => {});

    await pipelines.writeToInput({
      type: "control.state",
      state: "listening",
    });

    await sleep(300);

    assert.ok(
      inputEvents.length >= 1,
      `Expected events through chained taps, got ${inputEvents.length}`,
    );

    await pipelines.shutdown();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
