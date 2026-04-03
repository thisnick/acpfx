# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "moshi>=0.2.11",
#     "moshi-mlx>=0.2.6; sys_platform == 'darwin'",
#     "torch>=2.0; sys_platform != 'darwin'",
#     "huggingface-hub",
#     "sentencepiece",
#     "sphn",
#     "numpy",
# ]
# ///
"""
stt-kyutai node — Local STT via Kyutai moshi (delayed-streams-modeling).

Backend selection:
  macOS:         MLX (moshi-mlx) — optimized for Apple Silicon
  Linux/Windows: PyTorch (moshi) — CUDA when available, CPU fallback

NDJSON stdio contract:
  stdin:  audio.chunk
  stdout: speech.partial, speech.final, speech.pause, lifecycle.ready, lifecycle.done, log

Architecture:
  - stdin reader thread -> input_queue (Queue)
  - main thread: unified event loop calls SttBackend methods
  - SttBackend ABC with MlxBackend and PyTorchBackend implementations
  - Only one thread touches the model and stdout
"""

import abc
import base64
import json
import os
import queue
import struct
import sys
import threading

NODE_NAME = os.environ.get("ACPFX_NODE_NAME", "stt-kyutai")
COMPONENT = "stt-kyutai"
SETTINGS = json.loads(os.environ.get("ACPFX_SETTINGS", "{}"))

MODEL_ID = SETTINGS.get("model", "kyutai/stt-1b-en_fr")
DEVICE_PREF = SETTINGS.get("device", "auto")

MODEL_SAMPLE_RATE = 24000
INPUT_SAMPLE_RATE = 16000
# moshi expects 1920-sample chunks at 24kHz (80ms)
MOSHI_CHUNK_SIZE = 1920


def emit(event: dict):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def log(level: str, message: str):
    emit({"type": "log", "level": level, "component": COMPONENT, "message": message})


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
    script_path = os.path.abspath(sys.argv[0])
    base = os.path.splitext(script_path)[0]
    for path in [f"{base}.manifest.json", f"{base}.manifest.yaml"]:
        if os.path.exists(path):
            with open(path) as f:
                print(f.read().strip())
            sys.exit(0)
    print(json.dumps({
        "name": "stt-kyutai",
        "description": "Local STT via Kyutai moshi (on-device, GPU)",
        "consumes": ["audio.chunk"],
        "emits": ["speech.partial", "speech.final", "speech.pause",
                   "lifecycle.ready", "lifecycle.done", "log"],
    }))
    sys.exit(0)


def _handle_setup_check():
    cache_dir = os.path.expanduser("~/.cache/huggingface/hub")
    repo_dir = os.path.join(cache_dir, f"models--{MODEL_ID.replace('/', '--')}")
    snapshots = os.path.join(repo_dir, "snapshots")

    if not os.path.isdir(snapshots):
        print(json.dumps({"needed": True, "description": f"Download {MODEL_ID} model files"}))
        sys.exit(0)

    has_weights = False
    for rev in os.listdir(snapshots):
        rev_dir = os.path.join(snapshots, rev)
        if os.path.isdir(rev_dir):
            safetensors = [f for f in os.listdir(rev_dir) if f.endswith(".safetensors")]
            if len(safetensors) >= 2:
                has_weights = True
                break

    print(json.dumps({"needed": not has_weights}
          | ({"description": f"Download {MODEL_ID} model files"} if not has_weights else {})))
    sys.exit(0)


def _handle_setup():
    try:
        print(json.dumps({"type": "progress", "message": f"Loading checkpoint info for {MODEL_ID}...", "pct": 0}))
        from huggingface_hub import hf_hub_download

        print(json.dumps({"type": "progress", "message": "Downloading config.json...", "pct": 10}))
        config_path = hf_hub_download(repo_id=MODEL_ID, filename="config.json")
        with open(config_path) as f:
            config = json.load(f)

        files_to_download = ["model.safetensors"]
        if "mimi_name" in config:
            files_to_download.append(config["mimi_name"])
        if "tokenizer_name" in config:
            files_to_download.append(config["tokenizer_name"])

        total = len(files_to_download) + 1  # +1 for config already done
        for i, filename in enumerate(files_to_download):
            pct = int((i + 1) * 100 / total)
            print(json.dumps({"type": "progress", "message": f"Downloading {filename}...", "pct": pct}))
            hf_hub_download(repo_id=MODEL_ID, filename=filename)

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

