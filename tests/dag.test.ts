import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, buildDag } from "@acpfx/core";

describe("dag v2", () => {
  it("builds a valid DAG from standard config", () => {
    const config = parseConfig(`
nodes:
  mic:
    use: "@acpfx/mic-sox"
    outputs: [stt]
  stt:
    use: "@acpfx/stt-elevenlabs"
    outputs: [bridge]
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs: [tts]
  tts:
    use: "@acpfx/tts-elevenlabs"
    outputs: [speaker]
  speaker:
    use: "@acpfx/play-sox"
    outputs: []
`);
    const dag = buildDag(config);
    assert.equal(dag.nodes.size, 5);
    assert.deepEqual(dag.order, ["mic", "stt", "bridge", "tts", "speaker"]);
  });

  it("handles fan-out (one node to multiple)", () => {
    const config = parseConfig(`
nodes:
  mic:
    use: "@acpfx/mic-sox"
    outputs: [stt, recorder]
  stt:
    use: "@acpfx/stt-elevenlabs"
    outputs: []
  recorder:
    use: "@acpfx/recorder"
    outputs: []
`);
    const dag = buildDag(config);
    assert.equal(dag.order[0], "mic");
    assert.ok(dag.order.indexOf("stt") > 0);
    assert.ok(dag.order.indexOf("recorder") > 0);
  });

  it("handles fan-in (multiple nodes to one)", () => {
    const config = parseConfig(`
nodes:
  caller1:
    use: "@acpfx/mic-twilio"
    outputs: [mixer]
  caller2:
    use: "@acpfx/mic-twilio"
    outputs: [mixer]
  mixer:
    use: "@acpfx/audio-mixer"
    outputs: []
`);
    const dag = buildDag(config);
    // mixer must come after both callers
    assert.ok(dag.order.indexOf("mixer") > dag.order.indexOf("caller1"));
    assert.ok(dag.order.indexOf("mixer") > dag.order.indexOf("caller2"));
  });

  it("allows a simple cycle (A→B→A)", () => {
    const config = parseConfig(`
nodes:
  a:
    use: "@acpfx/node-a"
    outputs: [b]
  b:
    use: "@acpfx/node-b"
    outputs: [a]
`);
    const dag = buildDag(config);
    assert.equal(dag.nodes.size, 2);
    // Both nodes in a cycle — appended in config declaration order
    assert.deepEqual(dag.order, ["a", "b"]);
  });

  it("allows a longer cycle (A→B→C→A)", () => {
    const config = parseConfig(`
nodes:
  a:
    use: "@acpfx/node-a"
    outputs: [b]
  b:
    use: "@acpfx/node-b"
    outputs: [c]
  c:
    use: "@acpfx/node-c"
    outputs: [a]
`);
    const dag = buildDag(config);
    assert.equal(dag.nodes.size, 3);
    assert.deepEqual(dag.order, ["a", "b", "c"]);
  });

  it("places non-cycle nodes before cycle nodes", () => {
    const config = parseConfig(`
nodes:
  mic:
    use: "@acpfx/mic-sox"
    outputs: [aec]
  aec:
    use: "@acpfx/aec-speex"
    outputs: [stt]
  stt:
    use: "@acpfx/stt-elevenlabs"
    outputs: []
  player:
    use: "@acpfx/play-sox"
    outputs: [aec]
`);
    const dag = buildDag(config);
    // mic and stt have no incoming cycle edges — they get topo-sorted first
    // aec and player form a mutual dependency via aec→stt (no), actually:
    // mic→aec, player→aec means aec has in-degree 2, stt has in-degree 1 from aec
    // player has in-degree 0 → sorted first along with mic
    // Then aec (in-degree drops to 0 after mic+player processed) → then stt
    assert.equal(dag.nodes.size, 4);
    // mic and player are sources (in-degree 0), sorted alphabetically
    assert.ok(dag.order.indexOf("mic") < dag.order.indexOf("aec"));
    assert.ok(dag.order.indexOf("player") < dag.order.indexOf("aec"));
    assert.ok(dag.order.indexOf("aec") < dag.order.indexOf("stt"));
  });

  it("computes downstream sets for interrupt propagation", () => {
    const config = parseConfig(`
nodes:
  mic:
    use: "@acpfx/mic-sox"
    outputs: [stt]
  stt:
    use: "@acpfx/stt-elevenlabs"
    outputs: [bridge]
  bridge:
    use: "@acpfx/bridge-acpx"
    outputs: [tts, recorder]
  tts:
    use: "@acpfx/tts-elevenlabs"
    outputs: [speaker]
  speaker:
    use: "@acpfx/play-sox"
    outputs: []
  recorder:
    use: "@acpfx/recorder"
    outputs: []
`);
    const dag = buildDag(config);

    // downstream of bridge: tts, speaker, recorder
    const bridgeDown = dag.downstream.get("bridge")!;
    assert.ok(bridgeDown.has("tts"));
    assert.ok(bridgeDown.has("speaker"));
    assert.ok(bridgeDown.has("recorder"));
    assert.ok(!bridgeDown.has("mic"));
    assert.ok(!bridgeDown.has("stt"));
    assert.ok(!bridgeDown.has("bridge")); // not itself

    // downstream of mic: everything except mic
    const micDown = dag.downstream.get("mic")!;
    assert.equal(micDown.size, 5);

    // downstream of speaker: nothing
    const speakerDown = dag.downstream.get("speaker")!;
    assert.equal(speakerDown.size, 0);
  });

  it("produces deterministic topological order", () => {
    const config = parseConfig(`
nodes:
  z:
    use: "@acpfx/node-z"
    outputs: []
  a:
    use: "@acpfx/node-a"
    outputs: []
  m:
    use: "@acpfx/node-m"
    outputs: []
`);
    const dag = buildDag(config);
    // All are sources, sorted alphabetically
    assert.deepEqual(dag.order, ["a", "m", "z"]);
  });
});
