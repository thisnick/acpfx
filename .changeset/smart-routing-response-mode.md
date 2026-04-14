---
"@acpfx/cli": minor
"@acpfx/core": minor
"@acpfx/bridge-acpx": minor
"@acpfx/phone-otacon": minor
"@acpfx/tts-deepgram": minor
"@acpfx/stt-deepgram": minor
---

Add conditional output routing, responseMode tagging, SMS reply, and lazy STT/TTS connections

- Orchestrator: `whenFieldEquals` conditional filter on output edges for field-based routing
- Bridge: tags all agent events with `responseMode: "voice" | "text"` based on input source
- Phone node: channel binding (activeSmsContact/activeCallContact), SMS reply with delta accumulation and chunking at 1500 chars, `from` removed from prompt.text (pipeline is channel-agnostic)
- TTS: lazy connection — warm-up on `agent.submit`, disconnect on `agent.complete`, zero idle connections
- STT: lazy connection — connect on first `audio.chunk`, disconnect on `audio.end`
- Pipeline configs: phone-agent YAMLs use whenFieldEquals to route voice→TTS and text→phone
