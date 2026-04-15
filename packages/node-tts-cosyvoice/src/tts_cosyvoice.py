# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "torch>=2.3.1",
#     "torchaudio>=2.3.1",
#     "torchcodec",
#     "numpy<2",
#     "huggingface-hub",
#     "hyperpyyaml",
#     "onnxruntime; sys_platform == 'darwin' or sys_platform == 'win32'",
#     "openai-whisper",
#     "inflect",
#     "conformer==0.3.2",
#     "diffusers==0.29.0",
#     "pydantic",
#     "tqdm",
#     "soundfile",
#     "librosa",
#     "lightning",
#     "hydra-core",
#     "omegaconf",
#     "x-transformers==2.11.24",
#     "transformers==4.51.3",
#     "pyyaml",
#     "gdown",
#     "wget",
#     "protobuf",
#     "networkx",
#     "rich",
#     "einops",
#     "Unidecode",
#     "scipy",
#     "sentencepiece",
#     "piper-phonemize; sys_platform == 'linux'",
#     "wetext",
#     "grpcio",
#     "matplotlib",
#     "pyarrow",
#     "pyworld",
# ]
# ///
"""
tts-cosyvoice node -- Local TTS via CosyVoice3 (FunAudioLLM/Fun-CosyVoice3-0.5B-2512).

CosyVoice3 supports bi-directional streaming: text-in via Python generator,
audio-out via generator. The model's frontend auto-tokenizes incrementally.
No sentence splitting needed. Model outputs 24kHz audio, resampled to 16kHz.

CosyVoice3 is zero-shot only (no built-in SFT speakers). Always uses
inference_zero_shot. Default mode uses a bundled reference voice from the
CosyVoice repo. Custom voice cloning via voice + prompt_text settings.

Device priority: MPS > CUDA > CPU with graceful fallback.

NDJSON stdio contract:
  stdin:  agent.delta, agent.complete, agent.tool_start, control.interrupt
  stdout: audio.chunk, lifecycle.ready, lifecycle.done, log

Architecture:
  - stdin reader thread -> input_queue (Queue)
  - main thread: dispatches events, pushes text to text_queue
  - synthesis thread: runs inference with text generator, emits audio

CosyVoice repo is cloned via --acpfx-setup and added to sys.path.
Model weights are downloaded via modelscope during --acpfx-setup.
"""

import base64
import json
import logging
import os
import queue
import select
import struct
import sys
import threading
import time
import types

NODE_NAME = os.environ.get("ACPFX_NODE_NAME", "tts-cosyvoice")
COMPONENT = "tts-cosyvoice"
SETTINGS = json.loads(os.environ.get("ACPFX_SETTINGS", "{}"))

