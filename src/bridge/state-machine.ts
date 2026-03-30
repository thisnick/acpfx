/**
 * Bridge state machine: IDLE → PROMPTING → STREAMING → (INTERRUPTING) → IDLE
 *
 * Manages transitions based on incoming speech/text events and controls
 * the flow between input pipeline (speech) and output pipeline (text/audio).
 */

export type BridgeState = "idle" | "prompting" | "streaming" | "interrupting";

export type BridgeTransitionEvent =
  | { kind: "speech.pause"; pendingText: string }
  | { kind: "speech.resume" }
  | { kind: "text.delta" }
  | { kind: "text.complete" }
  | { kind: "cancel.confirmed" }
  | { kind: "error" };

export type BridgeAction =
  | { type: "submit_prompt"; text: string }
  | { type: "cancel_prompt" }
  | { type: "none" };

export class BridgeStateMachine {
  private _state: BridgeState = "idle";
  private _currentRequestId: string | null = null;
  private _pendingText: string | null = null;

  get state(): BridgeState {
    return this._state;
  }

  get currentRequestId(): string | null {
    return this._currentRequestId;
  }

  setRequestId(requestId: string): void {
    this._currentRequestId = requestId;
  }

  transition(event: BridgeTransitionEvent): BridgeAction {
    switch (this._state) {
      case "idle":
        return this.fromIdle(event);
      case "prompting":
        return this.fromPrompting(event);
      case "streaming":
        return this.fromStreaming(event);
      case "interrupting":
        return this.fromInterrupting(event);
    }
  }

  private fromIdle(event: BridgeTransitionEvent): BridgeAction {
    if (event.kind === "speech.pause") {
      this._state = "prompting";
      this._pendingText = null;
      return { type: "submit_prompt", text: event.pendingText };
    }
    return { type: "none" };
  }

  private fromPrompting(event: BridgeTransitionEvent): BridgeAction {
    if (event.kind === "text.delta") {
      this._state = "streaming";
      return { type: "none" };
    }
    if (event.kind === "text.complete" || event.kind === "error") {
      this._state = "idle";
      this._currentRequestId = null;
      return { type: "none" };
    }
    if (event.kind === "speech.resume") {
      // User started speaking while we're waiting for the agent — cancel
      this._state = "interrupting";
      return { type: "cancel_prompt" };
    }
    return { type: "none" };
  }

  private fromStreaming(event: BridgeTransitionEvent): BridgeAction {
    if (event.kind === "text.complete" || event.kind === "error") {
      this._state = "idle";
      this._currentRequestId = null;
      return { type: "none" };
    }
    if (event.kind === "speech.resume") {
      // User interrupting the agent's response
      this._state = "interrupting";
      return { type: "cancel_prompt" };
    }
    if (event.kind === "speech.pause") {
      // Queue this for after interrupt settles — store the text
      this._pendingText = event.pendingText;
      return { type: "none" };
    }
    return { type: "none" };
  }

  private fromInterrupting(event: BridgeTransitionEvent): BridgeAction {
    if (event.kind === "cancel.confirmed" || event.kind === "text.complete" || event.kind === "error") {
      const pendingText = this._pendingText;
      this._pendingText = null;
      this._currentRequestId = null;

      if (pendingText) {
        // There was a queued speech.pause during interruption — submit it now
        this._state = "prompting";
        return { type: "submit_prompt", text: pendingText };
      }

      this._state = "idle";
      return { type: "none" };
    }
    if (event.kind === "speech.pause") {
      // Update pending text while still interrupting
      this._pendingText = event.pendingText;
      return { type: "none" };
    }
    return { type: "none" };
  }

  reset(): void {
    this._state = "idle";
    this._currentRequestId = null;
    this._pendingText = null;
  }
}
