# @acpfx/phone-otacon

## 0.3.0

### Minor Changes

- a994112: Add conditional output routing, responseMode tagging, SMS reply, and lazy STT/TTS connections

  - Orchestrator: `whenFieldEquals` conditional filter on output edges for field-based routing
  - Bridge: tags all agent events with `responseMode: "voice" | "text"` based on input source
  - Phone node: channel binding (activeSmsContact/activeCallContact), SMS reply with delta accumulation and chunking at 1500 chars, `from` removed from prompt.text (pipeline is channel-agnostic)
  - TTS: lazy connection — warm-up on `agent.submit`, disconnect on `agent.complete`, zero idle connections
  - STT: lazy connection — connect on first `audio.chunk`, disconnect on `audio.end`
  - Pipeline configs: phone-agent YAMLs use whenFieldEquals to route voice→TTS and text→phone

### Patch Changes

- Updated dependencies [a994112]
  - @acpfx/core@0.5.0
  - @acpfx/node-sdk@0.3.3

## 0.2.0

### Minor Changes

- 1122668: Add phone-otacon node for telephony integration, audio player pacing, and prompt.text support

  - New `@acpfx/phone-otacon` node: bidirectional phone audio + SMS via Otacon server with auto-answer whitelist
  - New `prompt.text` event type for non-voice text input (SMS), queued in bridge when agent is busy
  - Audio player now paces output with 500ms lookahead to prevent Bluetooth stutter
  - All audio (speech + SFX) goes through unified pacing queue
  - Bridge queues prompt.text when agent is streaming, drains after completion
