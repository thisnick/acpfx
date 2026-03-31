import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import {
  PipelineStatus,
  InputSection,
  AgentSection,
  OutputSection,
  LatencyBar,
  Dashboard,
  type NodeState,
} from "../nodes/ui-cli-components.js";

describe("ui-cli components", () => {
  it("PipelineStatus renders node names and checkmarks from lifecycle.ready", () => {
    const nodes: NodeState[] = [
      { name: "mic", ready: true },
      { name: "stt", ready: true },
      { name: "bridge", ready: false },
    ];
    const { lastFrame } = render(
      <PipelineStatus state="Listening" nodes={nodes} error={null} />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("Listening"), "Should show Listening state");
    assert.ok(frame.includes("mic"), "Should show mic node");
    assert.ok(frame.includes("stt"), "Should show stt node");
    assert.ok(frame.includes("bridge"), "Should show bridge node");
  });

  it("PipelineStatus renders error messages", () => {
    const { lastFrame } = render(
      <PipelineStatus state="Listening" nodes={[]} error="connection failed" />,
    );
    assert.ok(lastFrame()!.includes("connection failed"), "Should show error");
  });

  it("InputSection renders level meter and STT text", () => {
    const { lastFrame } = render(
      <InputSection rms={16384} dbfs={-6} sttText="Write me" sttState="partial" />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("Write me"), "Should show STT text");
    assert.ok(frame.includes("partial"), "Should show partial state");
    assert.ok(frame.includes("-6.0 dBFS"), "Should show dBFS");
    // Level meter should have some filled chars
    assert.ok(frame.includes("="), "Should show level meter fill");
  });

  it("InputSection renders empty level for rms=0", () => {
    const { lastFrame } = render(
      <InputSection rms={0} dbfs={-Infinity} sttText="" sttState="idle" />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("[--------------------]"), "Should show empty meter");
  });

  it("InputSection updates with new STT text", () => {
    const { lastFrame, rerender } = render(
      <InputSection rms={0} dbfs={-Infinity} sttText="Write me" sttState="partial" />,
    );
    assert.ok(lastFrame()!.includes("Write me"));

    rerender(
      <InputSection
        rms={0}
        dbfs={-Infinity}
        sttText="Write me an essay"
        sttState="partial"
      />,
    );
    assert.ok(lastFrame()!.includes("Write me an essay"), "Should update text");
  });

  it("AgentSection renders streaming text and token count", () => {
    const { lastFrame } = render(
      <AgentSection
        status="streaming"
        text="The fear of AI is"
        tokens={5}
        ttft={1800}
        elapsed={2100}
      />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("Streaming"), "Should show streaming status");
    assert.ok(frame.includes("The fear of AI is"), "Should show agent text");
    assert.ok(frame.includes("5"), "Should show token count");
    assert.ok(frame.includes("TTFT: 1.8s"), "Should show TTFT");
  });

  it("AgentSection renders waiting state", () => {
    const { lastFrame } = render(
      <AgentSection
        status="waiting"
        text=""
        tokens={0}
        ttft={null}
        elapsed={1500}
      />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("Waiting"), "Should show waiting status");
    assert.ok(frame.includes("1.5s"), "Should show elapsed time");
  });

  it("OutputSection renders TTS progress", () => {
    const { lastFrame } = render(
      <OutputSection chunksReceived={15} durationMs={3200} />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("15 chunks"), "Should show chunk count");
    assert.ok(frame.includes("3.2s"), "Should show duration");
  });

  it("LatencyBar computes and displays hop latencies", () => {
    const { lastFrame } = render(
      <LatencyBar sttMs={150} vadMs={620} agentMs={1800} ttsMs={480} />,
    );
    const frame = lastFrame()!;
    assert.ok(frame.includes("STT: 150ms"), "Should show STT latency");
    assert.ok(frame.includes("VAD: 620ms"), "Should show VAD latency");
    assert.ok(frame.includes("Agent: 1.8s"), "Should show agent latency");
    assert.ok(frame.includes("TTS: 480ms"), "Should show TTS latency");
    assert.ok(frame.includes("End-to-end"), "Should show end-to-end");
  });

  it("LatencyBar shows no data when no latencies available", () => {
    const { lastFrame } = render(
      <LatencyBar sttMs={null} vadMs={null} agentMs={null} ttsMs={null} />,
    );
    assert.ok(lastFrame()!.includes("No data yet"), "Should show no data");
  });
});