MODEL_ID = SETTINGS.get("model", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")
VOICE = SETTINGS.get("voice", "")
PROMPT_TEXT = SETTINGS.get("prompt_text", "")
DEVICE_PREF = SETTINGS.get("device", "auto")

# Default prompt text for zero-shot voice cloning.
# The <|endofprompt|> token is required by CosyVoice3's bistream LLM.
# Uses English text to avoid accent from Chinese prompt.
DEFAULT_PROMPT_TEXT = "You are a helpful assistant.<|endofprompt|>Hello, I am a voice assistant. How can I help you today?"

OUTPUT_SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100
SAMPLES_PER_CHUNK = OUTPUT_SAMPLE_RATE * CHUNK_DURATION_MS // 1000  # 1600

# CosyVoice repo clone location
COSYVOICE_REPO_DIR = os.path.expanduser("~/.cache/acpfx/cosyvoice")
COSYVOICE_REPO_URL = "https://github.com/FunAudioLLM/CosyVoice.git"


def _ensure_cosyvoice_on_path():
    """Add the CosyVoice repo clone to sys.path so `import cosyvoice` works."""
    if COSYVOICE_REPO_DIR not in sys.path:
        cosyvoice_pkg = os.path.join(COSYVOICE_REPO_DIR, "cosyvoice")
        if os.path.isdir(cosyvoice_pkg):
            sys.path.insert(0, COSYVOICE_REPO_DIR)
            # Also add third_party dirs if they exist
            tp = os.path.join(COSYVOICE_REPO_DIR, "third_party", "Matcha-TTS")
            if os.path.isdir(tp):
                sys.path.insert(0, tp)


def emit(event: dict):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def log(level: str, message: str):
    emit({"type": "log", "level": level, "component": COMPONENT, "message": message})


def emit_audio_chunk(samples_16k):
    """Convert float32 samples at 16kHz to s16le base64 and emit audio.chunk."""
    clamped = [max(-1.0, min(1.0, s)) for s in samples_16k]
    pcm_bytes = struct.pack(f"<{len(clamped)}h", *[int(s * 32767) for s in clamped])
    b64 = base64.b64encode(pcm_bytes).decode("ascii")
    duration_ms = int(len(samples_16k) / OUTPUT_SAMPLE_RATE * 1000)
    emit({
        "type": "audio.chunk",
        "trackId": "tts",
        "format": "pcm_s16le",
        "sampleRate": OUTPUT_SAMPLE_RATE,
        "channels": 1,
        "data": b64,
        "durationMs": duration_ms,
    })


# ---- --acpfx-* flag handling ----

def handle_acpfx_flags():
    acpfx_flag = next((a for a in sys.argv if a.startswith("--acpfx-")), None)
    legacy_manifest = "--manifest" in sys.argv

    if not acpfx_flag and not legacy_manifest:
        return

    flag = acpfx_flag or "--acpfx-manifest"

    if flag == "--acpfx-manifest":
        _print_manifest()
    elif flag == "--acpfx-setup-check":
        _handle_setup_check()
    elif flag == "--acpfx-setup":
        _handle_setup()
    else:
        print(json.dumps({"unsupported": True, "flag": flag}))
        sys.exit(0)


def _print_manifest():
    import yaml
    script_path = os.path.realpath(sys.argv[0])
    base = os.path.splitext(script_path)[0]
    for path in [f"{base}.manifest.json", f"{base}.manifest.yaml"]:
        if os.path.exists(path):
            with open(path) as f:
                print(f.read().strip())
            sys.exit(0)
    script_dir = os.path.dirname(script_path)
    for candidate in [
        os.path.join(script_dir, "..", "manifest.yaml"),
        os.path.join(script_dir, "manifest.yaml"),
    ]:
        if os.path.exists(candidate):
            with open(candidate) as f:
                manifest = yaml.safe_load(f)
            print(json.dumps(manifest))
            sys.exit(0)
    print(json.dumps({"error": "manifest.yaml not found"}), file=sys.stderr)
    sys.exit(1)


def _handle_setup_check():
    # Check if CosyVoice repo is cloned (needed for cosyvoice package import)
    has_repo = os.path.isdir(os.path.join(COSYVOICE_REPO_DIR, "cosyvoice"))

    # Check if model weights are downloaded — check HuggingFace cache first, then modelscope
    has_weights = False
    hf_cache = os.path.expanduser("~/.cache/huggingface/hub")
    repo_dir = os.path.join(hf_cache, f"models--{MODEL_ID.replace('/', '--')}")
    snapshots = os.path.join(repo_dir, "snapshots")
    if os.path.isdir(snapshots):
        for rev in os.listdir(snapshots):
            rev_dir = os.path.join(snapshots, rev)
            if os.path.isdir(rev_dir):
                model_files = [f for f in os.listdir(rev_dir)
                               if f.endswith(".safetensors") or f.endswith(".pt")]
                if len(model_files) >= 1:
                    has_weights = True
                    break
    if not has_weights:
        ms_cache = os.path.expanduser(f"~/.cache/modelscope/hub/models/{MODEL_ID}")
        if os.path.isdir(ms_cache):
            for f in os.listdir(ms_cache):
                if f.endswith(".safetensors") or f.endswith(".pt"):
                    has_weights = True
                    break

    needed = not has_weights or not has_repo
    desc_parts = []
    if not has_repo:
        desc_parts.append("Clone CosyVoice repo")
    if not has_weights:
        desc_parts.append(f"Download {MODEL_ID} model files")
    print(json.dumps({"needed": needed}
          | ({"description": "; ".join(desc_parts)} if needed else {})))
    sys.exit(0)


def _handle_setup():
    import subprocess as sp
    try:
        # Step 1: Clone CosyVoice repo if needed (for cosyvoice package import)
        if not os.path.isdir(os.path.join(COSYVOICE_REPO_DIR, "cosyvoice")):
            print(json.dumps({"type": "progress", "message": "Cloning CosyVoice repo...", "pct": 10}))
            sp.run(["git", "clone", "--depth", "1", COSYVOICE_REPO_URL, COSYVOICE_REPO_DIR], check=True)

        # Step 2: Download model weights via HuggingFace (not modelscope — faster, no network check on load)
        print(json.dumps({"type": "progress", "message": f"Downloading {MODEL_ID} from HuggingFace...", "pct": 20}))
        from huggingface_hub import snapshot_download
        snapshot_download(MODEL_ID)

        print(json.dumps({"type": "complete", "message": "Setup complete"}))
        sys.exit(0)
    except Exception as e:
        msg = str(e)
        if "401" in msg:
            msg = f"Authentication required to download '{MODEL_ID}'. Run: huggingface-cli login"
        elif "404" in msg:
            msg = f"Model '{MODEL_ID}' not found. Check the model ID."
        print(json.dumps({"type": "error", "message": msg}))
        sys.exit(1)


handle_acpfx_flags()


# ---- Shared infrastructure ----

# Sentinel values for the input queue
_INTERRUPT = object()
_EOF = object()

# Sentinel for the text generator queue
_DONE = object()


def stdin_reader_thread(input_q: queue.Queue, interrupt_event: threading.Event | None = None):
    """Read NDJSON from stdin, parse events, put on queue. Runs in background thread.
    If interrupt_event is provided, sets it immediately when control.interrupt
    or agent.tool_start arrives -- bypassing the main thread's poll loop for
    instant interrupt signaling to the synthesis thread.

    Uses sys.stdin.readline() instead of 'for line in sys.stdin:' to avoid
    Python's internal read-ahead buffering (8KB) on pipes. This ensures
    interrupt events are read immediately when written to stdin, not delayed
    until the buffer fills."""
    while True:
        line = sys.stdin.readline()
        if not line:
            break  # EOF
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type", "")
        if etype in ("control.interrupt", "agent.tool_start"):
            if interrupt_event is not None:
                interrupt_event.set()
            if etype == "control.interrupt":
                efrom = event.get("_from", "?")
                log("warn", f"[stdin] control.interrupt received from={efrom}")
        input_q.put(event)
    input_q.put(_EOF)


def resolve_device():
    if DEVICE_PREF != "auto":
        return DEVICE_PREF
    import torch
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def validate_device(device: str) -> str:
    """Smoke test the device with a small matmul. Falls back to CPU on failure."""
    if device == "cpu":
        return device
    try:
        import torch
        a = torch.randn(2, 2, device=device)
        b = torch.randn(2, 2, device=device)
        _ = a @ b
        return device
    except Exception as e:
        log("warn", f"Device '{device}' failed smoke test: {e}, falling back to CPU")
        return "cpu"


def text_generator(text_queue: queue.Queue):
    """Yields text chunks as they arrive from agent.delta events.

    Blocks on text_queue.get(). Returns when _DONE sentinel is received.
    This generator is passed to cosyvoice.inference_cross_lingual/inference_zero_shot
    as the tts_text parameter -- the model's frontend auto-tokenizes incrementally.
    """
    while True:
        item = text_queue.get()
        if item is _DONE:
            return
        yield item


# ---- Abortable inference_bistream patch ----
# Copied from cosyvoice/llm/llm.py Qwen2LM.inference_bistream with abort checks
# added at the 3 critical loop/wait points. This allows clean mid-stream abort
# without corrupting model state (no model reload needed).

def _abortable_inference_bistream(self, text, prompt_text, prompt_text_len,
                                   prompt_speech_token, prompt_speech_token_len,
                                   embedding, sampling=25, max_token_text_ratio=20.0,
                                   min_token_text_ratio=2.0):
    """Patched inference_bistream with abort support via self._abort Event.
    Must be called inside torch.inference_mode() context (llm_job provides this)."""
    import torch

    abort = getattr(self, '_abort', None)
    device = prompt_text.device

    # 1. prepare input
    if self.__class__.__name__ == 'CosyVoice3LM':
        sos_emb = self.speech_embedding.weight[self.sos].reshape(1, 1, -1)
        task_id_emb = self.speech_embedding.weight[self.task_id].reshape(1, 1, -1)
    elif self.__class__.__name__ == 'Qwen2LM':
        sos_emb = self.llm_embedding.weight[self.sos].reshape(1, 1, -1)
        task_id_emb = self.llm_embedding.weight[self.task_id].reshape(1, 1, -1)
    else:
        raise ValueError
    if prompt_speech_token_len != 0:
        prompt_speech_token_emb = self.speech_embedding(prompt_speech_token)
    else:
        prompt_speech_token_emb = torch.zeros(1, 0, self.llm_input_size, dtype=prompt_text.dtype).to(device)
    lm_input = torch.concat([sos_emb], dim=1)

    # 2. iterate text
    out_tokens = []
    cache = None
    if self.__class__.__name__ == 'CosyVoice3LM':
        assert 151646 in prompt_text, '<|endofprompt|> not detected in CosyVoice3 prompt_text, check your input!'
        eop_index = prompt_text.flatten().tolist().index(151646)
        lm_input = torch.concat([lm_input, self.llm.model.model.embed_tokens(prompt_text[:, :eop_index + 1])], dim=1)
        prompt_text = prompt_text[:, eop_index + 1:]
    text_cache = self.llm.model.model.embed_tokens(prompt_text)
    next_fill_index = (int(prompt_speech_token.shape[1] / self.mix_ratio[1]) + 1) * self.mix_ratio[1] - prompt_speech_token.shape[1]
    for this_text in text:
        if abort and abort.is_set():
            return
        text_cache = torch.concat([text_cache, self.llm.model.model.embed_tokens(this_text)], dim=1)
        while prompt_speech_token_emb.size(1) != 0:
            if abort and abort.is_set():
                return
            if text_cache.size(1) >= self.mix_ratio[0]:
                lm_input_text, lm_input_speech = text_cache[:, :self.mix_ratio[0]], prompt_speech_token_emb[:, :self.mix_ratio[1]]
                logging.info('append {} text token {} speech token'.format(lm_input_text.size(1), lm_input_speech.size(1)))
                lm_input = torch.concat([lm_input, lm_input_text, lm_input_speech], dim=1)
                text_cache, prompt_speech_token_emb = text_cache[:, self.mix_ratio[0]:], prompt_speech_token_emb[:, self.mix_ratio[1]:]
            else:
                logging.info('not enough text token to decode, wait for more')
                break
        if prompt_speech_token_emb.size(1) == 0:
            if (len(out_tokens) != 0 and out_tokens[-1] == self.fill_token) or (len(out_tokens) == 0 and lm_input.size(1) == 1):
                logging.info('get fill token, need to append more text token')
                if text_cache.size(1) >= self.mix_ratio[0]:
                    lm_input_text = text_cache[:, :self.mix_ratio[0]]
                    logging.info('append {} text token'.format(lm_input_text.size(1)))
                    if len(out_tokens) != 0 and out_tokens[-1] == self.fill_token:
                        lm_input = lm_input_text
                    else:
                        lm_input = torch.concat([lm_input, lm_input_text], dim=1)
                    text_cache = text_cache[:, self.mix_ratio[0]:]
                else:
                    logging.info('not enough text token to decode, wait for more')
                    continue
            while True:
                if abort and abort.is_set():
                    return
                seq_len = lm_input.shape[1] if cache is None else lm_input.shape[1] + cache[0][0].size(2)
                y_pred, cache = self.llm.forward_one_step(lm_input,
                                                          masks=torch.tril(torch.ones((1, seq_len, seq_len), device=lm_input.device)).to(torch.bool),
                                                          cache=cache)
                logp = self.llm_decoder(y_pred[:, -1]).log_softmax(dim=-1)
                if next_fill_index != -1 and len(out_tokens) == next_fill_index:
                    top_ids = self.fill_token
                    next_fill_index += (self.mix_ratio[1] + 1)
                else:
                    top_ids = self.sampling_ids(logp.squeeze(dim=0), out_tokens, sampling, ignore_eos=True)
                if top_ids == self.fill_token:
                    next_fill_index = len(out_tokens) + self.mix_ratio[1] + 1
                    logging.info('fill_token index {} next fill_token index {}'.format(len(out_tokens), next_fill_index))
                out_tokens.append(top_ids)
                if top_ids >= self.speech_token_size:
                    if top_ids == self.fill_token:
                        break
                    else:
                        raise ValueError('should not get token {}'.format(top_ids))
                yield top_ids
                lm_input = self.speech_embedding.weight[top_ids].reshape(1, 1, -1)

    # 3. final decode
    if abort and abort.is_set():
        return
    lm_input = torch.concat([lm_input, text_cache, task_id_emb], dim=1)
    logging.info('no more text token, decode until met eos')
    while True:
        if abort and abort.is_set():
            return
        seq_len = lm_input.shape[1] if cache is None else lm_input.shape[1] + cache[0][0].size(2)
        y_pred, cache = self.llm.forward_one_step(lm_input,
                                                  masks=torch.tril(torch.ones((1, seq_len, seq_len), device=lm_input.device)).to(torch.bool),
                                                  cache=cache)
        logp = self.llm_decoder(y_pred[:, -1]).log_softmax(dim=-1)
        top_ids = self.sampling_ids(logp.squeeze(dim=0), out_tokens, sampling, ignore_eos=False)
        out_tokens.append(top_ids)
        if top_ids >= self.speech_token_size:
            if top_ids == self.eos_token:
                break
            else:
                raise ValueError('should not get token {}'.format(top_ids))
        yield top_ids
        lm_input = self.speech_embedding.weight[top_ids].reshape(1, 1, -1)


# ---- Main ----

def main():
    import numpy as np

    # Output buffer for chunking audio.
    # Audio is buffered by the synthesis thread (on_audio_samples) and emitted
    # exclusively by the main thread (emit_one_chunk / flush_output) one at a time.
    # This ensures that interrupt events are processed BEFORE any pending audio
    # reaches stdout, achieving zero post-interrupt chunk leakage.
    output_buffer: list[float] = []

    def on_audio_samples(pcm_16k):
        """Buffer 16kHz float32 samples. Does NOT emit -- the main thread
        handles emission via emit_one_chunk() one at a time, so interrupts are
        processed before any buffered audio reaches stdout."""
        nonlocal output_buffer
        if interrupted.is_set():
            return
        with emit_lock:
            if isinstance(pcm_16k, np.ndarray):
                output_buffer.extend(pcm_16k.tolist())
            else:
                output_buffer.extend(pcm_16k)

    def emit_one_chunk():
        """Emit at most ONE chunk from the output buffer. Returns True if emitted.

        Uses multiple layers of interrupt detection:
        1. interrupted Event (set by stdin_reader_thread instantly)
        2. select.select() on stdin (catches data before reader processes it)
        3. Brief GIL yield to let reader thread run
        4. Final interrupted check right before writing to stdout"""
        nonlocal output_buffer
        if interrupted.is_set():
            with emit_lock:
                output_buffer = []
            return False
        # Check if stdin has pending data (likely an interrupt).
        try:
            if select.select([sys.stdin], [], [], 0)[0]:
                return False
        except (ValueError, OSError):
            pass
        # Yield GIL so stdin_reader_thread can run and set interrupted.
        time.sleep(0)
        if interrupted.is_set():
            with emit_lock:
                output_buffer = []
            return False
        with emit_lock:
            if len(output_buffer) < SAMPLES_PER_CHUNK:
                return False
            chunk = output_buffer[:SAMPLES_PER_CHUNK]
            del output_buffer[:SAMPLES_PER_CHUNK]
        # Final check before writing to stdout.
        if interrupted.is_set():
            return False
        emit_audio_chunk(chunk)
        return True

    def flush_output():
        """Flush remaining buffered samples as padded chunks."""
        nonlocal output_buffer
        if interrupted.is_set():
            with emit_lock:
                output_buffer = []
            return
        with emit_lock:
            if not output_buffer:
                return
            # Pad to chunk boundary
            while len(output_buffer) % SAMPLES_PER_CHUNK != 0:
                output_buffer.append(0.0)
        # Emit remaining chunks
        while True:
            if interrupted.is_set():
                with emit_lock:
                    output_buffer = []
                return
            with emit_lock:
                if len(output_buffer) < SAMPLES_PER_CHUNK:
                    output_buffer = []
                    return
                chunk = output_buffer[:SAMPLES_PER_CHUNK]
                del output_buffer[:SAMPLES_PER_CHUNK]
            emit_audio_chunk(chunk)

    # Resolve and validate device
    device = resolve_device()
    device = validate_device(device)
    log("info", f"Using device: {device}")

    # Load model — resolve local HuggingFace cache path to skip network checks
    import time as _time
    _load_start = _time.monotonic()
    log("info", f"Loading CosyVoice3 model {MODEL_ID}...")
    log("info", f"Device: {device}")
    _ensure_cosyvoice_on_path()

    import torch
    from cosyvoice.cli.cosyvoice import AutoModel

    # Resolve local cache path: try HuggingFace cache first, then modelscope, then download
    local_model_dir = None
    hf_cache = os.path.expanduser(f"~/.cache/huggingface/hub/models--{MODEL_ID.replace('/', '--')}")
    hf_snapshots = os.path.join(hf_cache, "snapshots")
    if os.path.isdir(hf_snapshots):
        # Use the latest snapshot directory
        revs = [d for d in os.listdir(hf_snapshots) if os.path.isdir(os.path.join(hf_snapshots, d))]
        if revs:
            local_model_dir = os.path.join(hf_snapshots, revs[0])
            log("info", f"Using HuggingFace cache: {local_model_dir}")
    if not local_model_dir:
        ms_cache = os.path.expanduser(f"~/.cache/modelscope/hub/models/{MODEL_ID}")
        if os.path.isdir(ms_cache):
            local_model_dir = ms_cache
            log("info", f"Using ModelScope cache: {local_model_dir}")
    if not local_model_dir:
        log("info", f"No local cache found, downloading via huggingface_hub...")
        from huggingface_hub import snapshot_download
        local_model_dir = snapshot_download(MODEL_ID)
        log("info", f"Downloaded to: {local_model_dir}")

    log("info", f"Loading model from {local_model_dir}...")
    cosyvoice = AutoModel(model_dir=local_model_dir)
    _load_elapsed = _time.monotonic() - _load_start
    log("info", f"Model loaded in {_load_elapsed:.1f}s")

    # On CPU/MPS, convert model to float32 to avoid bfloat16 dtype mismatches
    if not torch.cuda.is_available():
        cosyvoice.model.llm = cosyvoice.model.llm.float()
        cosyvoice.model.flow = cosyvoice.model.flow.float()
        cosyvoice.model.hift = cosyvoice.model.hift.float()
        log("info", f"Converted model to float32 for {device}")

    # Log model details
    log("info", f"Model sample rate: {cosyvoice.sample_rate}Hz")
    param_count = sum(p.numel() for p in cosyvoice.model.llm.parameters()) / 1e6
    log("info", f"LLM parameters: {param_count:.0f}M on {device}")

    # Patch inference_bistream with abort support — allows clean mid-stream
    # cancellation without corrupting model state (no model reload needed).
    abort_event = threading.Event()
    cosyvoice.model.llm._abort = abort_event
    cosyvoice.model.llm.inference_bistream = types.MethodType(
        _abortable_inference_bistream, cosyvoice.model.llm
    )
    log("info", "Patched inference_bistream with abort support")

    # CosyVoice3 has no built-in SFT speakers -- always uses inference_zero_shot.
    # The <|endofprompt|> token is required in prompt_text for bistream mode.
    voice_path = VOICE
    prompt_text = PROMPT_TEXT
    if not voice_path:
        # Use the bundled reference voice from the CosyVoice repo
        voice_path = os.path.join(COSYVOICE_REPO_DIR, "asset", "zero_shot_prompt.wav")
        prompt_text = DEFAULT_PROMPT_TEXT
    elif not prompt_text:
        # User provided voice but no prompt text -- add minimal prompt with required token
        prompt_text = "You are a helpful assistant.<|endofprompt|>"
    elif "<|endofprompt|>" not in prompt_text:
        # Ensure the required token is present
        prompt_text = f"You are a helpful assistant.<|endofprompt|>{prompt_text}"

    log("info", f"Using zero-shot mode with voice: {voice_path}")

    model_sample_rate = cosyvoice.sample_rate
    log("info", f"Model loaded (model sample rate: {model_sample_rate}Hz)")

    # Set up resampler if model output rate differs from our output rate
    resample_fn = None
    if model_sample_rate != OUTPUT_SAMPLE_RATE:
        import torchaudio
        import torch
        resampler = torchaudio.transforms.Resample(
            orig_freq=model_sample_rate, new_freq=OUTPUT_SAMPLE_RATE
        )
        log("info", f"Resampling from {model_sample_rate}Hz to {OUTPUT_SAMPLE_RATE}Hz")
        def resample_fn(audio_np):
            tensor = torch.from_numpy(audio_np).unsqueeze(0)
            resampled = resampler(tensor)
            return resampled.squeeze(0).numpy()

    emit({"type": "lifecycle.ready", "component": COMPONENT})

    # State
    generating = False
    suppress_output = False
    use_direct_text_next = False  # After interrupt, buffer deltas and use direct text mode
    buffered_deltas: list[str] = []  # Buffer for deltas when in direct text mode
    interrupted = threading.Event()  # Set immediately on interrupt -- lock-free, instant

    # Start stdin reader thread -- passes interrupted event for instant signaling
    input_q: queue.Queue = queue.Queue()
    reader = threading.Thread(target=stdin_reader_thread, args=(input_q, interrupted), daemon=True)
    reader.start()
    text_q: queue.Queue | None = None
    synth_thread: threading.Thread | None = None
    synth_error: list = []
    emit_lock = threading.Lock()  # Guards output_buffer writes

    def run_synthesis(tq: queue.Queue, direct_text: str | None = None):
        """Synthesis thread: runs model inference with text generator or direct text.

        When interrupted, uses `continue` (not `break`) to drain the generator.
        This is essential because `tts()` has cleanup code (p.join() on llm_job
        thread, popping UUID from internal dicts) that only runs when the
        generator is fully consumed. Breaking out abandons the generator and
        leaves the model in a corrupted state.

        With the abort patch on inference_bistream, the drain is FAST:
        abort_event causes the LLM to stop generating tokens immediately,
        llm_job finishes, tts() sees llm_end_dict=True and yields one final
        chunk, then runs cleanup. Total drain time: < 1 second.
        """
        nonlocal suppress_output
        try:
            tts_text = direct_text if direct_text is not None else text_generator(tq)
            for output in cosyvoice.inference_zero_shot(
                tts_text=tts_text,
                prompt_text=prompt_text,
                prompt_wav=voice_path,
                stream=True,
            ):
                if interrupted.is_set() or suppress_output:
                    # Don't break -- must drain so tts() runs its cleanup code
                    # (joins llm_job thread, pops UUID from internal dicts).
                    # With the abort patch, this drains in < 1 second.
                    continue
                audio = output['tts_speech'].squeeze().cpu().numpy()
                if resample_fn is not None:
                    audio = resample_fn(audio)
                on_audio_samples(audio)
        except Exception as e:
            import traceback
            if not suppress_output:
                synth_error.append(str(e))
                log("error", f"Synthesis error: {e}\n{traceback.format_exc()}")
        finally:
            # Reset token_hop_len which gets mutated during streaming
            # (stream_scale_factor doubles it each yield: 25 -> 50 -> 100)
            cosyvoice.model.token_hop_len = 25
            cosyvoice.model.token_max_hop_len = 100
            if interrupted.is_set():
                log("info", "Synthesis thread drained after abort (model state clean)")

    def start_generation(direct_text: str | None = None):
        nonlocal generating, suppress_output, text_q, synth_thread, synth_error, draining_thread, cosyvoice
        was_interrupted = interrupted.is_set()
        # Wait for any previous synthesis thread to finish. With the abort
        # patch, interrupted synthesis exits quickly (no long drain).
        if draining_thread is not None:
            log("info", "Waiting for previous synthesis to complete...")
            draining_thread.join(timeout=10)
            if draining_thread.is_alive():
                log("warn", "Previous synthesis drain timed out")
            draining_thread = None
        # After interrupted synthesis, reload the model to guarantee clean state.
        # The abort patch + drain should clean up, but if the LLM's internal
        # KV cache or position counters are corrupted, only a fresh instance helps.
        print(f"DEBUG: was_interrupted={was_interrupted}, direct_text={'yes' if direct_text else 'no'}", file=sys.stderr, flush=True)
        if was_interrupted:
            print("DEBUG: Reloading AutoModel...", file=sys.stderr, flush=True)
            log("info", "Reloading CosyVoice model after interrupt for clean state...")
            cosyvoice = AutoModel(model_dir=MODEL_ID)
            if not torch.cuda.is_available():
                cosyvoice.model.llm = cosyvoice.model.llm.float()
                cosyvoice.model.flow = cosyvoice.model.flow.float()
                cosyvoice.model.hift = cosyvoice.model.hift.float()
            # Re-patch the new model instance with abort support
            abort_event.clear()
            cosyvoice.model.llm._abort = abort_event
            cosyvoice.model.llm.inference_bistream = types.MethodType(
                _abortable_inference_bistream, cosyvoice.model.llm
            )
            print("DEBUG: AutoModel reloaded and patched", file=sys.stderr, flush=True)
            log("info", "Model reloaded and patched successfully")
        suppress_output = False
        interrupted.clear()
        abort_event.clear()
        synth_error.clear()
        cosyvoice.model.token_hop_len = 25
        cosyvoice.model.token_max_hop_len = 100
        text_q = queue.Queue()
        synth_thread = threading.Thread(
            target=run_synthesis,
            args=(text_q,),
            kwargs={"direct_text": direct_text},
            daemon=True,
        )
        synth_thread.start()
        generating = True

    def signal_end_of_text():
        """Signal end of text input (non-blocking). The synthesis thread will
        finish on its own; the event loop detects completion via is_alive()."""
        if text_q is not None:
            text_q.put(_DONE)

    def wait_for_completion():
        """Block until synthesis thread finishes, then flush and clean up state.
        Only used when the event loop needs to wait (e.g., idle-branch complete).
        Remains responsive to interrupts during the wait. Also emits buffered
        chunks while waiting (since the main thread is the only emitter)."""
        nonlocal generating, text_q, synth_thread
        signal_end_of_text()
        got_eof = False
        if synth_thread is not None:
            # Poll instead of blocking join so we can still process interrupts
            while synth_thread.is_alive():
                # Emit any buffered audio while waiting
                if not suppress_output:
                    emit_one_chunk()
                try:
                    event = input_q.get(timeout=0.05)
                except queue.Empty:
                    continue
                if isinstance(event, dict) and event.get("type") == "control.interrupt":
                    log("warn", "[waiting] interrupt during synthesis -- aborting")
                    abort_generation()
                    return
                elif event is _EOF:
                    # stdin closed -- let synthesis finish naturally, then exit
                    got_eof = True
                else:
                    # Re-queue other events for later processing
                    input_q.put(event)
            synth_thread = None
        text_q = None
        if not suppress_output:
            flush_output()
        generating = False
        if got_eof:
            # Re-inject EOF so the main event loop exits
            input_q.put(_EOF)

    # Track the draining synth thread so start_generation can wait for it
    draining_thread: threading.Thread | None = None

    def abort_generation():
        """Abort current generation -- suppress output, signal abort to LLM.
        Sets use_direct_text_next so the next utterance bypasses the potentially
        corrupted bistream path and uses direct text mode instead."""
        nonlocal generating, suppress_output, text_q, synth_thread, output_buffer, draining_thread, use_direct_text_next, buffered_deltas
        # Set abort_event FIRST -- causes inference_bistream to return immediately
        abort_event.set()
        interrupted.set()
        suppress_output = True
        with emit_lock:
            output_buffer = []
        if text_q is not None:
            # Drain pending text and push _DONE so text_generator returns
            while not text_q.empty():
                try:
                    text_q.get_nowait()
                except queue.Empty:
                    break
            text_q.put(_DONE)
        if synth_thread is not None:
            draining_thread = synth_thread
            synth_thread = None
        text_q = None
        generating = False
        use_direct_text_next = True
        buffered_deltas = []

    # Event loop
    while True:
        if generating:
            # Check for events first (non-blocking if we have audio to emit,
            # short wait otherwise). This ensures interrupts are always
            # processed BEFORE any buffered audio reaches stdout.
            has_audio = not suppress_output and len(output_buffer) >= SAMPLES_PER_CHUNK
            try:
                event = input_q.get(timeout=0.005 if has_audio else 0.05)
            except queue.Empty:
                # No event -- emit ONE audio chunk, then loop back to check
                # input_q again. Emitting one-at-a-time ensures an interrupt
                # arriving between chunks is processed before the next chunk.
                if not suppress_output:
                    emit_one_chunk()
                # Check if synthesis thread finished on its own
                if synth_thread is not None and not synth_thread.is_alive():
                    if not suppress_output:
                        flush_output()
                    generating = False
                    synth_thread = None
                    text_q = None
                continue

            # Process event BEFORE emitting any buffered audio -- this ensures
            # interrupt/tool_start cancels pending chunks before they reach stdout.
            if event is _EOF:
                # stdin closed -- signal end of text and wait for synthesis
                # to finish naturally (don't abort/suppress output).
                signal_end_of_text()
                if synth_thread is not None:
                    # Emit chunks while waiting for synthesis to finish
                    while synth_thread.is_alive():
                        emit_one_chunk()
                        synth_thread.join(timeout=0.05)
                    synth_thread = None
                text_q = None
                flush_output()
                generating = False
                break
            elif event is _INTERRUPT or (isinstance(event, dict) and event.get("type") == "control.interrupt"):
                log("warn", "[generating] interrupt -- aborting synthesis")
                abort_generation()
                continue
            elif isinstance(event, dict):
                etype = event.get("type", "")
                if etype == "agent.delta":
                    delta = event.get("delta", "")
                    if delta and text_q is not None:
                        text_q.put(delta)
                elif etype == "agent.complete":
                    # Signal end of text -- the event loop will detect
                    # thread completion and remain responsive to interrupts.
                    signal_end_of_text()
                    continue
                elif etype == "agent.tool_start":
                    # tool_start stops synthesis immediately like interrupt
                    log("info", "[generating] tool_start -- aborting synthesis")
                    abort_generation()
                    continue
        else:
            try:
                event = input_q.get(timeout=0.5)
            except queue.Empty:
                continue

            if event is _EOF:
                break
            elif not isinstance(event, dict):
                continue

            etype = event.get("type", "")

            if etype == "agent.delta":
                delta = event.get("delta", "")
                if delta:
                    if use_direct_text_next:
                        # After interrupt: buffer deltas, don't start generator
                        buffered_deltas.append(delta)
                    else:
                        log("info", "Starting streaming synthesis...")
                        start_generation()
                        text_q.put(delta)

            elif etype == "agent.complete":
                full_text = event.get("text", "")
                if use_direct_text_next:
                    # After interrupt: use direct text mode (bypasses bistream)
                    combined = "".join(buffered_deltas)
                    if full_text:
                        combined = full_text  # prefer complete text if provided
                    elif not combined:
                        continue
                    log("info", f"[post-interrupt] Synthesizing via direct text: {combined[:80]}...")
                    use_direct_text_next = False
                    buffered_deltas = []
                    start_generation(direct_text=combined)
                    wait_for_completion()
                    continue
                elif full_text:
                    log("info", f"Synthesizing complete text: {full_text[:80]}...")
                    start_generation(direct_text=full_text)
                    wait_for_completion()
                    continue

            elif etype == "agent.tool_start":
                pass

            elif etype == "control.interrupt":
                efrom = event.get("_from", "?")
                log("warn", f"[idle] interrupt dequeued from={efrom}")

    emit({"type": "lifecycle.done", "component": COMPONENT})


if __name__ == "__main__":
    main()
