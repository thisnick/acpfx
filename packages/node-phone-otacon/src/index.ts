import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

// Allow self-signed certs (otacon uses Tailscale TLS certs)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// --- Settings ---
type Settings = {
  otaconUrl?: string;
  whitelist?: string;
  smsPollIntervalMs?: number;
  trackId?: string;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const OTACON_URL = settings.otaconUrl ?? process.env.OTACON_URL ?? "https://otacon-pi.tail0437b8.ts.net:8080";
const WHITELIST_RAW = (settings.whitelist ?? "").trim();
const WHITELIST_ALLOW_ALL = WHITELIST_RAW === "*";
const WHITELIST = WHITELIST_RAW.split(",").map((s) => s.trim()).filter(Boolean);
const SMS_POLL_MS = settings.smsPollIntervalMs ?? 5000;
const TRACK_ID = settings.trackId ?? "phone";
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

// --- State ---
let callState: "idle" | "ringing" | "active" = "idle";
let callNumber: string | null = null;
let audioWs: WebSocket | null = null;
let eventsWs: WebSocket | null = null;
let lastSeenSmsDate = 0;
let smsQueue: Array<{ from: string; body: string }> = [];
let waitingForAgentComplete = false;
let smsPollTimer: ReturnType<typeof setInterval> | null = null;

// --- Helpers ---
function apiUrl(path: string): string {
  return `${OTACON_URL}${path}`;
}

function wsUrl(path: string): string {
  const base = OTACON_URL.replace(/^http/, "ws");
  return `${base}${path}`;
}

async function apiPost(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  return res.json();
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(apiUrl(path));
  return res.json();
}

// --- Audio WebSocket (native WebSocket, Node 22+) ---
function connectAudio(): void {
  if (audioWs) return;

  log.info(`Connecting to call audio WebSocket: ${wsUrl("/ws/audio/call")}`);
  try {
    audioWs = new WebSocket(wsUrl("/ws/audio/call"));
    audioWs.binaryType = "arraybuffer";
  } catch (err) {
    log.error(`Audio WebSocket creation failed: ${err}`);
    audioWs = null;
    return;
  }

  audioWs.addEventListener("open", () => {
    log.info("Call audio connected");
    emit({ type: "audio.start", trackId: TRACK_ID });
  });

  audioWs.addEventListener("message", (event) => {
    if (typeof event.data === "string") return; // skip config messages
    const buf = Buffer.from(event.data as ArrayBuffer);
    const durationMs = Math.round((buf.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000);

    emit({
      type: "audio.chunk",
      trackId: TRACK_ID,
      format: "pcm_s16le",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      data: buf.toString("base64"),
      durationMs,
      kind: "speech",
    });
  });

  audioWs.addEventListener("close", (event) => {
    log.info(`Call audio disconnected (code=${(event as CloseEvent).code}, reason=${(event as CloseEvent).reason || "none"})`);
    audioWs = null;
    emit({ type: "audio.end", trackId: TRACK_ID });
  });

  audioWs.addEventListener("error", (event) => {
    log.error(`Audio WebSocket error: ${JSON.stringify(event)}`);
    audioWs = null;
  });
}

function disconnectAudio(): void {
  if (audioWs) {
    audioWs.close();
    audioWs = null;
  }
}

// --- Call state handling ---
function isWhitelisted(number: string | null): boolean {
  if (WHITELIST_ALLOW_ALL) return true;
  if (WHITELIST.length === 0) return false; // "" = deny all
  if (!number) return false;
  return WHITELIST.some((w) => number.includes(w) || w.includes(number));
}

async function handleIncomingCall(number: string | null): Promise<void> {
  callState = "ringing";
  callNumber = number;
  log.info(`Incoming call from ${number || "unknown"}`);

  if (isWhitelisted(number)) {
    log.info("Whitelisted — auto-answering");
    await apiPost("/api/calls/answer");
  } else {
    log.info("Not whitelisted — auto-rejecting");
    await apiPost("/api/calls/hangup");
  }
}

function handleCallConnected(number: string | null): void {
  callState = "active";
  callNumber = number || callNumber;
  log.info(`Call connected with ${callNumber || "unknown"}`);
  connectAudio();
}

function handleCallEnded(): void {
  const was = callState;
  callState = "idle";
  callNumber = null;
  log.info(`Call ended (was ${was})`);
  flushOutboundQueue();
  disconnectAudio();
}

// --- Events WebSocket (native WebSocket) ---
function connectEvents(): void {
  log.info("Connecting to events WebSocket");
  try {
    eventsWs = new WebSocket(wsUrl("/ws/events"));
  } catch (err) {
    log.error(`Events WebSocket creation failed: ${err}`);
    setTimeout(connectEvents, 5000);
    return;
  }

  eventsWs.addEventListener("open", () => {
    log.info("Events WebSocket connected");
  });

  eventsWs.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      const evt = msg.event || msg.type;

      switch (evt) {
        case "call.incoming":
          handleIncomingCall(msg.data?.number ?? null);
          break;
        case "call.connected":
          handleCallConnected(msg.data?.number ?? null);
          break;
        case "call.ended":
          handleCallEnded();
          break;
        case "sms.received":
          if (msg.data?.from && msg.data?.body) {
            enqueueSms(msg.data.from, msg.data.body);
          }
          break;
      }
    } catch {
      // ignore malformed events
    }
  });

  eventsWs.addEventListener("close", () => {
    log.warn("Events WebSocket disconnected, reconnecting in 2s");
    eventsWs = null;
    setTimeout(connectEvents, 2000);
  });

  eventsWs.addEventListener("error", () => {
    log.error("Events WebSocket error");
  });
}

