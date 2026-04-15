# CosyVoice3 TTS Verification Tests

Black-box tests that exercise the `@acpfx/tts-cosyvoice` node through its NDJSON stdin/stdout contract. These tests require the actual CosyVoice3 model to be downloaded and are **not** part of CI.

## Prerequisites

1. Install `uv` (the bin wrapper requires it):
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. Download the CosyVoice3 model (~1GB):
   ```bash
   python3 -c "from huggingface_hub import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512')"
   ```

3. Ensure you are in the repository root.

## Running

```bash
cd /path/to/acpfx
python3 packages/node-tts-cosyvoice/tests/verification/test_cosyvoice.py
```

Or run individual test classes:

```bash
# Contract tests only (fast)
python3 -m pytest packages/node-tts-cosyvoice/tests/verification/test_cosyvoice.py::TestContractCompliance -v

# Streaming verification only (critical)
python3 -m pytest packages/node-tts-cosyvoice/tests/verification/test_cosyvoice.py::TestStreamingVerification -v
```

## Test Summary

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Contract Compliance | `--acpfx-manifest` outputs valid JSON; `lifecycle.ready` emitted on start; `lifecycle.done` emitted on EOF |
| 2 | Streaming Verification | First `audio.chunk` arrives BEFORE `agent.complete` is sent (proves true streaming) |
| 3 | Speech Correctness | Audio format (16kHz, mono, pcm_s16le), reasonable duration, non-silent output |
| 4 | Interrupt Handling | `control.interrupt` stops audio emission; synthesis resumes after interrupt |
| 5 | Complete Without Deltas | `agent.complete` with `text` field (no prior deltas) produces audio |
| 6 | Edge Cases | Empty delta, very short text ("Hi"), `agent.tool_start` during synthesis, multiple sequential utterances |

## Output Files

Tests save WAV files to `/tmp/` for manual listening:

- `/tmp/cosyvoice_test_streaming.wav` -- Streaming test output
- `/tmp/cosyvoice_test_speech.wav` -- Speech correctness test output
- `/tmp/cosyvoice_test_complete_only.wav` -- Complete-without-deltas test output

## Pass Criteria

All tests must pass. The streaming verification test (Test 2) is the most critical -- if audio only arrives after `agent.complete` is sent, the node is buffering instead of streaming and **fails**.
