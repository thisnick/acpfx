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
tts-kyutai node — Local TTS via Kyutai moshi (delayed-streams-modeling).

Backend selection:
  macOS:         MLX (moshi-mlx) — optimized for Apple Silicon
  Linux/Windows: PyTorch (moshi) — CUDA when available, CPU fallback

NDJSON stdio contract:
  stdin:  agent.delta, agent.complete, agent.tool_start, control.interrupt
  stdout: audio.chunk, lifecycle.ready, lifecycle.done, log

Architecture:
  - stdin reader thread -> input_queue (Queue)
  - main thread: unified event loop calls TtsBackend methods
  - TtsBackend ABC with MlxBackend and PyTorchBackend implementations
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

NODE_NAME = os.environ.get("ACPFX_NODE_NAME", "tts-kyutai")
COMPONENT = "tts-kyutai"
SETTINGS = json.loads(os.environ.get("ACPFX_SETTINGS", "{}"))

MODEL_ID = SETTINGS.get("model", "kyutai/tts-1.6b-en_fr")
DEFAULT_VOICE = "expresso/ex03-ex01_happy_001_channel1_334s.wav"
VOICE = SETTINGS.get("voice", DEFAULT_VOICE)
if VOICE == "default":
    VOICE = DEFAULT_VOICE
DEVICE_PREF = SETTINGS.get("device", "auto")

