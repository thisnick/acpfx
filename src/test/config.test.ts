import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, ConfigError } from "../config.js";

describe("config v2", () => {
  const standardYaml = `
nodes:
  mic:
    use: "@acpfx/mic-sox"
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
    assert.equal(config.nodes.mic.use, "@acpfx/mic-sox");
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
          "nodes:\n  mic:\n    use: '@acpfx/mic-sox'\n    outputs: [nonexistent]",
        ),
      ConfigError,
    );
  });

  it("rejects non-array outputs", () => {
    assert.throws(
      () =>
        parseConfig(
          "nodes:\n  mic:\n    use: '@acpfx/mic-sox'\n    outputs: stt",
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
});
