/**
 * UI Spec Compliance Tests
 *
 * Verifies the ratatui UI in packages/orchestrator/src/ui.rs matches
 * the plan spec (greedy-toasting-manatee.md, section 7).
 *
 * These tests read the Rust source and check structural properties.
 * They do NOT require compiling or running the binary.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve project root — works from both tests/ (source) and dist/tests/ (built)
function findRoot(dir: string): string {
  let d = dir;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(d, "packages", "orchestrator", "src", "ui.rs"))) return d;
    d = path.dirname(d);
  }
  throw new Error("Could not find project root from " + dir);
}
const ROOT = findRoot(__dirname);

const UI_RS = fs.readFileSync(
  path.resolve(ROOT, "packages/orchestrator/src/ui.rs"),
  "utf-8",
);

const MAIN_RS = fs.readFileSync(
  path.resolve(ROOT, "packages/orchestrator/src/main.rs"),
  "utf-8",
);

const ORCHESTRATOR_RS = fs.readFileSync(
  path.resolve(ROOT, "packages/orchestrator/src/orchestrator.rs"),
  "utf-8",
);

// Hardcoded node names that must NEVER appear as string literals in UI code
const FORBIDDEN_NODE_NAMES = [
  "mic",
  "mic-speaker",
  "mic-file",
  "stt",
  "stt-deepgram",
  "stt-elevenlabs",
  "bridge",
  "bridge-acpx",
  "tts",
  "tts-deepgram",
  "tts-elevenlabs",
  "audio-player",
  "play-sox",
  "play-file",
  "recorder",
  "aec-speex",
];

// Valid event categories per spec
const SPEC_CATEGORIES = [
  "audio",
  "speech",
  "agent",
  "player",
  "control",
  "lifecycle",
  "log",
];

describe("UI Spec Compliance", () => {
  // ---- Check 1: No hardcoded Pipeline/Input/Agent/Output sections ----

  it("does NOT have old hardcoded section names (Pipeline, Input, Agent, Output, Latency)", () => {
    // The old TS UI had sections named "Pipeline", "Input", "Agent", "Output", "Latency"
    // The new UI should not use these as section/block titles
    const oldSections = [
      /" Pipeline "/,
      /" Input "/,
      /" Agent "/,
      /" Output "/,
      /" Latency "/,
    ];
    for (const pattern of oldSections) {
      assert.ok(
        !pattern.test(UI_RS),
        `UI still contains old hardcoded section title: ${pattern}`,
      );
    }
  });

  // ---- Check 2: Each node gets its own bordered box ----

  it("renders a bordered Block per node from manifests (not a fixed number of sections)", () => {
    // The render function should iterate over state.manifests to create blocks
    assert.ok(
      UI_RS.includes("for (i, manifest) in state.manifests.iter().enumerate()"),
      "render_frame must iterate over manifests to create per-node blocks",
    );
    // Each node block uses Borders::ALL
    assert.ok(
      UI_RS.includes("Borders::ALL"),
      "Node blocks must have full borders",
    );
  });

  // ---- Check 3: Box headers show node name + use package + ready status ----

  it("box header includes node name, use package, and ready indicator", () => {
    // The title format should be: " {name} ({use_}) {ready_icon} "
    assert.ok(
      UI_RS.includes("manifest.name") && UI_RS.includes("manifest.use_"),
      "Block title must include manifest.name and manifest.use_",
    );
    assert.ok(
      UI_RS.includes("ready_icon") || UI_RS.includes("\\u{2713}"),
      "Block title must include ready status indicator",
    );
  });

  // ---- Check 4: Widgets driven by manifest emits_category ----

  it("audio widget is gated on manifest.emits_category('audio')", () => {
    assert.ok(
      UI_RS.includes('emits_category("audio")'),
      "Audio level meter must be conditional on manifest emitting audio category",
    );
  });

  it("speech widget is gated on manifest.emits_category('speech')", () => {
    assert.ok(
      UI_RS.includes('emits_category("speech")'),
      "Speech transcript must be conditional on manifest emitting speech category",
    );
  });

  it("agent widget is gated on manifest.emits_category('agent')", () => {
    assert.ok(
      UI_RS.includes('emits_category("agent")'),
      "Agent status must be conditional on manifest emitting agent category",
    );
  });

  it("player widget is gated on manifest.emits_category('player')", () => {
    assert.ok(
      UI_RS.includes('emits_category("player")'),
      "Player widget must be conditional on manifest emitting player category",
    );
  });

  // ---- Check 5: Category renderers match spec ----

  it("audio category renders a level meter bar", () => {
    // Should have filled/empty character rendering for level meter
    assert.ok(
      UI_RS.includes("\\u{2588}") && UI_RS.includes("\\u{2591}"),
      "Audio widget must render level meter with block characters",
    );
    assert.ok(UI_RS.includes("dB"), "Audio widget must show dB level");
  });

  it("speech category renders transcript with partial/final state", () => {
    assert.ok(
      UI_RS.includes("speech.text") || UI_RS.includes("node_state.speech.text"),
      "Speech widget must render transcript text",
    );
    assert.ok(
      UI_RS.includes("speech.state") || UI_RS.includes("node_state.speech.state"),
      "Speech widget must show partial/final state",
    );
  });

  it("agent category renders status + token count + TTFT", () => {
    assert.ok(
      UI_RS.includes("agent.tokens") || UI_RS.includes("node_state.agent.tokens"),
      "Agent widget must show token count",
    );
    assert.ok(
      UI_RS.includes("agent.ttft") || UI_RS.includes("node_state.agent.ttft"),
      "Agent widget must show TTFT",
    );
    assert.ok(
      UI_RS.includes("agent.status") || UI_RS.includes("node_state.agent.status"),
      "Agent widget must show status",
    );
  });

  it("player category renders playback state", () => {
    assert.ok(
      UI_RS.includes("ps.playing") || UI_RS.includes("node_state.player"),
      "Player widget must show playback state",
    );
  });

  it("control category renders interrupt/error alerts", () => {
    assert.ok(
      UI_RS.includes("node_state.interrupted"),
      "Control widget must show interrupt alert",
    );
    assert.ok(
      UI_RS.includes("node_state.error"),
      "Control widget must show error alert",
    );
  });

  it("lifecycle status is shown in box header (ready/done indicator)", () => {
    assert.ok(
      UI_RS.includes("node_state.done") && UI_RS.includes("node_state.ready"),
      "Lifecycle ready/done must be shown in box header",
    );
    // Lifecycle should NOT have its own emits_category gate — it's in the header
    assert.ok(
      !UI_RS.includes('emits_category("lifecycle")'),
      "Lifecycle should render in header, not as a gated widget",
    );
  });

  // ---- Check 6: Log panel at bottom ----

  it("has a dedicated Logs panel at the bottom", () => {
    assert.ok(
      UI_RS.includes('" Logs "'),
      "Must have a Logs panel title",
    );
    // Logs panel should be the last area (after all node boxes)
    assert.ok(
      UI_RS.includes("areas[num_nodes]"),
      "Log panel must render in the last layout area (after node boxes)",
    );
  });

  it("log panel shows entries from all nodes with [node_name] prefix", () => {
    assert.ok(
      UI_RS.includes("entry.from") && UI_RS.includes("entry.message"),
      "Log entries must show source node name and message",
    );
  });

  // ---- Check 7: ZERO hardcoded node names in UI source ----

  it("contains no hardcoded node names in ui.rs", () => {
    for (const name of FORBIDDEN_NODE_NAMES) {
      // Match as a quoted string literal (to avoid false positives from substrings)
      const pattern = new RegExp(`"${name.replace("-", "\\-")}"`);
      assert.ok(
        !pattern.test(UI_RS),
        `ui.rs contains hardcoded node name: "${name}"`,
      );
    }
  });

  it("contains no hardcoded node names in main.rs UI section", () => {
    // Extract just the UI-related section from main.rs
    for (const name of FORBIDDEN_NODE_NAMES) {
      const pattern = new RegExp(`"${name.replace("-", "\\-")}"`);
      // Allow "ui" as it's a flag name, not a node name
      if (name === "ui") continue;
      assert.ok(
        !pattern.test(MAIN_RS),
        `main.rs contains hardcoded node name: "${name}"`,
      );
    }
  });

  // ---- Check 8: Dashboard receives manifests as data ----

  it("UiState is initialized from manifest data (not hardcoded)", () => {
    assert.ok(
      UI_RS.includes("fn new(manifest_data: &[(String, String, Vec<String>)]"),
      "UiState::new must accept manifest data as a parameter",
    );
    assert.ok(
      UI_RS.includes("create_ui_state(manifest_data"),
      "create_ui_state must pass manifest data to UiState",
    );
  });

  // ---- Check 9: renderer (main.rs) passes manifests from orchestrator ----

  it("main.rs calls get_manifests() and passes to create_ui_state()", () => {
    assert.ok(
      MAIN_RS.includes("orch.get_manifests()"),
      "main.rs must call orchestrator.get_manifests()",
    );
    assert.ok(
      MAIN_RS.includes("ui::create_ui_state(&manifests)") ||
        MAIN_RS.includes("create_ui_state(&manifests)"),
      "main.rs must pass manifests to create_ui_state",
    );
  });

  it("orchestrator.get_manifests() returns data from DAG nodes", () => {
    assert.ok(
      ORCHESTRATOR_RS.includes("fn get_manifests("),
      "Orchestrator must have a get_manifests() method",
    );
    assert.ok(
      ORCHESTRATOR_RS.includes("n.emits.clone()"),
      "get_manifests must return emits data from DAG nodes",
    );
  });

  // ---- Check 10: --ui flag exists ----

  it("--ui flag is defined in clap CLI args", () => {
    assert.ok(
      MAIN_RS.includes("#[arg(long)]") && MAIN_RS.includes("ui: bool"),
      "Must have --ui boolean flag in CLI args",
    );
  });

  // ---- Check 11: emits_category uses event type prefix (not exact match) ----

  it("emits_category extracts category via split('.') prefix", () => {
    assert.ok(
      UI_RS.includes('e.split(\'.\').next()') || UI_RS.includes("e.split('.')"),
      "emits_category must extract category prefix from event type string",
    );
  });

  // ---- Check 12: Event dispatch uses _from, not node-name checks ----

  it("handle_event dispatches on event type and _from, not specific node names", () => {
    // handle_event should use event.get("_from") for node identification
    assert.ok(
      UI_RS.includes('event.get("_from")'),
      "handle_event must use _from for node identification",
    );
    // handle_event should use event.get("type") for event dispatch
    assert.ok(
      UI_RS.includes('event.get("type")'),
      "handle_event must use type field for event dispatch",
    );
    // There should be NO checks like: if from == "mic" or from == "stt"
    const fromChecks = UI_RS.match(/from\s*==\s*"[a-z]/g);
    assert.ok(
      fromChecks === null,
      `handle_event contains hardcoded _from checks: ${fromChecks}`,
    );
  });

  // ---- Check 13: Adding a new node requires zero UI code changes ----

  it("node rendering is fully manifest-driven (no fixed node count or assumptions)", () => {
    // The constraints vector is built dynamically from manifests
    assert.ok(
      UI_RS.includes("for manifest in &state.manifests"),
      "Layout constraints must be built dynamically from manifests",
    );
    // The log panel uses Constraint::Min (flexible, not fixed)
    assert.ok(
      UI_RS.includes("Constraint::Min"),
      "Log panel must use flexible constraint",
    );
  });

  // ---- Check 14: Build succeeds ----
  // This is verified externally by running: cargo build -p acpfx-orchestrator

  // ---- Check 15: UI renders to stderr (keeps stdout clean for NDJSON) ----

  it("UI renders to stderr, not stdout", () => {
    assert.ok(
      UI_RS.includes("io::stderr()"),
      "UI must render to stderr",
    );
    assert.ok(
      UI_RS.includes("CrosstermBackend::new(io::stderr())"),
      "Terminal backend must use stderr",
    );
  });
});
