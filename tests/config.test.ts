import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, ConfigError, outputNodeName } from "@acpfx/core";

describe("config v2", () => {
  const standardYaml = `
nodes:
  mic:
    use: "@acpfx/mic-speaker"
    settings:
      sampleRate: 16000
      channels: 1
    outputs: [stt, recorder]
  stt:
    use: "@acpfx/stt-elevenlabs"
    settings:
      language: en
      pauseDetection: true
      pauseMs: 600
    outputs: [bridge, ui]
  bridge:
    use: "@acpfx/bridge-acpx"
    settings:
      agent: claude
      model: claude-haiku-4-5-20251001
      approveAll: true
    outputs: [tts, ui, recorder]
  tts:
    use: "@acpfx/tts-elevenlabs"
    settings:
      voiceId: JBFqnCBsd6RMkjVDRZzb
    outputs: [speaker, recorder]
  speaker:
    use: "@acpfx/play-sox"
    outputs: []
  recorder:
    use: "@acpfx/recorder"
    settings:
      outputDir: ./recordings
    outputs: []
  ui:
    use: "@acpfx/ui-cli"
    outputs: []
env:
  ELEVENLABS_API_KEY: "\${ELEVENLABS_API_KEY}"
`;

  const testYaml = `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: ./test-input.wav
      realtime: true
    outputs: [stt]
  stt:
    use: "@acpfx/stt-elevenlabs"
    settings:
      pauseDetection: true
    outputs: [bridge]
  bridge:
    use: "@acpfx/bridge-acpx"
    settings:
      agent: claude
    outputs: [tts, recorder]
  tts:
    use: "@acpfx/tts-elevenlabs"
    outputs: [play]
  play:
    use: "@acpfx/play-file"
    settings:
      path: ./test-output.wav
    outputs: []
  recorder:
    use: "@acpfx/recorder"
    settings:
      outputDir: ./recordings
    outputs: []
`;

  const conferenceYaml = `
nodes:
  caller1:
    use: "@acpfx/mic-twilio"
    settings:
      callSid: CA123
    outputs: [mixer]
  caller2:
    use: "@acpfx/mic-twilio"
    settings:
      callSid: CA456
    outputs: [mixer]
  mixer:
    use: "@acpfx/audio-mixer"
    outputs: [stt, recorder]
  stt:
    use: "@acpfx/stt-elevenlabs"
    outputs: [bridge]
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs: [tts]
  tts:
    use: "@acpfx/tts-elevenlabs"
    outputs: [recorder]
  recorder:
    use: "@acpfx/recorder"
    outputs: []
`;

  it("parses standard config", () => {
    const config = parseConfig(standardYaml);
    assert.equal(Object.keys(config.nodes).length, 7);
    assert.equal(config.nodes.mic.use, "@acpfx/mic-speaker");
    assert.deepEqual(config.nodes.mic.outputs, ["stt", "recorder"]);
    assert.equal(config.nodes.mic.settings?.sampleRate, 16000);
    assert.equal(config.env?.ELEVENLABS_API_KEY, "${ELEVENLABS_API_KEY}");
  });

  it("parses test config", () => {
    const config = parseConfig(testYaml);
    assert.equal(Object.keys(config.nodes).length, 6);
    assert.equal(config.nodes.mic.use, "@acpfx/mic-file");
    assert.equal(config.nodes.mic.settings?.realtime, true);
  });

  it("parses conference config", () => {
    const config = parseConfig(conferenceYaml);
    assert.equal(Object.keys(config.nodes).length, 7);
    assert.deepEqual(config.nodes.caller1.outputs, ["mixer"]);
    assert.deepEqual(config.nodes.caller2.outputs, ["mixer"]);
  });

  it("rejects empty config", () => {
    assert.throws(() => parseConfig(""), ConfigError);
  });

  it("rejects config without nodes", () => {
    assert.throws(() => parseConfig("env:\n  KEY: val"), ConfigError);
  });

  it("rejects node without use", () => {
    assert.throws(
      () => parseConfig("nodes:\n  mic:\n    outputs: []"),
      ConfigError,
    );
  });

  it("rejects output to undefined node", () => {
    assert.throws(
      () =>
        parseConfig(
          "nodes:\n  mic:\n    use: '@acpfx/mic-speaker'\n    outputs: [nonexistent]",
        ),
      ConfigError,
    );
  });

  it("rejects non-array outputs", () => {
    assert.throws(
      () =>
        parseConfig(
          "nodes:\n  mic:\n    use: '@acpfx/mic-speaker'\n    outputs: stt",
        ),
      ConfigError,
    );
  });

  it("accepts node with no outputs", () => {
    const config = parseConfig(
      "nodes:\n  sink:\n    use: '@acpfx/recorder'",
    );
    assert.equal(config.nodes.sink.outputs, undefined);
  });

  // --- Conditional output tests (whenFieldEquals) ---

  it("parses filtered output with whenFieldEquals", () => {
    const config = parseConfig(`
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs:
      - node: tts
        whenFieldEquals: { responseMode: "voice" }
  tts:
    use: "@acpfx/tts-deepgram"
    outputs: []
`);
    const edge = config.nodes.bridge.outputs![0];
    assert.equal(outputNodeName(edge), "tts");
    assert.equal(typeof edge, "object");
    assert.deepEqual((edge as any).whenFieldEquals, { responseMode: "voice" });
  });

  it("parses mixed plain and filtered outputs", () => {
    const config = parseConfig(`
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs:
      - stt
      - node: tts
        whenFieldEquals: { responseMode: "voice" }
      - node: phone
        whenFieldEquals: { responseMode: "text" }
  stt:
    use: echo
    outputs: []
  tts:
    use: echo
    outputs: []
  phone:
    use: echo
    outputs: []
`);
    const names = config.nodes.bridge.outputs!.map(outputNodeName);
    assert.deepEqual(names, ["stt", "tts", "phone"]);
    assert.equal(typeof config.nodes.bridge.outputs![0], "string");
    assert.equal(typeof config.nodes.bridge.outputs![1], "object");
  });

  it("rejects filtered output to undefined node", () => {
    assert.throws(
      () =>
        parseConfig(`
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs:
      - node: nonexistent
        whenFieldEquals: { responseMode: "voice" }
`),
      ConfigError,
    );
  });

  it("parses filtered output with empty whenFieldEquals", () => {
    const config = parseConfig(`
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs:
      - node: tts
        whenFieldEquals: {}
  tts:
    use: echo
    outputs: []
`);
    const edge = config.nodes.bridge.outputs![0] as any;
    assert.deepEqual(edge.whenFieldEquals, {});
  });

  it("rejects invalid output format", () => {
    assert.throws(
      () =>
        parseConfig(`
nodes:
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs:
      - 42
`),
      ConfigError,
    );
  });
});
