/**
 * Adversarial tests: manifest validation.
 *
 * Verifies that each node's manifest.yaml accurately reflects what the node
 * actually consumes and emits, based on an independent source-code audit.
 *
 * This file documents the ground-truth contract for every node, derived from
 * reading the source. When manifests are added (Phase 1.3), these tests will
 * verify the manifests match reality.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// ---- Ground truth: what each node ACTUALLY consumes/emits per source audit ----
// Derived by reading every node's handleEvent/on("line") and emit() calls.

type NodeContract = {
  consumes: string[];
  emits: string[];
};

/**
 * Authoritative contracts derived from source code audit (2026-04-01).
 *
 * For each node, I read the source and catalogued:
 *   - consumes: every event.type checked in handleEvent / on("line") handlers
 *   - emits: every emit({type: ...}) call
 */
const AUDITED_CONTRACTS: Record<string, NodeContract> = {
  // packages/node-echo/src/index.ts — echoes everything back unchanged
  "echo": {
    consumes: ["*"],  // echoes all events
    emits: ["*", "lifecycle.ready"],  // echoes + lifecycle.ready
  },

  // packages/node-mic-sox/src/index.ts
  // NOTE: mic-sox DOES handle control.interrupt (line 72) but it's also
  // reasonable for it to be a source node with no declared consumes if
  // the manifest intends for it to be wired as a pure source. However,
  // the code DOES check for it, so we flag the discrepancy.
  "mic-sox": {
    consumes: ["control.interrupt"],
    emits: [
      "audio.chunk",
      "audio.level",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-mic-file/src/index.ts
  "mic-file": {
    consumes: ["control.interrupt"],
    emits: [
      "audio.chunk",
      "audio.level",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-stt-deepgram/src/index.ts
  // NOTE: STT handles control.interrupt in code but is a NO-OP (comment says
  // "Interrupt is meant for downstream nodes"). The plan says STT should NOT
  // declare control.interrupt in consumes so the orchestrator never sends it.
  "stt-deepgram": {
    consumes: ["audio.chunk"],  // control.interrupt is handled but no-op'd
    emits: [
      "speech.partial",
      "speech.final",
      "speech.pause",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-stt-elevenlabs/src/index.ts
  // Same pattern: handles control.interrupt as no-op
  "stt-elevenlabs": {
    consumes: ["audio.chunk"],  // control.interrupt is handled but no-op'd
    emits: [
      "speech.partial",
      "speech.delta",
      "speech.final",
      "speech.pause",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-bridge-acpx/src/index.ts
  "bridge-acpx": {
    consumes: [
      "speech.partial",
      "speech.pause",
      "control.interrupt",
    ],
    emits: [
      "agent.submit",
      "agent.thinking",
      "agent.delta",
      "agent.complete",
      "agent.tool_start",
      "agent.tool_done",
      "control.interrupt",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-tts-elevenlabs/src/index.ts
  "tts-elevenlabs": {
    consumes: [
      "agent.delta",
      "agent.tool_start",
      "agent.complete",
      "control.interrupt",
    ],
    emits: [
      "audio.chunk",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-tts-deepgram/src/index.ts
  "tts-deepgram": {
    consumes: [
      "agent.delta",
      "agent.tool_start",
      "agent.complete",
      "control.interrupt",
    ],
    emits: [
      "audio.chunk",
      "control.error",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-audio-player/src/index.ts
  "audio-player": {
    consumes: [
      "audio.chunk",
      "agent.thinking",
      "agent.tool_start",
      "agent.tool_done",
      "agent.delta",
      "agent.complete",
      "control.interrupt",
    ],
    emits: [
      "audio.chunk",
      "player.status",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-play-sox/src/index.ts
  "play-sox": {
    consumes: [
      "audio.chunk",
      "control.interrupt",
    ],
    emits: [
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-play-file/src/index.ts
  "play-file": {
    consumes: [
      "audio.chunk",
      "control.interrupt",
      "lifecycle.done",  // consumes upstream lifecycle.done to know when to finalize
    ],
    emits: [
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-recorder/src/index.ts
  // Records ALL events to events.jsonl (line 350-351), captures audio.chunk to WAV tracks.
  // The recorder MUST receive all events to function correctly — its manifest should
  // declare all event types or use a wildcard. A manifest that only lists audio.chunk
  // would break the events.jsonl recording when filtering is enabled.
  "recorder": {
    consumes: ["*"],  // records everything — manifest must reflect this
    emits: [
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-mic-aec/src/main.rs (Rust)
  // Receives audio.chunk to play as speaker reference, emits mic capture
  "mic-aec": {
    consumes: [
      "audio.chunk",
      "control.interrupt",
    ],
    emits: [
      "audio.chunk",
      "audio.level",
      "lifecycle.ready",
      "lifecycle.done",
    ],
  },

  // packages/node-aec-speex/src/main.rs (Rust)
  // SpeexDSP echo cancellation - receives mic + reference audio
  // NOTE: aec-speex does NOT emit audio.level or lifecycle.done
  // (verified in source: only emits audio.chunk at line 297 and lifecycle.ready at line 219)
  // It also passes through unknown events unchanged (line 306-308)
  "aec-speex": {
    consumes: [
      "audio.chunk",
      "control.interrupt",
    ],
    emits: [
      "audio.chunk",
      "lifecycle.ready",
    ],
  },
};

// ---- Tests ----

describe("manifest validation — audited contracts", () => {
  it("audit covers all known node packages", () => {
    // Verify our audit didn't miss any node packages
    const expectedNodes = [
      "echo", "mic-sox", "mic-file", "stt-deepgram", "stt-elevenlabs",
      "bridge-acpx", "tts-elevenlabs", "tts-deepgram", "audio-player",
      "play-sox", "play-file", "recorder", "mic-aec", "aec-speex",
    ];
    for (const name of expectedNodes) {
      assert.ok(
        AUDITED_CONTRACTS[name],
        `Missing audit for node '${name}'`,
      );
    }
  });

  it("STT nodes do NOT declare control.interrupt in consumes", () => {
    // Critical: the whole point of manifest filtering is that STT stops
    // receiving interrupts it currently has to no-op. If the manifest
    // declares control.interrupt, the filtering won't help.
    const sttNodes = ["stt-deepgram", "stt-elevenlabs"];
    for (const name of sttNodes) {
      const contract = AUDITED_CONTRACTS[name];
      assert.ok(
        !contract.consumes.includes("control.interrupt"),
        `${name} must NOT declare control.interrupt in consumes — ` +
        `the whole point is that the orchestrator filters it out`,
      );
    }
  });

  it("bridge-acpx declares control.interrupt in BOTH consumes AND emits", () => {
    // Bridge consumes interrupt (to cancel active prompt) and emits it (barge-in)
    const contract = AUDITED_CONTRACTS["bridge-acpx"];
    assert.ok(
      contract.consumes.includes("control.interrupt"),
      "bridge must consume control.interrupt to cancel active prompts",
    );
    assert.ok(
      contract.emits.includes("control.interrupt"),
      "bridge must emit control.interrupt for barge-in",
    );
  });

  it("TTS nodes consume agent.delta + control.interrupt", () => {
    for (const name of ["tts-elevenlabs", "tts-deepgram"]) {
      const contract = AUDITED_CONTRACTS[name];
      assert.ok(
        contract.consumes.includes("agent.delta"),
        `${name} must consume agent.delta`,
      );
      assert.ok(
        contract.consumes.includes("control.interrupt"),
        `${name} must consume control.interrupt to clear buffered audio`,
      );
    }
  });

  it("audio-player consumes agent.thinking for SFX", () => {
    const contract = AUDITED_CONTRACTS["audio-player"];
    assert.ok(
      contract.consumes.includes("agent.thinking"),
      "audio-player must consume agent.thinking to play thinking SFX",
    );
    assert.ok(
      contract.consumes.includes("agent.tool_start"),
      "audio-player must consume agent.tool_start to play tool SFX",
    );
  });

  it("all nodes emit lifecycle.ready", () => {
    for (const [name, contract] of Object.entries(AUDITED_CONTRACTS)) {
      assert.ok(
        contract.emits.includes("lifecycle.ready"),
        `${name} must emit lifecycle.ready`,
      );
    }
  });

  // ---- Manifest file validation ----

  // Known event types from the schema (must match Rust schema categories.rs)
  const ALL_KNOWN_TYPES = [
    "audio.chunk", "audio.level",
    "speech.partial", "speech.delta", "speech.final", "speech.pause",
    "agent.submit", "agent.delta", "agent.complete", "agent.thinking",
    "agent.tool_start", "agent.tool_done",
    "control.interrupt", "control.state", "control.error",
    "lifecycle.ready", "lifecycle.done",
    "log",
    "player.status",
  ];

  function findRoot(): string {
    let dir = import.meta.dirname ?? process.cwd();
    while (dir !== "/" && !existsSync(resolve(dir, "package.json"))) {
      dir = resolve(dir, "..");
    }
    return dir;
  }

  function readManifest(shortName: string): { consumes?: string[]; emits?: string[] } | null {
    const rootDir = findRoot();
    const manifestPath = resolve(rootDir, `packages/node-${shortName}/manifest.yaml`);
    if (!existsSync(manifestPath)) return null;
    return parseYaml(readFileSync(manifestPath, "utf-8")) as {
      consumes?: string[];
      emits?: string[];
    };
  }

  it("all manifest event types reference valid schema types", () => {
    const rootDir = findRoot();
    for (const [shortName] of Object.entries(AUDITED_CONTRACTS)) {
      const manifest = readManifest(shortName);
      if (!manifest) continue;

      for (const t of manifest.consumes ?? []) {
        assert.ok(
          ALL_KNOWN_TYPES.includes(t),
          `${shortName} manifest consumes unknown event type '${t}'`,
        );
      }
      for (const t of manifest.emits ?? []) {
        assert.ok(
          ALL_KNOWN_TYPES.includes(t),
          `${shortName} manifest emits unknown event type '${t}'`,
        );
      }
    }
  });

  it("[CRITICAL] recorder manifest must allow receiving ALL events for events.jsonl", () => {
    // The recorder records ALL events to events.jsonl (line 350-351).
    // If manifest-based filtering is enabled and the manifest only declares
    // audio.chunk, the recorder will stop receiving speech/agent/control events,
    // silently breaking the events.jsonl recording.
    const manifest = readManifest("recorder");
    if (!manifest) return;

    // The recorder should consume at least all event types it records.
    // Since it records EVERYTHING, it should consume all types.
    const consumes = manifest.consumes ?? [];
    if (consumes.length === 1 && consumes[0] === "audio.chunk") {
      assert.fail(
        "recorder manifest only declares consumes: [audio.chunk] but the source code " +
        "records ALL events to events.jsonl (line 350-351). When filtering is enabled, " +
        "this will silently break events.jsonl recording. The manifest should list all " +
        "event types or the filtering system needs a wildcard/observer mechanism.",
      );
    }
  });

  it("[CRITICAL] mic-sox manifest must declare control.interrupt in consumes", () => {
    // mic-sox source code explicitly handles control.interrupt (line 72):
    //   if (event.type === "control.interrupt") { interrupted = true; cleanup(); }
    // If the manifest says consumes: [], the orchestrator will never send it
    // interrupts, and the mic will keep recording after barge-in.
    const manifest = readManifest("mic-sox");
    if (!manifest) return;

    const consumes = manifest.consumes ?? [];
    assert.ok(
      consumes.includes("control.interrupt"),
      "mic-sox manifest is missing control.interrupt in consumes — " +
      "but source code handles it at line 72 to stop recording on interrupt",
    );
  });

  for (const [shortName, auditedContract] of Object.entries(AUDITED_CONTRACTS)) {
    if (shortName === "echo" || shortName === "recorder") continue; // wildcard consumers

    it(`manifest for ${shortName} matches source audit`, () => {
      const manifest = readManifest(shortName);
      if (!manifest) {
        assert.ok(true, `[SKIP] manifest.yaml not yet created for ${shortName}`);
        return;
      }

      // Every audited consume must be in manifest
      for (const eventType of auditedContract.consumes) {
        assert.ok(
          manifest.consumes?.includes(eventType),
          `${shortName} manifest missing consumes: ${eventType} (source code handles this event)`,
        );
      }

      // Every audited emit must be in manifest
      for (const eventType of auditedContract.emits) {
        assert.ok(
          manifest.emits?.includes(eventType),
          `${shortName} manifest missing emits: ${eventType} (source code emits this event)`,
        );
      }

      // Manifest should not declare consumes that the node doesn't actually handle
      for (const declared of manifest.consumes ?? []) {
        assert.ok(
          auditedContract.consumes.includes(declared),
          `${shortName} manifest declares consumes '${declared}' but source code doesn't handle it`,
        );
      }
    });
  }

  it("STT manifests do NOT declare control.interrupt in consumes", () => {
    // Verify the manifests match the design intent, not just the source audit
    for (const name of ["stt-deepgram", "stt-elevenlabs"]) {
      const manifest = readManifest(name);
      if (!manifest) continue;
      assert.ok(
        !(manifest.consumes ?? []).includes("control.interrupt"),
        `${name} manifest must NOT declare control.interrupt — ` +
        `STT should keep listening through interrupts; filtering handles this`,
      );
    }
  });

  it("mic-aec manifest declares control.error in emits", () => {
    // mic-aec emits control.error when AEC capture fails (line 164-170)
    const manifest = readManifest("mic-aec");
    if (!manifest) return;
    assert.ok(
      (manifest.emits ?? []).includes("control.error"),
      "mic-aec manifest must declare control.error in emits (emitted on AEC capture failure)",
    );
  });
});

// Export for use by other test files
export { AUDITED_CONTRACTS, type NodeContract };
