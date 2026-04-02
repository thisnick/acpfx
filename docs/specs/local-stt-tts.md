# Spec: Local STT/TTS via Kyutai (uv run)

## Goal
Add local (on-device) STT and TTS nodes using Kyutai's delayed-streams-modeling, distributed via `uv run` (Python with inline PEP 723 deps).

## Nodes to create

### node-stt-kyutai
- **Package**: `packages/node-stt-kyutai/`
- **Entry**: `src/stt_kyutai.py` with PEP 723 inline script metadata
- **Consumes**: `audio.chunk`
- **Emits**: `speech.partial`, `speech.final`, `speech.pause`, `lifecycle.ready`, `lifecycle.done`, `log`
- **Manifest env**: none (model downloaded from HuggingFace on first run)
- **Settings**:
  - `model`: string, default `"kyutai/stt-1b-en_fr"` (1B bilingual, 0.5s latency)
  - `language`: string, default `"en"`
  - `device`: string, default `"auto"` (auto-detect: CUDA → Metal → CPU)

### node-tts-kyutai (if TTS is ready)
- Same pattern as STT but emits `audio.chunk`

## Python script pattern

```python
# /// script
# dependencies = [
#   "moshi>=0.6",
#   "torch>=2.0",
#   "huggingface-hub",
#   "sentencepiece",
# ]
# requires-python = ">=3.10"
# ///

import sys
import json

# ... NDJSON stdio contract: read audio.chunk from stdin, emit speech.* on stdout
```

## Orchestrator node resolution (new)

Add `.py` resolution to `resolve_node()` in the orchestrator:

```
1. dist/nodes/<name>.js   → node <path>       (TypeScript)
2. dist/nodes/<name>      → ./<path>           (native binary)
3. dist/nodes/<name>.py   → uv run <path>      (Python — NEW)
4. npx -y @acpfx/<name>                        (npm fallback)
```

`uv run` automatically:
- Creates a cached venv
- Installs all dependencies declared in the inline script metadata
- Handles CUDA/Metal/CPU (PyTorch detects automatically)
- First run is slow (download deps + model weights), subsequent runs are instant

## Audio format bridging

- acpfx pipeline uses 16kHz PCM s16le
- Kyutai Moshi expects 24kHz float32
- The Python script handles resampling internally (using torchaudio or scipy)

## Build integration

- `scripts/build.js`: copy `.py` files to `dist/nodes/` alongside `.js` files
- `manifest.yaml`: standard manifest with consumes/emits/settings/env
- `--manifest` flag: Python script supports `--manifest` (prints JSON, exits)

## Distribution

- npm package `@acpfx/stt-kyutai` contains the `.py` script + manifest
- Requires `uv` installed on the system
- `devbox.json`: add `uv` to packages

## Tests

- Unit test: verify the Python script handles `--manifest` flag
- Integration test: feed a WAV file as audio.chunk events, verify speech.final is emitted
- Contract test: verify manifest consumes/emits match actual behavior
