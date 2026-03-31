/**
 * acpfx bridge — Central orchestrator that connects speech events to an ACP agent.
 *
 * In --raw mode: reads speech events from stdin, submits to acpx queue owner,
 * writes text events to stdout. No sub-pipeline spawning.
 *
 * In default mode: spawns input pipeline (mic | stt | vad) and output pipeline
 * (tts | play), reads speech events from input, writes text/control to output,
 * and forwards control events bidirectionally.
 */

import { randomUUID } from "node:crypto";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type { AnyEvent, SpeechPauseEvent } from "../protocol.js";
import { AcpxIpcClient, resolveSessionId } from "../bridge/acpx-ipc.js";
import { BridgeStateMachine } from "../bridge/state-machine.js";
import { startPipelines } from "../bridge/pipeline-manager.js";

export type BridgeOptions = {
  raw?: boolean;
  verbose?: boolean;
  input?: string;
  output?: string;
  model?: string;
  approveAll?: boolean;
  acpxArgs?: string;
};

export async function runBridge(
  agentName: string,
  opts: BridgeOptions,
): Promise<void> {
  if (opts.raw) {
    await runBridgeRaw(agentName, opts);
  } else {
    await runBridgeOrchestrated(agentName, opts);
  }
}

// --- Orchestrated mode: spawns input/output pipelines ---