// --- SMS polling ---
async function pollSms(): Promise<void> {
  try {
    const threads = (await apiGet("/api/sms/threads")) as Array<{
      thread_id: number;
      address: string;
      snippet: string;
      date: string;
    }>;

    for (const thread of threads) {
      const date = parseInt(thread.date) || 0;
      if (date > lastSeenSmsDate) {
        const msgs = (await apiGet(`/api/sms/threads/${thread.thread_id}/messages`)) as Array<{
          body: string;
          date: string;
          type?: string;
          msg_type?: string;
        }>;

        for (const msg of msgs) {
          const msgDate = parseInt(msg.date) || 0;
          if (msgDate > lastSeenSmsDate && ((msg as Record<string, unknown>).type === "received" || msg.msg_type === "received")) {
            enqueueSms(thread.address, msg.body);
          }
        }
      }
    }

    const maxDate = Math.max(...threads.map((t) => parseInt(t.date) || 0), lastSeenSmsDate);
    lastSeenSmsDate = maxDate;
  } catch {
    // polling failure is non-fatal
  }
}

function enqueueSms(from: string, body: string): void {
  log.info(`SMS from ${from}: ${body.substring(0, 50)}`);
  smsQueue.push({ from, body });
  drainSmsQueue();
}

function drainSmsQueue(): void {
  if (waitingForAgentComplete || smsQueue.length === 0) return;

  const msg = smsQueue.shift()!;
  waitingForAgentComplete = true;

  emit({
    type: "prompt.text",
    trackId: TRACK_ID,
    text: msg.body,
    source: "sms",
    from: msg.from,
  });
}

// --- Outbound audio pacing ---
let outboundQueue: Array<{ pcm: Buffer; durationMs: number }> = [];
let outboundPlaying = false;

function enqueueOutboundAudio(pcm: Buffer, durationMs: number): void {
  outboundQueue.push({ pcm, durationMs });
  drainOutboundQueue();
}

function drainOutboundQueue(): void {
  if (outboundPlaying || outboundQueue.length === 0) return;
  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) {
    outboundQueue = [];
    return;
  }

  outboundPlaying = true;
  const chunk = outboundQueue.shift()!;
  audioWs.send(chunk.pcm);

  // Wait for the chunk's real-time duration before sending next
  setTimeout(() => {
    outboundPlaying = false;
    drainOutboundQueue();
  }, chunk.durationMs);
}

function flushOutboundQueue(): void {
  outboundQueue = [];
  outboundPlaying = false;
}

// --- Incoming ACPFX events (from TTS / pipeline) ---
function handlePipelineEvent(event: Record<string, unknown>): void {
  const type = event.type as string;

  if (type === "audio.chunk") {
    if (audioWs && audioWs.readyState === WebSocket.OPEN) {
      const data = event.data as string;
      const pcm = Buffer.from(data, "base64");
      const durationMs = (event.durationMs as number) ||
        Math.round((pcm.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000);
      enqueueOutboundAudio(pcm, durationMs);
    }
    return;
  }

  if (type === "control.interrupt") {
    log.info("Interrupt — flushing outbound audio");
    flushOutboundQueue();
    return;
  }

  if (type === "agent.complete") {
    waitingForAgentComplete = false;
    drainSmsQueue();
    return;
  }
}

// --- Main ---
async function main(): Promise<void> {
  log.info(`Phone node starting — otacon: ${OTACON_URL}`);
  log.info(`Whitelist: ${WHITELIST_ALLOW_ALL ? "* (all numbers)" : WHITELIST.length ? WHITELIST.join(", ") : "(deny all)"}`);

  try {
    const threads = (await apiGet("/api/sms/threads")) as Array<{ date: string }>;
    lastSeenSmsDate = Math.max(...threads.map((t) => parseInt(t.date) || 0), 0);
    log.info(`SMS baseline set to ${lastSeenSmsDate}`);
  } catch {
    log.warn("Could not fetch initial SMS threads");
  }

  try {
    const status = (await apiGet("/api/calls/status")) as { state: string; number?: string };
    if (status.state === "active") {
      log.info("Already in a call — connecting audio");
      callState = "active";
      callNumber = status.number ?? null;
      connectAudio();
    } else if (status.state === "ringing") {
      await handleIncomingCall(status.number ?? null);
    }
  } catch {
    log.warn("Could not fetch initial call status");
  }

  connectEvents();
  smsPollTimer = setInterval(pollSms, SMS_POLL_MS);

  emit({ type: "lifecycle.ready", component: "phone-otacon" });

  // Listen for pipeline events from orchestrator (stdin)
  const rl = onEvent(handlePipelineEvent);

  const shutdown = () => {
    cleanup();
    emit({ type: "lifecycle.done", component: "phone-otacon" });
    process.exit(0);
  };

  // In orchestrator mode, stdin close = shutdown
  // But don't exit immediately — let SMS poll finish current cycle
  rl.on("close", () => {
    log.info("stdin closed");
    setTimeout(shutdown, 500);
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive (event loop would exit without this since
  // readline may close immediately in standalone/test mode)
  setInterval(() => {}, 60000);
}

function cleanup(): void {
  if (smsPollTimer) clearInterval(smsPollTimer);
  disconnectAudio();
  if (eventsWs) eventsWs.close();
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
