import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";
import WebSocket from "ws";

handleManifestFlag();

// --- Settings ---
type Settings = {
  otaconUrl?: string;
  whitelist?: string;
  smsPollIntervalMs?: number;
  trackId?: string;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const OTACON_URL = settings.otaconUrl ?? process.env.OTACON_URL ?? "https://otacon-pi.tail0437b8.ts.net:8080";
const WHITELIST = (settings.whitelist ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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

// --- Audio WebSocket ---
function connectAudio(): void {
  if (audioWs) return;

  log.info("Connecting to call audio WebSocket");
  audioWs = new WebSocket(wsUrl("/ws/audio/call"), { rejectUnauthorized: false });
  audioWs.binaryType = "arraybuffer";

  audioWs.on("open", () => {
    log.info("Call audio connected");
    emit({ type: "audio.start", trackId: TRACK_ID });
  });

  audioWs.on("message", (data: Buffer | ArrayBuffer) => {
    // Incoming call audio → emit as audio.chunk for STT
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
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

  audioWs.on("close", () => {
    log.info("Call audio disconnected");
    audioWs = null;
    emit({ type: "audio.end", trackId: TRACK_ID });
  });

  audioWs.on("error", (err) => {
    log.error(`Audio WebSocket error: ${err.message}`);
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
  if (WHITELIST.length === 0) return true; // empty whitelist = answer all
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
  disconnectAudio();
}

// --- Events WebSocket ---
function connectEvents(): void {
  log.info("Connecting to events WebSocket");
  eventsWs = new WebSocket(wsUrl("/ws/events"), { rejectUnauthorized: false });

  eventsWs.on("open", () => {
    log.info("Events WebSocket connected");
  });

  eventsWs.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
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

  eventsWs.on("close", () => {
    log.warn("Events WebSocket disconnected, reconnecting in 2s");
    eventsWs = null;
    setTimeout(connectEvents, 2000);
  });

  eventsWs.on("error", (err) => {
    log.error(`Events WebSocket error: ${err.message}`);
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
        // Fetch full messages for this thread to get the latest
        const msgs = (await apiGet(`/api/sms/threads/${thread.thread_id}/messages`)) as Array<{
          body: string;
          date: string;
          msg_type: string;
          address?: string;
        }>;

        for (const msg of msgs) {
          const msgDate = parseInt(msg.date) || 0;
          if (msgDate > lastSeenSmsDate && msg.msg_type === "received") {
            enqueueSms(thread.address, msg.body);
          }
        }
      }
    }

    // Update high-water mark
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

  // Emit SMS as speech.final so the agent processes it like voice input
  emit({
    type: "speech.final",
    trackId: TRACK_ID,
    text: msg.body,
  });
}

// --- Incoming ACPFX events (from TTS / pipeline) ---
function handlePipelineEvent(event: Record<string, unknown>): void {
  const type = event.type as string;

  if (type === "audio.chunk") {
    // TTS audio → send into the call
    if (audioWs && audioWs.readyState === WebSocket.OPEN) {
      const data = event.data as string;
      const pcm = Buffer.from(data, "base64");
      audioWs.send(pcm);
    }
    return;
  }

  if (type === "control.interrupt") {
    // Barge-in: user started speaking during TTS
    log.info("Interrupt received");
    return;
  }

  if (type === "agent.complete") {
    // Agent finished responding — drain next SMS if queued
    waitingForAgentComplete = false;
    drainSmsQueue();
    return;
  }
}

// --- Main ---
async function main(): Promise<void> {
  log.info(`Phone node starting — otacon: ${OTACON_URL}`);
  log.info(`Whitelist: ${WHITELIST.length ? WHITELIST.join(", ") : "(all numbers)"}`);

  // Initialize SMS high-water mark from current threads
  try {
    const threads = (await apiGet("/api/sms/threads")) as Array<{ date: string }>;
    lastSeenSmsDate = Math.max(...threads.map((t) => parseInt(t.date) || 0), 0);
    log.info(`SMS baseline set to ${lastSeenSmsDate}`);
  } catch {
    log.warn("Could not fetch initial SMS threads");
  }

  // Check current call state — may already be in a call
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

  // Connect to events WebSocket
  connectEvents();

  // Start SMS polling
  smsPollTimer = setInterval(pollSms, SMS_POLL_MS);

  // Signal ready
  emit({ type: "lifecycle.ready", component: "phone-otacon" });

  // Listen for pipeline events (TTS audio, interrupts, agent.complete)
  const rl = onEvent(handlePipelineEvent);

  // Shutdown handling
  rl.on("close", () => {
    cleanup();
    emit({ type: "lifecycle.done", component: "phone-otacon" });
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
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
