# acpfx

Observable, DAG-based voice pipeline for [ACP](https://github.com/anthropics/agent-client-protocol) agents.

Speak to coding agents like Claude Code through your microphone. Hear their responses through your speaker. See everything happening in a real-time terminal dashboard.

## Architecture

```
mic → stt → bridge → tts → speaker
              ↓
         ACP agent
       (Claude Code)
```

The **orchestrator** loads a YAML config, spawns each node as a child process, and routes NDJSON events between them. It's a dumb DAG executor — it doesn't know what nodes do, just routes events per the config.

**Nodes** are concrete implementations: `@acpfx/stt-elevenlabs`, `@acpfx/tts-elevenlabs`, `@acpfx/bridge-acpx`, etc. Swap providers by changing one line in YAML.

## Quick Start

```bash
# Install
pnpm install

# Build
pnpm build

# Set up ElevenLabs API key (used for both STT and TTS)
echo 'ELEVENLABS_API_KEY=sk_...' > .env
echo 'dotenv' > .envrc && direnv allow

# Set up acpx session
acpx --model claude-sonnet-4-6 --approve-all claude "hello"

# Run with terminal dashboard
node dist/main.js run --config examples/pipeline/elevenlabs.yaml

# Run headless (event logs only)
node dist/main.js run --config examples/pipeline/elevenlabs-minimal.yaml
```

## Configuration

Pipelines are defined in YAML. Each node has a `use` field (implementation) and `outputs` (where its events go).

```yaml
# examples/pipeline/elevenlabs.yaml
nodes:
  mic:
    use: "@acpfx/mic-sox"
    outputs: [stt, recorder, ui]

  stt:
    use: "@acpfx/stt-elevenlabs"
    settings:
      language: en
    outputs: [bridge, ui]

  bridge:
    use: "@acpfx/bridge-acpx"
    settings:
      agent: claude
      session: voice-chat    # optional named session
    outputs: [tts, ui, recorder]

  tts:
    use: "@acpfx/tts-elevenlabs"
    settings:
      voiceId: JBFqnCBsd6RMkjVDRZzb
    outputs: [speaker, recorder, ui]

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
```

### Setting model and session

Configure the ACP agent via acpx before running:

```bash
# Set model
acpx claude set model claude-sonnet-4-6

# Use a named session
acpx claude -s voice-chat "hello"

# Then in YAML:
# bridge.settings.session: voice-chat
```

## Available Nodes

| Node | Package | Description |
|------|---------|-------------|
| Mic (sox) | `@acpfx/mic-sox` | Live microphone capture via sox |
| Mic (file) | `@acpfx/mic-file` | WAV file playback with real-time pacing |
| STT | `@acpfx/stt-elevenlabs` | ElevenLabs Scribe v2 with built-in VAD |
| Bridge | `@acpfx/bridge-acpx` | ACP agent via acpx queue IPC |
| TTS | `@acpfx/tts-elevenlabs` | ElevenLabs streaming WebSocket TTS |
| Speaker | `@acpfx/play-sox` | Speaker output via node-speaker |
| Play (file) | `@acpfx/play-file` | Write audio to WAV file |
| Recorder | `@acpfx/recorder` | Multi-track recording + timeline viewer |
| UI (CLI) | `@acpfx/ui-cli` | Ink-based terminal dashboard |
| Echo | `@acpfx/echo` | Passthrough (for testing) |

## Streaming Protocol

All events are NDJSON (one JSON object per line) with a `type` field:

```
audio.chunk      — PCM audio data (base64)
audio.level      — RMS/peak/dBFS metrics
speech.partial   — interim STT transcript
speech.delta     — STT correction
speech.final     — finalized transcript
speech.pause     — silence detected, ready to submit
agent.submit     — prompt sent to agent
agent.delta      — streaming token from agent
agent.complete   — agent response done
control.interrupt — stop downstream (barge-in)
control.state    — component state change
control.error    — error
lifecycle.ready  — node initialized
lifecycle.done   — node shutting down
log              — component log message
```

The orchestrator stamps every event with `ts` (wall-clock ms) and `_from` (source node name).

## Barge-In (Interrupt)

When you speak while the agent is responding:

1. STT detects first word → `speech.partial`
2. Bridge sees `speech.partial` while active → immediately emits `control.interrupt`
3. TTS closes WebSocket, speaker goes silent
4. You finish speaking → `speech.pause` → bridge submits new prompt

Interrupt is near-instant — triggers on the first recognized word, not after your full utterance.

## File-Based Testing

Replace mic/speaker with file nodes for automated testing:

```yaml
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: ./test-input.wav
      realtime: true
    outputs: [stt]
  # ... rest of pipeline ...
  speaker:
    use: "@acpfx/play-file"
    settings:
      path: ./test-output.wav
    outputs: []
```

## Recording & Timeline

Add a recorder node to capture all events and audio:

```yaml
recorder:
  use: "@acpfx/recorder"
  settings:
    outputDir: ./recordings
  outputs: []
```

Produces:
- `events.jsonl` — all events with timestamps
- `mic.wav` / `tts.wav` — audio tracks
- `conversation.wav` — merged timeline
- `timeline.html` — interactive WaveSurfer.js viewer

## Development

```bash
pnpm build          # compile TypeScript
pnpm test           # run unit tests (46 tests)
pnpm check          # type check without building
```

### Project Structure

```
src/
  main.ts              CLI entrypoint
  orchestrator.ts      DAG executor
  config.ts            YAML config loader
  dag.ts               DAG validation + topological sort
  protocol.ts          Event type definitions
  node-runner.ts       Child process spawner
  nodes/               Node implementations
  bridge/acpx-ipc.ts   acpx queue IPC client
  test/                Unit tests
```

## Requirements

- Node.js 22+
- pnpm
- sox (`brew install sox`)
- acpx (`npm install -g acpx`)
- ElevenLabs API key (for STT + TTS)
