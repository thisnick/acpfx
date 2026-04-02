# Barge-In and Interrupt Propagation

Design notes on how acpfx handles barge-in (user starts speaking while the agent is still responding).

## How Barge-In Works

In a typical voice pipeline (`mic -> stt -> bridge -> tts -> player`), barge-in occurs when the STT node detects speech while the TTS/player are still outputting audio.

1. **Mic never stops listening.** The mic node continuously streams `audio.chunk` events. There is no mute mechanism -- barge-in requires always-on audio capture.

2. **STT detects speech.** The STT node emits `speech.partial` as soon as it recognizes speech, even while agent audio is playing.

3. **Bridge emits interrupt.** The bridge node (agent) receives `speech.partial` and decides to interrupt the current response. It emits `control.interrupt` with `reason: "barge-in"`.

4. **Interrupt propagates downstream.** The orchestrator broadcasts `control.interrupt` to all transitive downstream nodes that declare it in their `consumes`. This reaches TTS and player but not STT.

5. **TTS stops generating, player stops playing.** Each node handles the interrupt according to its role: TTS closes the current stream, player flushes its buffer.

## Why STT Never Receives Interrupts

STT nodes do not declare `control.interrupt` in their manifest `consumes` list:

```yaml
# stt-deepgram manifest
consumes:
  - audio.chunk         # only audio data, no control events
```

This is deliberate. The STT must keep processing audio through an interrupt so it can capture what the user is saying. The manifest-based filtering handles this automatically -- no special-case code needed.

## The Cycle Problem

With echo cancellation, the graph has a cycle: `player -> mic -> stt -> bridge -> tts -> player`. This creates a potential feedback loop:

```
player emits audio.chunk -> mic (AEC reference)
mic emits audio.chunk -> stt
stt emits speech events -> bridge
bridge emits agent events -> tts
tts emits audio.chunk -> player
player emits audio.chunk -> mic (cycle)
```

This works because:

1. **Manifest filtering prevents runaway loops.** The mic-aec node consumes `audio.chunk` from the player as AEC reference audio but does not blindly re-emit it. It uses the reference to cancel echo from the captured mic audio before emitting its own `audio.chunk`.

2. **Different audio purposes.** The `audio.chunk` from player to mic is reference audio for echo cancellation. The `audio.chunk` from mic to stt is cleaned capture audio. They serve different roles despite being the same event type.

3. **Topological ordering handles cycles.** The orchestrator uses Kahn's algorithm for topological sort. Nodes in cycles are appended in config declaration order after the acyclic nodes, ensuring a deterministic startup sequence.

## Interrupt Flow in a Cyclic Graph

In the AEC pipeline `mic -> stt -> bridge -> tts -> player -> mic`:

1. Bridge emits `control.interrupt`.
2. Orchestrator computes transitive downstream of bridge: `{tts, player, mic}`.
3. TTS consumes `control.interrupt` -- receives it, stops generating.
4. Player consumes `control.interrupt` -- receives it, stops playing.
5. Mic (mic-aec) consumes `control.interrupt` -- receives it, can reset AEC state.
6. STT does NOT consume `control.interrupt` -- never receives it, keeps transcribing.

The key insight: interrupt propagation follows the downstream set (DFS from the emitting node), and manifest filtering ensures only nodes that know how to handle interrupts receive them.

## Settings-Based Source Identification

Nodes that need to know which upstream node produces certain events use settings rather than hardcoding node names:

```yaml
player:
  use: '@acpfx/audio-player'
  settings: {speechSource: tts}
```

The player uses `speechSource` to identify which `_from` value corresponds to TTS audio (vs. SFX or other audio). This keeps the node reusable across different pipeline configurations.