_EOF = object()


def stdin_reader_thread(input_q: queue.Queue):
    """Read NDJSON from stdin, parse events, put on queue. Runs in background thread."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        input_q.put(event)
    input_q.put(_EOF)


def resolve_device():
    if DEVICE_PREF != "auto":
        return DEVICE_PREF
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def decode_pcm_s16le(b64_data: str):
    """Decode base64 PCM s16le to list of float32 samples."""
    raw = base64.b64decode(b64_data)
    n_samples = len(raw) // 2
    samples = struct.unpack(f"<{n_samples}h", raw)
    return [s / 32768.0 for s in samples]


# ---- Backend ABC ----

class SttBackend(abc.ABC):
    """Abstract interface for STT backends (MLX or PyTorch)."""

    @abc.abstractmethod
    def load(self) -> None:
        """Load model weights and prepare for streaming. Emit lifecycle.ready when done."""
        ...

    @abc.abstractmethod
    def process_audio(self, pcm_24k: list[float]) -> None:
        """Process a 1920-sample chunk of 24kHz float32 audio."""
        ...

    @abc.abstractmethod
    def stop(self) -> None:
        """Clean up resources."""
        ...


# ---- MLX Backend ----

class MlxBackend(SttBackend):
    def __init__(self, on_word, on_end_word, on_vad):
        self.on_word = on_word
        self.on_end_word = on_end_word
        self.on_vad = on_vad
        self.model = None
        self.gen = None
        self.audio_tokenizer = None
        self.tokenizer = None

    def load(self):
        import mlx.core as mx
        import mlx.nn as nn
        import sentencepiece

        self.mx = mx

        log("info", "Using MLX backend")
        log("info", f"Loading model {MODEL_ID}...")

        from moshi_mlx import models, utils
        from moshi_mlx.utils.loaders import hf_get

        # Load config
        raw_config_path = hf_get("config.json", MODEL_ID)
        with open(raw_config_path, "r") as f:
            raw_config = json.load(f)

        # Load weights and tokenizer paths
        mimi_weights = hf_get(raw_config["mimi_name"], MODEL_ID)
        moshi_weights = hf_get(raw_config.get("moshi_name", "model.safetensors"), MODEL_ID)
        tokenizer_path = hf_get(raw_config["tokenizer_name"], MODEL_ID)

        # Build LM
        lm_config = models.LmConfig.from_config_dict(raw_config)
        lm_config.transformer.max_seq_len = lm_config.transformer.context
        model = models.Lm(lm_config)
        model.set_dtype(mx.bfloat16)
        model.load_pytorch_weights(str(moshi_weights), lm_config, strict=True)

        # Int8 quantization for speed
        nn.quantize(model.depformer, bits=8)
        for layer in model.transformer.layers:
            nn.quantize(layer.self_attn, bits=8)
            nn.quantize(layer.gating, bits=8)

        # Text tokenizer
        self.tokenizer = sentencepiece.SentencePieceProcessor(str(tokenizer_path))

        # Audio tokenizer
        n_q = raw_config.get("n_q", 32)
        self.audio_tokenizer = models.mimi.Mimi(models.mimi_202407(n_q))
        self.audio_tokenizer.load_pytorch_weights(str(mimi_weights), strict=True)

        # Build LmGen with VAD extra heads
        self.gen = models.LmGen(
            model,
            max_steps=4096,
            text_sampler=utils.Sampler(top_k=25, temp=0),
            audio_sampler=utils.Sampler(top_k=250, temp=0.8),
            check=False,
        )

        self.model = model

        # Prepend silence frames based on config
        stt_config = raw_config.get("stt_config", {})
        silence_seconds = stt_config.get("audio_silence_prefix_seconds", 0)
        silence_frames = int(silence_seconds * 12.5)  # 12.5 frames/sec at 24kHz/1920

        if silence_frames > 0:
            log("info", f"Prepending {silence_frames} silence frames ({silence_seconds}s)")
            silence_chunk = mx.zeros((1, 1, MOSHI_CHUNK_SIZE))
            for _ in range(silence_frames):
                other_audio_tokens = self.audio_tokenizer.encode_step(silence_chunk).transpose(0, 2, 1)
                self.gen.step_with_extra_heads(other_audio_tokens[0])
                mx.eval(self.gen._text_token)

        log("info", "Model loaded (MLX)")
        emit({"type": "lifecycle.ready", "component": COMPONENT})

    def process_audio(self, pcm_24k):
        mx = self.mx

        block = mx.array(pcm_24k)[None, None, :]  # shape (1, 1, 1920)
        other_audio_tokens = self.audio_tokenizer.encode_step(block).transpose(0, 2, 1)
        text_token, vad_heads = self.gen.step_with_extra_heads(other_audio_tokens[0])

        # Force evaluation
        mx.eval(text_token)
        if vad_heads:
            mx.eval(*vad_heads)

        text_token_val = text_token[0].item()

        # Decode text token
        if text_token_val not in (0, 3):  # not padding/special
            word = self.tokenizer.id_to_piece(text_token_val).replace("\u2581", " ")
            self.on_word(word)
        else:
            self.on_end_word()

        # VAD check
        if vad_heads and len(vad_heads) > 2:
            pr_vad = vad_heads[2][0, 0, 0].item() if vad_heads[2].size > 0 else 0.0
            if pr_vad > 0.5:
                self.on_vad()

    def stop(self):
        self.gen = None
        self.model = None
        self.audio_tokenizer = None


# ---- PyTorch Backend ----

class PyTorchBackend(SttBackend):
    def __init__(self, on_word, on_end_word, on_vad):
        self.on_word = on_word
        self.on_end_word = on_end_word
        self.on_vad = on_vad
        self.mimi = None
        self.lm_gen = None
        self.tokenizer = None
        self._device = None
        self._mimi_ctx = None
        self._lm_ctx = None

    def load(self):
        import torch
        import sentencepiece

        torch.set_grad_enabled(False)

        device = resolve_device()
        self._device = device
        log("info", f"Using PyTorch backend ({device})")
        log("info", f"Loading model {MODEL_ID} on {device}...")

        from moshi.models.loaders import CheckpointInfo, get_moshi, get_mimi, get_text_tokenizer
        from moshi.models import LMGen

        info = CheckpointInfo.from_hf_repo(MODEL_ID)

        self.mimi = info.get_mimi(device=device)
        self.tokenizer = info.get_text_tokenizer()
        lm = info.get_moshi(device=device, dtype=torch.bfloat16)
        self.lm_gen = LMGen(lm, temp=0, temp_text=0.0)

        # Enter streaming contexts
        self._mimi_ctx = self.mimi.streaming(1)
        self._mimi_ctx.__enter__()
        self._lm_ctx = self.lm_gen.streaming(1)
        self._lm_ctx.__enter__()

        # Prepend silence frames based on config
        config_path = info._get("config.json")
        with open(config_path) as f:
            raw_config = json.load(f)

        stt_config = raw_config.get("stt_config", {})
        silence_seconds = stt_config.get("audio_silence_prefix_seconds", 0)
        silence_frames = int(silence_seconds * 12.5)

        if silence_frames > 0:
            log("info", f"Prepending {silence_frames} silence frames ({silence_seconds}s)")
            silence_chunk = torch.zeros(1, 1, MOSHI_CHUNK_SIZE, device=device)
            for _ in range(silence_frames):
                audio_tokens = self.mimi.encode(silence_chunk)
                self.lm_gen.step_with_extra_heads(audio_tokens)

        log("info", f"Model loaded on {device}")
        emit({"type": "lifecycle.ready", "component": COMPONENT})

    def process_audio(self, pcm_24k):
        import torch

        device = self._device
        pcm_tensor = torch.tensor(pcm_24k, dtype=torch.float32).reshape(1, 1, -1).to(device)
        audio_tokens = self.mimi.encode(pcm_tensor)
        text_tokens, vad_heads = self.lm_gen.step_with_extra_heads(audio_tokens)

        text_token = text_tokens[0, 0, 0].cpu().item()

        # Decode text token
        if text_token not in (0, 3):  # not padding/special
            word = self.tokenizer.id_to_piece(text_token).replace("\u2581", " ")
            self.on_word(word)
        else:
            self.on_end_word()

        # VAD check
        if vad_heads and len(vad_heads) > 2:
            pr_vad = vad_heads[2][0, 0, 0].cpu().item()
            if pr_vad > 0.5:
                self.on_vad()

    def stop(self):
        if self._lm_ctx is not None:
            self._lm_ctx.__exit__(None, None, None)
            self._lm_ctx = None
        if self._mimi_ctx is not None:
            self._mimi_ctx.__exit__(None, None, None)
            self._mimi_ctx = None
        self.lm_gen = None
        self.mimi = None


# ---- Main ----

def main():
    import numpy as np

    # Backend detection
    USE_MLX = False
    try:
        import mlx.core as mx
        USE_MLX = True
    except ImportError:
        pass

    # Text accumulation state
    accumulated_text = ""
    pending_text = ""

    def on_word(word: str):
        nonlocal accumulated_text
        accumulated_text += word
        partial = accumulated_text.strip()
        if partial:
            emit({
                "type": "speech.partial",
                "trackId": "stt",
                "text": f"{pending_text}{partial}",
            })

    def on_end_word():
        nonlocal accumulated_text, pending_text
        word_text = accumulated_text.strip()
        if word_text:
            pending_text += word_text + " "
            emit({
                "type": "speech.final",
                "trackId": "stt",
                "text": word_text,
            })
            accumulated_text = ""

    def on_vad():
        nonlocal accumulated_text, pending_text
        full_text = f"{pending_text}{accumulated_text.strip()}".strip()
        if full_text:
            emit({
                "type": "speech.pause",
                "trackId": "stt",
                "pendingText": full_text,
                "silenceMs": 2000,
            })
            pending_text = ""
            accumulated_text = ""

    # Set up resampler: 16kHz -> 24kHz
    def resample_16k_to_24k_np(pcm_16k):
        n = len(pcm_16k)
        n_out = int(n * MODEL_SAMPLE_RATE / INPUT_SAMPLE_RATE)
        indices = np.linspace(0, n - 1, n_out)
        arr = pcm_16k if isinstance(pcm_16k, np.ndarray) else np.array(pcm_16k)
        return np.interp(indices, np.arange(n), arr)

    resample_fn = resample_16k_to_24k_np
    if not USE_MLX:
        try:
            import torch
            import torchaudio.functional as F

            def resample_16k_to_24k_torch(pcm_16k):
                t = torch.from_numpy(np.array(pcm_16k, dtype=np.float32)).unsqueeze(0)
                resampled = F.resample(t, INPUT_SAMPLE_RATE, MODEL_SAMPLE_RATE)
                return resampled.squeeze(0).numpy()

            resample_fn = resample_16k_to_24k_torch
        except ImportError:
            log("warn", "torchaudio not available, using simple resampling")

    # Create and load backend
    if USE_MLX:
        backend: SttBackend = MlxBackend(on_word, on_end_word, on_vad)
    else:
        backend = PyTorchBackend(on_word, on_end_word, on_vad)

    backend.load()

    # Start stdin reader thread
    input_q: queue.Queue = queue.Queue()
    reader = threading.Thread(target=stdin_reader_thread, args=(input_q,), daemon=True)
    reader.start()

    # Audio buffer for accumulating resampled samples at 24kHz
    audio_buffer: list[float] = []

    # Event loop: read audio.chunk events and feed to model
    while True:
        try:
            event = input_q.get(timeout=0.5)
        except queue.Empty:
            continue

        if event is _EOF:
            break
        if not isinstance(event, dict):
            continue

        event_type = event.get("type", "")
        if event_type != "audio.chunk":
            continue

        data = event.get("data")
        if not data:
            continue

        # Decode PCM s16le to f32 at 16kHz
        samples_16k = decode_pcm_s16le(data)
        if not samples_16k:
            continue

        # Resample 16kHz -> 24kHz
        samples_24k = resample_fn(samples_16k)
        audio_buffer.extend(samples_24k.tolist() if hasattr(samples_24k, 'tolist') else samples_24k)

        # Feed model in MOSHI_CHUNK_SIZE (1920) sample chunks
        while len(audio_buffer) >= MOSHI_CHUNK_SIZE:
            chunk = audio_buffer[:MOSHI_CHUNK_SIZE]
            del audio_buffer[:MOSHI_CHUNK_SIZE]
            backend.process_audio(chunk)

    backend.stop()
    emit({"type": "lifecycle.done", "component": COMPONENT})


if __name__ == "__main__":
    main()