async function runBridgeOrchestrated(
  agentName: string,
  opts: BridgeOptions,
): Promise<void> {
  const verbose = opts.verbose ?? false;
  const sm = new BridgeStateMachine();

  // Resolve session ID for the agent
  const resolvedSessionId = await resolveSessionId(agentName);
  if (!resolvedSessionId) {
    process.stderr.write(
      `[acpfx:bridge] No active acpx session found for agent "${agentName}". ` +
      `Start one with: acpx ${agentName} "hello"\n`,
    );
    process.exit(1);
  }
  const sessionId: string = resolvedSessionId;

  const ipc = new AcpxIpcClient(sessionId, { verbose });
  let activeAbort: AbortController | null = null;

  if (verbose) {
    process.stderr.write(
      `[acpfx:bridge] connected to session ${sessionId} for agent "${agentName}"\n`,
    );
  }

  // Spawn pipelines
  const pipelines = startPipelines({
    input: opts.input,
    output: opts.output,
    verbose,
  });

  async function handleSubmitPrompt(text: string): Promise<void> {
    const requestId = randomUUID();
    sm.setRequestId(requestId);
    activeAbort = new AbortController();

    await pipelines.writeToOutput({
      type: "control.state",
      state: "processing",
    });

    try {
      await ipc.submitPrompt({
        sessionId,
        text,
        signal: activeAbort.signal,
        onTextDelta: (delta, seq) => {
          sm.transition({ kind: "text.delta" });
          pipelines.writeToOutput({
            type: "text.delta",
            requestId,
            delta,
            seq,
          });
        },
        onComplete: (fullText) => {
          const action = sm.transition({ kind: "text.complete" });
          pipelines.writeToOutput({
            type: "text.complete",
            requestId,
            text: fullText,
          });

          pipelines.writeToOutput({
            type: "control.state",
            state: "listening",
          });

          // Notify input pipeline we're listening again
          pipelines.writeToInput({
            type: "control.state",
            state: "listening",
          });

          activeAbort = null;

          if (action.type === "submit_prompt") {
            handleSubmitPrompt(action.text);
          }
        },
        onError: (error) => {
          const action = sm.transition({ kind: "error" });
          pipelines.writeToOutput({
            type: "control.error",
            message: error.message,
            source: "bridge",
          });
          activeAbort = null;

          if (action.type === "submit_prompt") {
            handleSubmitPrompt(action.text);
          }
        },
      });
    } catch (error) {
      const action = sm.transition({ kind: "error" });
      await pipelines.writeToOutput({
        type: "control.error",
        message: error instanceof Error ? error.message : String(error),
        source: "bridge",
      });
      activeAbort = null;

      if (action.type === "submit_prompt") {
        await handleSubmitPrompt(action.text);
      }
    }
  }

  async function handleCancelPrompt(): Promise<void> {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }

    const requestId = sm.currentRequestId;
    if (requestId) {
      // Forward interrupt to output pipeline (stops TTS/play)
      await pipelines.writeToOutput({
        type: "control.interrupt",
        requestId,
        reason: "user_speech",
      });
    }

    try {
      const result = await ipc.cancelPrompt();
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] cancel result: ${result.cancelled}\n`,
        );
      }
    } catch (error) {
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] cancel error: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    }

    const action = sm.transition({ kind: "cancel.confirmed" });
    if (action.type === "submit_prompt") {
      await handleSubmitPrompt(action.text);
    }
  }

  // Handle events from input pipeline (speech events)
  pipelines.onInputEvent(async (event: AnyEvent) => {
    if (event.type === "speech.pause") {
      const speechEvent = event as SpeechPauseEvent;
      const action = sm.transition({
        kind: "speech.pause",
        pendingText: speechEvent.pendingText,
      });

      if (action.type === "submit_prompt") {
        await handleSubmitPrompt(action.text);
      }
      return;
    }

    if (event.type === "speech.resume") {
      const action = sm.transition({ kind: "speech.resume" });

      if (action.type === "cancel_prompt") {
        await handleCancelPrompt();
      }
      return;
    }

    // Forward other input events to output pipeline if relevant
    // (e.g., audio.chunk for echo cancellation in the future)
  });

  // Handle events from output pipeline (feedback events)
  pipelines.onOutputEvent(async (event: AnyEvent) => {
    if (event.type === "control.state") {
      // Forward state changes to input pipeline
      await pipelines.writeToInput(event);
      return;
    }

    if (verbose) {
      process.stderr.write(
        `[acpfx:bridge] output feedback: ${JSON.stringify(event)}\n`,
      );
    }
  });

  // Notify input pipeline we're ready
  await pipelines.writeToInput({
    type: "control.state",
    state: "listening",
  });

  if (verbose) {
    process.stderr.write("[acpfx:bridge] pipelines started, listening...\n");
  }

  // Wait for input pipeline to finish (user stopped mic, stdin closed, etc.)
  await pipelines.inputDone;

  // Shut down everything
  await pipelines.shutdown();
}

// --- Raw mode: reads from stdin, writes to stdout ---

async function runBridgeRaw(
  agentName: string,
  opts: BridgeOptions,
): Promise<void> {
  const verbose = opts.verbose ?? false;
  const writer = createEventWriter(process.stdout);
  const sm = new BridgeStateMachine();

  // Resolve session ID for the agent
  const resolvedSessionId = await resolveSessionId(agentName);
  if (!resolvedSessionId) {
    await writer.write({
      type: "control.error",
      message: `No active acpx session found for agent "${agentName}". Start one with: acpx ${agentName} "hello"`,
      source: "bridge",
    });
    await writer.end();
    process.exit(1);
  }
  const sessionId: string = resolvedSessionId;

  const ipc = new AcpxIpcClient(sessionId, { verbose });
  let activeAbort: AbortController | null = null;

  if (verbose) {
    process.stderr.write(
      `[acpfx:bridge] connected to session ${sessionId} for agent "${agentName}"\n`,
    );
  }

  async function handleSubmitPrompt(text: string): Promise<void> {
    const requestId = randomUUID();
    sm.setRequestId(requestId);
    activeAbort = new AbortController();

    await writer.write({
      type: "control.state",
      state: "processing",
    });

    try {
      await ipc.submitPrompt({
        sessionId,
        text,
        signal: activeAbort.signal,
        onTextDelta: (delta, seq) => {
          sm.transition({ kind: "text.delta" });
          writer.write({
            type: "text.delta",
            requestId,
            delta,
            seq,
          });
        },
        onComplete: (fullText) => {
          const action = sm.transition({ kind: "text.complete" });
          writer.write({
            type: "text.complete",
            requestId,
            text: fullText,
          });

          writer.write({
            type: "control.state",
            state: "listening",
          });

          activeAbort = null;

          // If the state machine wants to submit another prompt (queued during interrupt)
          if (action.type === "submit_prompt") {
            handleSubmitPrompt(action.text);
          }
        },
        onError: (error) => {
          const action = sm.transition({ kind: "error" });
          writer.write({
            type: "control.error",
            message: error.message,
            source: "bridge",
          });
          activeAbort = null;

          if (action.type === "submit_prompt") {
            handleSubmitPrompt(action.text);
          }
        },
      });
    } catch (error) {
      const action = sm.transition({ kind: "error" });
      await writer.write({
        type: "control.error",
        message: error instanceof Error ? error.message : String(error),
        source: "bridge",
      });
      activeAbort = null;

      if (action.type === "submit_prompt") {
        await handleSubmitPrompt(action.text);
      }
    }
  }

  async function handleCancelPrompt(): Promise<void> {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }

    const requestId = sm.currentRequestId;
    if (requestId) {
      await writer.write({
        type: "control.interrupt",
        requestId,
        reason: "user_speech",
      });
    }

    try {
      const result = await ipc.cancelPrompt();
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] cancel result: ${result.cancelled}\n`,
        );
      }
    } catch (error) {
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] cancel error: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    }

    const action = sm.transition({ kind: "cancel.confirmed" });
    if (action.type === "submit_prompt") {
      await handleSubmitPrompt(action.text);
    }
  }

  // Read events from stdin
  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "speech.pause") {
        const speechEvent = event as SpeechPauseEvent;
        const action = sm.transition({
          kind: "speech.pause",
          pendingText: speechEvent.pendingText,
        });

        if (action.type === "submit_prompt") {
          await handleSubmitPrompt(action.text);
        }
        return;
      }

      if (event.type === "speech.resume") {
        const action = sm.transition({ kind: "speech.resume" });

        if (action.type === "cancel_prompt") {
          await handleCancelPrompt();
        }
        return;
      }

      // Forward unknown events unchanged
      await writer.write(event);
    },
    async (error: Error, line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "bridge",
      });
    },
  );

  await writer.end();
}
