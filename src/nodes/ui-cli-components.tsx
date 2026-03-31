/**
 * ui-cli — Ink-based terminal dashboard for the acpfx pipeline.
 *
 * 5 sections: PipelineStatus, InputSection, AgentSection, OutputSection, LatencyBar.
 * Each receives events from stdin and renders independently.
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text } from "ink";
import { createInterface } from "node:readline";

// ---- Types ----

type NodeState = { name: string; ready: boolean };
type PipelineState = "Listening" | "Processing" | "Streaming" | "Speaking" | "Interrupted";

// ---- Components ----

function PipelineStatus({
  state,
  nodes,
  error,
}: {
  state: PipelineState;
  nodes: NodeState[];
  error: string | null;
}) {
  const stateIcons: Record<PipelineState, string> = {
    Listening: "Listening",
    Processing: "Processing",
    Streaming: "Streaming",
    Speaking: "Speaking",
    Interrupted: "Interrupted",
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
      <Text bold color="blue"> Pipeline </Text>
      <Text>
        State: {stateIcons[state]}
      </Text>
      <Text>
        Nodes:{" "}
        {nodes.map((n, i) => (
          <Text key={n.name}>
            {n.ready ? "+" : "?"}{n.name}{i < nodes.length - 1 ? "  " : ""}
          </Text>
        ))}
      </Text>
      {error && <Text color="red">Error: {error}</Text>}
    </Box>
  );
}

function InputSection({
  rms,
  dbfs,
  sttText,
  sttState,
}: {
  rms: number;
  dbfs: number;
  sttText: string;
  sttState: "partial" | "final" | "idle";
}) {
  // Level meter: 20 chars, scale RMS 0-32768
  const level = Math.min(20, Math.round((rms / 32768) * 20));
  const filled = "=".repeat(level);
  const empty = "-".repeat(20 - level);
  const meter = `[${filled}${empty}]`;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
      <Text bold color="green"> Input </Text>
      <Text>
        Mic: {meter} {dbfs === -Infinity ? "-inf" : dbfs.toFixed(1)} dBFS
      </Text>
      <Text>
        STT: &quot;{sttText}&quot;
        {sttState === "partial" ? " (partial)" : sttState === "final" ? " (final)" : ""}
      </Text>
    </Box>
  );
}

function AgentSection({
  status,
  text,
  tokens,
  ttft,
  elapsed,
}: {
  status: "idle" | "waiting" | "streaming" | "complete";
  text: string;
  tokens: number;
  ttft: number | null;
  elapsed: number;
}) {
  const statusText =
    status === "idle"
      ? "Idle"
      : status === "waiting"
        ? `Waiting... (${(elapsed / 1000).toFixed(1)}s)`
        : status === "streaming"
          ? `Streaming... (${(elapsed / 1000).toFixed(1)}s)`
          : "Complete";

  // Show last ~200 chars of agent text
  const displayText = text.length > 200 ? "..." + text.slice(-200) : text;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan"> Agent </Text>
      <Text>Status: {statusText}</Text>
      {text && <Text>&gt; {displayText}</Text>}
      <Text>
        Tokens: {tokens}
        {ttft !== null ? `  TTFT: ${(ttft / 1000).toFixed(1)}s` : ""}
      </Text>
    </Box>
  );
}

function OutputSection({
  chunksReceived,
  durationMs,
}: {
  chunksReceived: number;
  durationMs: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow"> Output </Text>
      <Text>
        TTS: {chunksReceived} chunks ({(durationMs / 1000).toFixed(1)}s audio)
      </Text>
    </Box>
  );
}

function LatencyBar({
  sttMs,
  vadMs,
  agentMs,
  ttsMs,
}: {
  sttMs: number | null;
  vadMs: number | null;
  agentMs: number | null;
  ttsMs: number | null;
}) {
  const parts: string[] = [];
  if (sttMs !== null) parts.push(`STT: ${sttMs}ms`);
  if (vadMs !== null) parts.push(`VAD: ${vadMs}ms`);
  if (agentMs !== null) parts.push(`Agent: ${(agentMs / 1000).toFixed(1)}s`);
  if (ttsMs !== null) parts.push(`TTS: ${ttsMs}ms`);

  const total =
    (sttMs ?? 0) + (vadMs ?? 0) + (agentMs ?? 0) + (ttsMs ?? 0);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta"> Latency </Text>
      <Text>{parts.length > 0 ? parts.join(" -> ") : "No data yet"}</Text>
      {total > 0 && (
        <Text>
          End-to-end: {(total / 1000).toFixed(2)}s
        </Text>
      )}
    </Box>
  );
}

// ---- Dashboard (top-level) ----

export function Dashboard({ eventStream }: { eventStream: AsyncIterable<Record<string, unknown>> }) {
  const [pipelineState, setPipelineState] = useState<PipelineState>("Listening");
  const [nodes, setNodes] = useState<NodeState[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Input
  const [rms, setRms] = useState(0);
  const [dbfs, setDbfs] = useState(-Infinity);
  const [sttText, setSttText] = useState("");
  const [sttState, setSttState] = useState<"partial" | "final" | "idle">("idle");

  // Agent
  const [agentStatus, setAgentStatus] = useState<"idle" | "waiting" | "streaming" | "complete">("idle");
  const [agentText, setAgentText] = useState("");
  const [tokens, setTokens] = useState(0);
  const [ttft, setTtft] = useState<number | null>(null);
  const [agentElapsed, setAgentElapsed] = useState(0);
  // submitTime and firstDeltaTime moved to refs (see below)

  // Output
  const [ttsChunks, setTtsChunks] = useState(0);
  const [ttsDurationMs, setTtsDurationMs] = useState(0);

  // Latency
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [vadMs, setVadMs] = useState<number | null>(null);
  const [agentMs, setAgentMs] = useState<number | null>(null);
  const [ttsMs, setTtsMs] = useState<number | null>(null);

  // Timing refs (refs, not state — need synchronous reads within event loop)
  const lastSpeechFinalTsRef = useRef<number | null>(null);
  const lastSpeechPauseTsRef = useRef<number | null>(null);
  const submitTimeRef = useRef<number | null>(null);
  const firstDeltaTimeRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      for await (const event of eventStream) {
        if (!mounted) break;
        const type = event.type as string;
        const ts = (event.ts as number) ?? Date.now();

        switch (type) {
          case "lifecycle.ready": {
            // Use _from (config node name) not component (implementation name)
            const name = (event._from as string) ?? (event.component as string) ?? "?";
            setNodes((prev) => {
              const existing = prev.find((n) => n.name === name);
              if (existing) {
                return prev.map((n) =>
                  n.name === name ? { ...n, ready: true } : n,
                );
              }
              return [...prev, { name, ready: true }];
            });
            break;
          }

          case "audio.level":
            setRms((event as any).rms ?? 0);
            setDbfs((event as any).dbfs ?? -Infinity);
            break;

          case "speech.partial":
            setSttText((event as any).text ?? "");
            setSttState("partial");
            setPipelineState("Listening");
            break;

          case "speech.delta":
            setSttText((event as any).text ?? "");
            setSttState("partial");
            break;

          case "speech.final":
            setSttText((event as any).text ?? "");
            setSttState("final");
            lastSpeechFinalTsRef.current = ts;
            break;

          case "speech.pause": {
            setPipelineState("Processing");
            lastSpeechPauseTsRef.current = ts;
            if (lastSpeechFinalTsRef.current) {
              setVadMs(ts - lastSpeechFinalTsRef.current);
            }
            break;
          }

          case "agent.submit":
            setAgentStatus("waiting");
            setAgentText("");
            setTokens(0);
            setTtft(null);
            submitTimeRef.current = ts;
            firstDeltaTimeRef.current = null;
            setTtsChunks(0);
            setTtsDurationMs(0);
            setTtsMs(null); // reset for new turn
            break;

          case "agent.delta": {
            setAgentStatus("streaming");
            setPipelineState("Streaming");
            setAgentText((prev) => prev + ((event as any).delta ?? ""));
            setTokens((prev) => prev + 1);
            if (firstDeltaTimeRef.current === null) {
              firstDeltaTimeRef.current = ts;
              if (submitTimeRef.current) {
                setAgentMs(ts - submitTimeRef.current);
                setTtft(ts - submitTimeRef.current);
              }
            }
            setAgentElapsed(submitTimeRef.current ? ts - submitTimeRef.current : 0);
            break;
          }

          case "agent.complete":
            setAgentStatus("complete");
            break;

          case "audio.chunk": {
            const trackId = (event as any).trackId ?? (event as any)._from ?? "";
            if (trackId === "tts") {
              setTtsChunks((prev) => prev + 1);
              setTtsDurationMs((prev) => prev + ((event as any).durationMs ?? 0));
              setPipelineState("Speaking");
              // TTS latency: first TTS chunk after first agent delta
              if (ttsMs === null && firstDeltaTimeRef.current) {
                setTtsMs(ts - firstDeltaTimeRef.current);
              }
            }
            break;
          }

          case "control.interrupt":
            setPipelineState("Interrupted");
            setAgentStatus("idle");
            // Reset back to listening after a moment
            setTimeout(() => {
              if (mounted) setPipelineState("Listening");
            }, 500);
            break;

          case "control.error":
            setError((event as any).message ?? "Unknown error");
            break;
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Box flexDirection="column">
      <PipelineStatus state={pipelineState} nodes={nodes} error={error} />
      <InputSection rms={rms} dbfs={dbfs} sttText={sttText} sttState={sttState} />
      <AgentSection
        status={agentStatus}
        text={agentText}
        tokens={tokens}
        ttft={ttft}
        elapsed={agentElapsed}
      />
      <OutputSection chunksReceived={ttsChunks} durationMs={ttsDurationMs} />
      <LatencyBar sttMs={sttMs} vadMs={vadMs} agentMs={agentMs} ttsMs={ttsMs} />
    </Box>
  );
}

// ---- Exports for testing ----

export {
  PipelineStatus,
  InputSection,
  AgentSection,
  OutputSection,
  LatencyBar,
};
export type { PipelineState, NodeState };