OUTPUT_SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100
SAMPLES_PER_CHUNK = OUTPUT_SAMPLE_RATE * CHUNK_DURATION_MS // 1000  # 1600


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
    script_path = os.path.abspath(sys.argv[0])
    base = os.path.splitext(script_path)[0]
    for path in [f"{base}.manifest.json", f"{base}.manifest.yaml"]:
        if os.path.exists(path):
            with open(path) as f:
                print(f.read().strip())
            sys.exit(0)
    print(json.dumps({
        "name": "tts-kyutai",
        "description": "Local TTS via Kyutai moshi (on-device, GPU)",
        "consumes": ["agent.delta", "agent.complete", "agent.tool_start", "control.interrupt"],
        "emits": ["audio.chunk", "lifecycle.ready", "lifecycle.done", "log"],
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
        from moshi.models.loaders import CheckpointInfo
        checkpoint_info = CheckpointInfo.from_hf_repo(MODEL_ID)

        print(json.dumps({"type": "progress", "message": "Downloading model weights and tokenizer...", "pct": 20}))
        import torch
        from moshi.models.tts import TTSModel
        _model = TTSModel.from_checkpoint_info(checkpoint_info, n_q=32, temp=0.6, device="cpu")
        del _model

        print(json.dumps({"type": "progress", "message": "Downloading voice embeddings...", "pct": 80}))
        from moshi.models.tts import DEFAULT_DSM_TTS_VOICE_REPO
        from huggingface_hub import hf_hub_download
        try:
            hf_hub_download(repo_id=DEFAULT_DSM_TTS_VOICE_REPO, filename=VOICE)
        except Exception:
            pass

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


# ---- Backend ABC ----

class TtsBackend(abc.ABC):
    """Abstract interface for TTS backends (MLX or PyTorch)."""

    @abc.abstractmethod
    def load(self) -> None:
        """Load model weights and prepare for generation. Emit lifecycle.ready when done."""
        ...

    @abc.abstractmethod
    def start_utterance(self) -> None:
        """Reset state for a new utterance."""
        ...

    @abc.abstractmethod
    def feed_text(self, word: str, first_turn: bool) -> None:
        """Tokenize and append a word's entries to the generation state."""
        ...

    @abc.abstractmethod
    def step(self) -> bool:
        """Run one generation step. Return True if an audio frame was produced."""
        ...

    @abc.abstractmethod
    def is_done(self) -> bool:
        """True if all entries consumed and delay flushed."""
        ...

    @abc.abstractmethod
    def stop(self) -> None:
        """Abort current generation, clear state."""
        ...

    @abc.abstractmethod
    def flush_remaining(self) -> None:
        """Process remaining entries until generation is complete."""
        ...


# ---- MLX Backend ----

class MlxBackend(TtsBackend):
    def __init__(self, on_audio_samples):
        self.on_audio_samples = on_audio_samples
        self.tts_model = None
        self.lm_gen = None
        self.state = None
        self.ct = None
        self.ca_src = None
        self.offset = 0
        self._voices = []
        self._cfg_coef_conditioning = None
        self._cfg_is_no_text = True
        self._cfg_is_no_prefix = True

    def load(self):
        import mlx.core as mx
        import mlx.nn as nn
        import numpy as np
        import sentencepiece

        self.mx = mx
        self.nn = nn
        self.np = np

        log("info", "Using MLX backend")
        log("info", f"Loading model {MODEL_ID}...")

        from moshi_mlx import models
        from moshi_mlx.models.tts import TTSModel, DEFAULT_DSM_TTS_VOICE_REPO
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

        # Text and audio tokenizers
        text_tokenizer = sentencepiece.SentencePieceProcessor(str(tokenizer_path))
        audio_tokenizer = models.mimi.Mimi(models.mimi_202407(lm_config.generated_codebooks))
        audio_tokenizer.load_pytorch_weights(str(mimi_weights), strict=True)

        # Build TTSModel
        tts_model = TTSModel(model, audio_tokenizer, text_tokenizer,
            voice_repo=DEFAULT_DSM_TTS_VOICE_REPO, temp=0.6, cfg_coef=1,
            max_padding=8, initial_padding=2, final_padding=2,
            padding_bonus=0, raw_config=raw_config)

        self.tts_model = tts_model

        # Voice loading
        if tts_model.multi_speaker:
            self._voices = [tts_model.get_voice_path(VOICE)]
        else:
            self._voices = []

        self._cfg_coef_conditioning = None
        if tts_model.valid_cfg_conditionings:
            self._cfg_coef_conditioning = tts_model.cfg_coef
            tts_model.cfg_coef = 1.0
            self._cfg_is_no_text = False
            self._cfg_is_no_prefix = False
        else:
            self._cfg_is_no_text = True
            self._cfg_is_no_prefix = True

        log("info", "Model loaded (MLX)")
        emit({"type": "lifecycle.ready", "component": COMPONENT})

    def _build_conditioning(self):
        """Build ct and cross_attention_src from attributes (same as generate())."""
        mx = self.mx
        from moshi_mlx.models.tts import _make_null, ConditionTensor

        tts_model = self.tts_model
        attributes = [tts_model.make_condition_attributes(self._voices, self._cfg_coef_conditioning)]

        if tts_model.cfg_coef != 1.0:
            if tts_model.valid_cfg_conditionings:
                raise ValueError("Model uses CFG distillation, not direct CFG")
            nulled = _make_null(attributes)
            attributes = list(attributes) + nulled

        ct_list = []
        cross_attention_src_list = []

        for _attr in attributes:
            ct = None
            cross_attention_src = None
            for _key, _value in _attr.text.items():
                _ct = tts_model.lm.condition_provider.condition_tensor(_key, _value)
                tensor = _ct.tensor.squeeze(0)
                ct = tensor if ct is None else ct + tensor
            ct_list.append(ct)
            for _key, _value in _attr.tensor.items():
                _conditioner = tts_model.lm.condition_provider.conditioners[_key]
                _ca_src = _conditioner.condition(_value)
                if cross_attention_src is None:
                    cross_attention_src = _ca_src
                else:
                    raise ValueError("multiple cross-attention conditioners")
            cross_attention_src_list.append(cross_attention_src)

        self.ca_src = mx.concatenate(cross_attention_src_list, axis=0)
        self.ct = ConditionTensor(mx.stack(ct_list, axis=0))

    def start_utterance(self):
        mx = self.mx
        tts_model = self.tts_model

        # Reset caches
        for c in tts_model.lm.transformer_cache:
            c.reset()
        for c in tts_model.lm.depformer_cache:
            c.reset()
        tts_model.mimi.reset_all()

        # Build conditioning
        self._build_conditioning()

        # Create empty state
        self.state = tts_model.machine.new_state([])

        # Build hooks
        from moshi_mlx.utils.sampling import Sampler as MlxSampler

        def _on_audio_hook(audio_tokens):
            delays = tts_model.lm.delays
            for q in range(audio_tokens.shape[1]):
                delay = delays[q]
                if self.offset < delay + tts_model.delay_steps:
                    audio_tokens[:, q] = tts_model.machine.token_ids.zero

        def _on_text_hook(text_tokens):
            tokens = text_tokens.tolist()
            out_tokens = []
            for token in tokens:
                out_token, _ = tts_model.machine.process(self.offset, self.state, token[0])
                out_tokens.append(out_token)
            text_tokens[:] = mx.array(out_tokens, dtype=mx.int64)[:, None]

        from moshi_mlx.models.generate import LmGen as MlxLmGen

        self.lm_gen = MlxLmGen(
            tts_model.lm,
            max_steps=tts_model.max_gen_length,
            text_sampler=MlxSampler(temp=tts_model.temp),
            audio_sampler=MlxSampler(temp=tts_model.temp),
            batch_size=1,
            cfg_coef=tts_model.cfg_coef,
            on_text_hook=_on_text_hook,
            on_audio_hook=_on_audio_hook,
        )

        self.offset = 0

    def feed_text(self, word: str, first_turn: bool):
        from moshi_mlx.models.tts import script_to_entries
        tts_model = self.tts_model
        multi_speaker = first_turn and tts_model.multi_speaker
        entries = script_to_entries(
            tts_model.tokenizer,
            tts_model.machine.token_ids,
            tts_model.mimi.frame_rate,
            [word],
            multi_speaker=multi_speaker,
            padding_between=0,
        )
        for entry in entries:
            self.state.entries.append(entry)
        # Reset end_step if new entries arrived — prevents premature termination
        # when streaming words with gaps between deltas
        if self.state.end_step is not None:
            self.state.end_step = None

    def step(self) -> bool:
        mx = self.mx
        tts_model = self.tts_model

        missing = tts_model.lm.n_q - tts_model.lm.dep_q
        input_tokens = mx.ones((1, missing), dtype=mx.int64) * tts_model.machine.token_ids.zero
        self.lm_gen.step(input_tokens, ct=self.ct, cross_attention_src=self.ca_src)
        frame = self.lm_gen.last_audio_tokens()
        self.offset += 1

        if frame is not None and (frame != tts_model.machine.token_ids.zero).all():
            # Decode audio frame
            pcm = tts_model.mimi.decode_step(frame[:, :, None])
            pcm_24k = self.np.array(mx.clip(pcm[0, 0], -1, 1))
            self.on_audio_samples(pcm_24k)
            return True
        return False

    def is_done(self) -> bool:
        if self.state is None:
            return True
        if self.state.end_step is not None:
            tts_model = self.tts_model
            return self.offset >= self.state.end_step + tts_model.delay_steps + tts_model.final_padding
        return False

    def stop(self):
        self.lm_gen = None
        self.state = None

    def flush_remaining(self):
        while not self.is_done():
            self.step()


# ---- PyTorch Backend ----

class PyTorchBackend(TtsBackend):
    def __init__(self, on_audio_samples):
        self.on_audio_samples = on_audio_samples
        self.tts_model = None
        self.condition_attributes = None
        self.gen = None
        self.mimi_streaming_ctx = None
        self._device = None

    def load(self):
        import torch
        import numpy as np

        torch.set_grad_enabled(False)

        self.np = np
        device = resolve_device()
        self._device = device
        log("info", f"Using PyTorch backend ({device})")
        log("info", f"Loading model {MODEL_ID} on {device}...")

        from moshi.models.loaders import CheckpointInfo
        from moshi.models.tts import TTSModel, DEFAULT_DSM_TTS_VOICE_REPO

        checkpoint_info = CheckpointInfo.from_hf_repo(MODEL_ID)
        tts_model = TTSModel.from_checkpoint_info(
            checkpoint_info, n_q=32, temp=0.6, device=device
        )
        self.tts_model = tts_model

        # Load voice conditioning
        voice_path = VOICE
        if not voice_path.endswith(".safetensors"):
            try:
                voice_path = tts_model.get_voice_path(voice_path)
            except Exception as e:
                log("warn", f"Could not load voice '{VOICE}': {e}, using default")
                voice_path = tts_model.get_voice_path(DEFAULT_VOICE)

        self.condition_attributes = tts_model.make_condition_attributes(
            [voice_path], cfg_coef=2.0
        )

        log("info", f"Model loaded on {device}")
        emit({"type": "lifecycle.ready", "component": COMPONENT})

    def start_utterance(self):
        import torch
        from moshi.conditioners import dropout_all_conditions
        from moshi.models.lm import LMGen

        tts_model = self.tts_model

        # Enter mimi streaming context
        self.mimi_streaming_ctx = tts_model.mimi.streaming(1)
        self.mimi_streaming_ctx.__enter__()

        def _make_null_pt(attrs):
            return dropout_all_conditions(attrs)

        attrs = [self.condition_attributes]
        if tts_model.cfg_coef != 1.0:
            if tts_model.valid_cfg_conditionings:
                raise ValueError("Model uses CFG distillation, not direct CFG")
            nulled = _make_null_pt(attrs)
            attrs = attrs + nulled

        assert tts_model.lm.condition_provider is not None
        prepared = tts_model.lm.condition_provider.prepare(attrs)
        condition_tensors = tts_model.lm.condition_provider(prepared)

        self._state = tts_model.machine.new_state([])
        self._offset = 0
        on_audio_samples = self.on_audio_samples

        def _on_text_logits_hook(text_logits):
            if tts_model.padding_bonus:
                text_logits[..., tts_model.machine.token_ids.pad] += tts_model.padding_bonus
            return text_logits

        def _on_audio_hook(audio_tokens):
            audio_offset = tts_model.lm.audio_offset
            delays = tts_model.lm.delays
            for q in range(audio_tokens.shape[1]):
                delay = delays[q + audio_offset]
                if self._offset < delay + tts_model.delay_steps:
                    audio_tokens[:, q] = tts_model.machine.token_ids.zero

        def _on_text_hook(text_tokens):
            tokens = text_tokens.tolist()
            out_tokens = []
            for token in tokens:
                out_token, _ = tts_model.machine.process(self._offset, self._state, token)
                out_tokens.append(out_token)
            text_tokens[:] = torch.tensor(out_tokens, dtype=torch.long, device=text_tokens.device)

        tts_model.lm.dep_q = tts_model.n_q
        self._lm_gen = LMGen(
            tts_model.lm,
            temp=tts_model.temp,
            temp_text=tts_model.temp,
            cfg_coef=tts_model.cfg_coef,
            condition_tensors=condition_tensors,
            on_text_logits_hook=_on_text_logits_hook,
            on_text_hook=_on_text_hook,
            on_audio_hook=_on_audio_hook,
            cfg_is_masked_until=None,
            cfg_is_no_text=True,
        )
        self._lm_gen.streaming_forever(1)

    def feed_text(self, word: str, first_turn: bool):
        from moshi.models.tts import script_to_entries
        tts_model = self.tts_model
        multi_speaker = first_turn and tts_model.multi_speaker
        entries = script_to_entries(
            tts_model.tokenizer,
            tts_model.machine.token_ids,
            tts_model.mimi.frame_rate,
            [word],
            multi_speaker=multi_speaker,
            padding_between=1,
        )
        for entry in entries:
            self._state.entries.append(entry)
        # Reset end_step if new entries arrived — prevents premature termination
        if self._state.end_step is not None:
            self._state.end_step = None

    def step(self) -> bool:
        import torch
        tts_model = self.tts_model
        np = self.np

        missing = tts_model.lm.n_q - tts_model.lm.dep_q
        input_tokens = torch.full(
            (1, missing, 1),
            tts_model.machine.token_ids.zero,
            dtype=torch.long,
            device=tts_model.lm.device,
        )
        frame = self._lm_gen.step(input_tokens)
        self._offset += 1

        if frame is not None:
            pcm = tts_model.mimi.decode(frame[:, 1:, :]).detach().cpu().numpy()
            pcm_24k = np.clip(pcm[0, 0], -1, 1)
            self.on_audio_samples(pcm_24k)
            return True
        return False

    def is_done(self) -> bool:
        if self._state is None:
            return True
        # has_pending: entries remain or end_step was set
        return not (len(self._state.entries) > 0 or self._state.end_step is None)

    def stop(self):
        if self.mimi_streaming_ctx is not None:
            self.mimi_streaming_ctx.__exit__(None, None, None)
            self.mimi_streaming_ctx = None
        self.gen = None
        self._lm_gen = None
        self._state = None

    def flush_remaining(self):
        # Process until entries consumed
        while not self.is_done():
            self.step()
        # Additional steps for delay pipeline flush
        if self.tts_model is not None:
            additional = self.tts_model.delay_steps + max(self.tts_model.lm.delays) + 8
            for _ in range(additional):
                self.step()


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

    # Output buffer and helpers shared across backends
    output_buffer: list[float] = []

    def resample_24k_to_16k_np(pcm_24k):
        n = len(pcm_24k)
        n_out = int(n * 16000 / 24000)
        indices = np.linspace(0, n - 1, n_out)
        arr = pcm_24k if isinstance(pcm_24k, np.ndarray) else np.array(pcm_24k)
        return np.interp(indices, np.arange(n), arr)

    # Set up resampler — torchaudio if available (PyTorch), else numpy
    resample_fn = resample_24k_to_16k_np
    if not USE_MLX:
        try:
            import torch
            import torchaudio.functional as F

            def resample_24k_to_16k_torch(pcm_24k):
                t = torch.from_numpy(pcm_24k).unsqueeze(0) if isinstance(pcm_24k, np.ndarray) else pcm_24k.unsqueeze(0)
                resampled = F.resample(t, 24000, 16000)
                return resampled.squeeze(0).numpy()

            resample_fn = resample_24k_to_16k_torch
        except ImportError:
            log("warn", "torchaudio not available, using simple resampling")

    def on_audio_samples(pcm_24k):
        """Shared callback: resample 24kHz -> 16kHz, buffer, emit chunks."""
        nonlocal output_buffer
        pcm_16k = resample_fn(pcm_24k)
        output_buffer.extend(pcm_16k.tolist())
        while len(output_buffer) >= SAMPLES_PER_CHUNK:
            chunk = output_buffer[:SAMPLES_PER_CHUNK]
            del output_buffer[:SAMPLES_PER_CHUNK]
            emit_audio_chunk(chunk)

    def flush_output():
        nonlocal output_buffer
        if not output_buffer:
            return
        while len(output_buffer) % SAMPLES_PER_CHUNK != 0:
            output_buffer.append(0.0)
        for i in range(0, len(output_buffer), SAMPLES_PER_CHUNK):
            emit_audio_chunk(output_buffer[i:i + SAMPLES_PER_CHUNK])
        output_buffer = []

    # Create and load backend
    if USE_MLX:
        backend: TtsBackend = MlxBackend(on_audio_samples)
    else:
        backend = PyTorchBackend(on_audio_samples)

    backend.load()

    # Start stdin reader thread
    input_q: queue.Queue = queue.Queue()
    reader = threading.Thread(target=stdin_reader_thread, args=(input_q,), daemon=True)
    reader.start()

    # State
    text_buffer = ""
    generating = False
    first_turn = True

    def feed_words_from_buffer():
        """Feed complete words from text_buffer to backend. Returns remaining partial word."""
        nonlocal text_buffer, first_turn
        while " " in text_buffer:
            word, text_buffer = text_buffer.split(" ", 1)
            if word.strip():
                backend.feed_text(word, first_turn)
                first_turn = False

    def finish_generation():
        """Flush remaining text, run flush_remaining, stop backend."""
        nonlocal text_buffer, generating, first_turn
        remaining = text_buffer.strip()
        if remaining:
            backend.feed_text(remaining, first_turn)
            first_turn = False
        text_buffer = ""
        backend.flush_remaining()
        flush_output()
        backend.stop()
        generating = False
        first_turn = True

    def abort_generation():
        """Abort current generation without flushing."""
        nonlocal text_buffer, generating, first_turn, output_buffer
        text_buffer = ""
        output_buffer = []
        backend.stop()
        generating = False
        first_turn = True

    # Unified event loop
    while True:
        if generating:
            # Non-blocking queue check between generation steps
            try:
                event = input_q.get_nowait()
            except queue.Empty:
                event = None

            if event is _EOF:
                abort_generation()
                break
            elif event is _INTERRUPT or (isinstance(event, dict) and event.get("type") == "control.interrupt"):
                log("info", "Interrupted — stopping synthesis")
                abort_generation()
                continue
            elif isinstance(event, dict) and event.get("type") == "agent.delta":
                delta = event.get("delta", "")
                text_buffer += delta
                feed_words_from_buffer()
            elif isinstance(event, dict) and event.get("type") == "agent.complete":
                finish_generation()
                continue
            elif isinstance(event, dict) and event.get("type") == "agent.tool_start":
                finish_generation()
                continue

            # Run one generation step — keep stepping even if entries are
            # temporarily exhausted (the model's delay pipeline still has audio
            # to produce). Only stop on explicit agent.complete/tool_start.
            if not backend.is_done():
                backend.step()
            else:
                # Entries exhausted and delay flushed — wait for more words
                # or agent.complete. Use a longer timeout since LLM token
                # generation can have gaps.
                try:
                    event = input_q.get(timeout=0.5)
                    input_q.put(event)  # put it back for next iteration
                except queue.Empty:
                    pass
        else:
            # Not generating — block on queue waiting for events
            try:
                event = input_q.get(timeout=0.5)
            except queue.Empty:
                continue

            if event is _EOF:
                break
            elif not isinstance(event, dict):
                continue

            event_type = event.get("type", "")

            if event_type == "agent.delta":
                delta = event.get("delta", "")
                text_buffer += delta

                # Start generation on first delta
                log("info", "Starting streaming synthesis...")
                backend.start_utterance()
                generating = True

                # Feed complete words
                feed_words_from_buffer()

            elif event_type == "agent.complete":
                full_text = event.get("text", "")
                if full_text:
                    # Got agent.complete without prior deltas — synthesize full text
                    log("info", f"Synthesizing: {full_text[:80]}...")
                    backend.start_utterance()
                    generating = True
                    backend.feed_text(full_text, first_turn)
                    first_turn = False
                    backend.flush_remaining()
                    flush_output()
                    backend.stop()
                    generating = False
                    first_turn = True

            elif event_type == "agent.tool_start":
                pass  # Nothing to do if not generating

            elif event_type == "control.interrupt":
                log("info", "Interrupted — clearing buffer")
                text_buffer = ""

    emit({"type": "lifecycle.done", "component": COMPONENT})


if __name__ == "__main__":
    main()
