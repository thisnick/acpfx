import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { BridgeStateMachine } from "../bridge/state-machine.js";

describe("BridgeStateMachine", () => {
  it("starts in idle state", () => {
    const sm = new BridgeStateMachine();
    assert.equal(sm.state, "idle");
  });

  describe("idle → prompting", () => {
    it("transitions on speech.pause and returns submit_prompt", () => {
      const sm = new BridgeStateMachine();
      const action = sm.transition({
        kind: "speech.pause",
        pendingText: "hello",
      });
      assert.equal(sm.state, "prompting");
      assert.equal(action.type, "submit_prompt");
      if (action.type === "submit_prompt") {
        assert.equal(action.text, "hello");
      }
    });

    it("ignores speech.resume in idle", () => {
      const sm = new BridgeStateMachine();
      const action = sm.transition({ kind: "speech.resume" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });

    it("ignores text.delta in idle", () => {
      const sm = new BridgeStateMachine();
      const action = sm.transition({ kind: "text.delta" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });
  });

  describe("prompting → streaming", () => {
    it("transitions on text.delta", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      const action = sm.transition({ kind: "text.delta" });
      assert.equal(sm.state, "streaming");
      assert.equal(action.type, "none");
    });
  });

  describe("prompting → idle", () => {
    it("transitions on text.complete", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      const action = sm.transition({ kind: "text.complete" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });

    it("transitions on error", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      const action = sm.transition({ kind: "error" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });
  });

  describe("prompting → interrupting", () => {
    it("transitions on speech.resume and returns cancel_prompt", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      const action = sm.transition({ kind: "speech.resume" });
      assert.equal(sm.state, "interrupting");
      assert.equal(action.type, "cancel_prompt");
    });
  });

  describe("streaming → idle", () => {
    it("transitions on text.complete", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" }); // → streaming
      const action = sm.transition({ kind: "text.complete" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });

    it("transitions on error", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" }); // → streaming
      const action = sm.transition({ kind: "error" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });
  });

  describe("streaming → interrupting", () => {
    it("transitions on speech.resume and returns cancel_prompt", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" }); // → streaming
      const action = sm.transition({ kind: "speech.resume" });
      assert.equal(sm.state, "interrupting");
      assert.equal(action.type, "cancel_prompt");
    });
  });

  describe("streaming queues speech.pause", () => {
    it("stores pending text for after interrupt", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "first" });
      sm.transition({ kind: "text.delta" }); // → streaming
      // User starts speaking (partial text arrives)
      sm.transition({ kind: "speech.pause", pendingText: "second" });
      assert.equal(sm.state, "streaming"); // stays streaming
    });
  });

  describe("interrupting → idle", () => {
    it("transitions on cancel.confirmed with no pending text", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" }); // → streaming
      sm.transition({ kind: "speech.resume" }); // → interrupting
      const action = sm.transition({ kind: "cancel.confirmed" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });

    it("transitions on text.complete with no pending text", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" }); // → streaming
      sm.transition({ kind: "speech.resume" }); // → interrupting
      const action = sm.transition({ kind: "text.complete" });
      assert.equal(sm.state, "idle");
      assert.equal(action.type, "none");
    });
  });

  describe("interrupting → prompting (with pending text)", () => {
    it("submits queued text on cancel.confirmed", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "first" });
      sm.transition({ kind: "text.delta" }); // → streaming
      sm.transition({ kind: "speech.resume" }); // → interrupting
      // New speech arrives while interrupting
      sm.transition({ kind: "speech.pause", pendingText: "second question" });
      const action = sm.transition({ kind: "cancel.confirmed" });
      assert.equal(sm.state, "prompting");
      assert.equal(action.type, "submit_prompt");
      if (action.type === "submit_prompt") {
        assert.equal(action.text, "second question");
      }
    });

    it("updates pending text during interruption", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "first" });
      sm.transition({ kind: "text.delta" }); // → streaming
      sm.transition({ kind: "speech.resume" }); // → interrupting
      sm.transition({ kind: "speech.pause", pendingText: "partial" });
      sm.transition({ kind: "speech.pause", pendingText: "final version" });
      const action = sm.transition({ kind: "cancel.confirmed" });
      assert.equal(action.type, "submit_prompt");
      if (action.type === "submit_prompt") {
        assert.equal(action.text, "final version");
      }
    });
  });

  describe("full conversation flow", () => {
    it("handles: ask → answer → interrupt → new ask → answer", () => {
      const sm = new BridgeStateMachine();

      // User asks a question
      let action = sm.transition({ kind: "speech.pause", pendingText: "what is 2+2" });
      assert.equal(sm.state, "prompting");
      assert.equal(action.type, "submit_prompt");

      // Agent starts responding
      action = sm.transition({ kind: "text.delta" });
      assert.equal(sm.state, "streaming");

      // User interrupts
      action = sm.transition({ kind: "speech.resume" });
      assert.equal(sm.state, "interrupting");
      assert.equal(action.type, "cancel_prompt");

      // User asks new question while interrupting
      action = sm.transition({ kind: "speech.pause", pendingText: "no wait, what is 3+3" });
      assert.equal(sm.state, "interrupting"); // still interrupting

      // Cancel confirmed
      action = sm.transition({ kind: "cancel.confirmed" });
      assert.equal(sm.state, "prompting");
      assert.equal(action.type, "submit_prompt");
      if (action.type === "submit_prompt") {
        assert.equal(action.text, "no wait, what is 3+3");
      }

      // Agent responds to second question
      action = sm.transition({ kind: "text.delta" });
      assert.equal(sm.state, "streaming");

      // Agent finishes
      action = sm.transition({ kind: "text.complete" });
      assert.equal(sm.state, "idle");
    });
  });

  describe("requestId tracking", () => {
    it("tracks and clears requestId", () => {
      const sm = new BridgeStateMachine();
      assert.equal(sm.currentRequestId, null);

      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.setRequestId("r1");
      assert.equal(sm.currentRequestId, "r1");

      sm.transition({ kind: "text.delta" });
      assert.equal(sm.currentRequestId, "r1");

      sm.transition({ kind: "text.complete" });
      assert.equal(sm.currentRequestId, null);
      assert.equal(sm.state, "idle");
    });
  });

  describe("reset", () => {
    it("returns to idle state", () => {
      const sm = new BridgeStateMachine();
      sm.transition({ kind: "speech.pause", pendingText: "hi" });
      sm.transition({ kind: "text.delta" });
      sm.setRequestId("r1");
      assert.equal(sm.state, "streaming");

      sm.reset();
      assert.equal(sm.state, "idle");
      assert.equal(sm.currentRequestId, null);
    });
  });
});
