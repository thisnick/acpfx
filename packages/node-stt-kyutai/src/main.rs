/// stt-kyutai node — local speech-to-text via Kyutai moshi.
///
/// Runs on-device using Candle (no API key needed).
/// Supports CUDA, Metal, and CPU backends.
///
/// Settings (via ACPFX_SETTINGS):
///   model?: string    — HuggingFace model ID (default: "kyutai/stt-1b-en_fr-candle")
///   language?: string — language code (default: "en")
///   device?: string   — "cpu", "cuda", "metal", or "auto" (default: "auto")
use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use candle_core::{Device, Tensor};
use rubato::{FftFixedIn, Resampler};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;

const DEFAULT_MODEL: &str = "kyutai/stt-1b-en_fr-candle";
const MODEL_SAMPLE_RATE: usize = 24000;
const INPUT_SAMPLE_RATE: usize = 16000;
// moshi expects 1920-sample chunks at 24kHz (80ms)
const MOSHI_CHUNK_SIZE: usize = 1920;

/// Select compute device based on availability and user preference.
fn select_device(preference: &str) -> Result<Device> {
    match preference {
        "cpu" => Ok(Device::Cpu),
        "cuda" => Ok(Device::new_cuda(0)?),
        "metal" => Ok(Device::new_metal(0)?),
        _ => {
            // auto
            if candle_core::utils::cuda_is_available() {
                Ok(Device::new_cuda(0)?)
            } else if candle_core::utils::metal_is_available() {
                Ok(Device::new_metal(0)?)
            } else {
                Ok(Device::Cpu)
            }
        }
    }
}

/// Emit a JSON event to stdout.
fn emit(out: &mut impl Write, event: &Value) {
    let _ = writeln!(out, "{}", event);
    let _ = out.flush();
}

/// Emit a log event.
fn emit_log(out: &mut impl Write, level: &str, message: &str) {
    emit(
        out,
        &json!({
            "type": "log",
            "level": level,
            "component": "stt-kyutai",
            "message": message,
        }),
    );
}

/// Print manifest JSON to stdout and exit.
fn handle_manifest() {
    // Try to find the co-located manifest file
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().unwrap_or(Path::new("."));

    // Try .manifest.json next to binary
    let json_path = exe_dir.join("stt-kyutai.manifest.json");
    if json_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&json_path) {
            println!("{}", content);
            std::process::exit(0);
        }
    }

    // Fallback: emit inline manifest
    let manifest = json!({
        "name": "stt-kyutai",
        "description": "Local speech-to-text via Kyutai moshi (on-device, no API key needed)",
        "consumes": ["audio.chunk"],
        "emits": ["speech.partial", "speech.final", "speech.pause", "lifecycle.ready", "lifecycle.done", "log"]
    });
    println!("{}", manifest);
    std::process::exit(0);
}

/// Format a download error with auth hint if it's a 401.
fn format_download_error(filename: &str, model_id: &str, err: &dyn std::fmt::Display) -> String {
    let msg = err.to_string();
    if msg.contains("401") {
        format!(
            "Authentication required to download '{filename}' from {model_id}. Run: huggingface-cli login"
        )
    } else if msg.contains("404") {
        format!(
            "Model file '{filename}' not found in {model_id}. Check that the model ID is correct and the file exists at https://huggingface.co/{model_id}"
        )
    } else {
        format!("Failed to download '{filename}' from {model_id}: {msg}")
    }
}

/// Check if the required model files are already cached locally.
fn handle_setup_check(model_id: &str) {
    let cache_dir = dirs::home_dir()
        .map(|h| h.join(".cache/huggingface/hub"))
        .unwrap_or_default();
    let repo_dir_name = format!("models--{}", model_id.replace('/', "--"));
    let repo_cache = cache_dir.join(&repo_dir_name);

    // Check that the snapshots dir exists AND contains the critical file (model.safetensors)
    let snapshot_dir = repo_cache.join("snapshots");
    let has_model = if snapshot_dir.exists() {
        std::fs::read_dir(&snapshot_dir)
            .ok()
            .and_then(|mut d| d.next())
            .and_then(|e| e.ok())
            .map(|rev| rev.path().join("model.safetensors").exists())
            .unwrap_or(false)
    } else {
        false
    };

    let needed = !has_model;

    let response = if needed {
        json!({"needed": true, "description": format!("Download {} model files", model_id)})
    } else {
        json!({"needed": false})
    };
    println!("{}", response);
    std::process::exit(0);
}

/// Download all required model files via hf_hub.
fn handle_setup(model_id: &str) {
    let api = match hf_hub::api::sync::Api::new() {
        Ok(api) => api,
        Err(e) => {
            println!("{}", json!({"type": "error", "message": format!("Failed to create HF API: {}", e)}));
            std::process::exit(1);
        }
    };
    let repo = api.model(model_id.to_string());

    // Download config.json first to discover additional files
    println!("{}", json!({"type": "progress", "message": "Downloading config.json...", "pct": 0}));
    let config_path = match repo.get("config.json") {
        Ok(p) => p,
        Err(e) => {
            println!("{}", json!({"type": "error", "message": format_download_error("config.json", model_id, &e)}));
            std::process::exit(1);
        }
    };

    // Parse config to get mimi and tokenizer file names
    let extra_files: Vec<String> = if let Ok(config_str) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<Value>(&config_str) {
            let mut files = Vec::new();
            if let Some(mimi) = config["mimi_name"].as_str() {
                files.push(mimi.to_string());
            }
            if let Some(tok) = config["tokenizer_name"].as_str() {
                files.push(tok.to_string());
            }
            files
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    let mut all_files: Vec<&str> = vec!["model.safetensors"];
    let extra_refs: Vec<&str> = extra_files.iter().map(|s| s.as_str()).collect();
    all_files.extend(extra_refs);

    let total = all_files.len() + 1; // +1 for config.json already done
    for (i, filename) in all_files.iter().enumerate() {
        let pct = ((i + 1) * 100 / total) as u8;
        println!("{}", json!({"type": "progress", "message": format!("Downloading {}...", filename), "pct": pct}));
        if let Err(e) = repo.get(filename) {
            println!("{}", json!({"type": "error", "message": format_download_error(filename, model_id, &e)}));
            std::process::exit(1);
        }
    }

    println!("{}", json!({"type": "complete", "message": "Setup complete"}));
    std::process::exit(0);
}

/// Handle --acpfx-* convention flags (and legacy --manifest) before normal startup.
fn handle_acpfx_flags(model_id: &str) {
    let acpfx_flag = std::env::args().find(|a| a.starts_with("--acpfx-"));
    let legacy_manifest = std::env::args().any(|a| a == "--manifest");

    let flag = match acpfx_flag.or(if legacy_manifest { Some("--acpfx-manifest".to_string()) } else { None }) {
        Some(f) => f,
        None => return,
    };

    match flag.as_str() {
        "--acpfx-manifest" => handle_manifest(),
        "--acpfx-setup-check" => handle_setup_check(model_id),
        "--acpfx-setup" => handle_setup(model_id),
        _ => {
            println!("{}", json!({"unsupported": true, "flag": flag}));
            std::process::exit(0);
        }
    }
}

/// Model configuration parsed from the HF model's config.json.
#[derive(Debug, serde::Deserialize)]
struct SttConfig {
    audio_silence_prefix_seconds: f64,
    audio_delay_seconds: f64,
}

#[derive(Debug, serde::Deserialize)]
struct ModelConfig {
    mimi_name: String,
    tokenizer_name: String,
    card: usize,
    text_card: usize,
    dim: usize,
    n_q: usize,
    context: usize,
    max_period: f64,
    num_heads: usize,
    num_layers: usize,
    causal: bool,
    stt_config: SttConfig,
}

impl ModelConfig {
    fn lm_config(&self, vad: bool) -> moshi::lm::Config {
        let lm_cfg = moshi::transformer::Config {
            d_model: self.dim,
            num_heads: self.num_heads,
            num_layers: self.num_layers,
            dim_feedforward: self.dim * 4,
            causal: self.causal,
            norm_first: true,
            bias_ff: false,
            bias_attn: false,
            layer_scale: None,
            context: self.context,
            max_period: self.max_period as usize,
            use_conv_block: false,
            use_conv_bias: true,
            cross_attention: None,
            gating: Some(candle_nn::Activation::Silu),
            norm: moshi::NormType::RmsNorm,
            positional_embedding: moshi::transformer::PositionalEmbedding::Rope,
            conv_layout: false,
            conv_kernel_size: 3,
            kv_repeat: 1,
            max_seq_len: 4096 * 4,
            shared_cross_attn: false,
        };
        let extra_heads = if vad {
            Some(moshi::lm::ExtraHeadsConfig {
                num_heads: 4,
                dim: 6,
            })
        } else {
            None
        };
        moshi::lm::Config {
            transformer: lm_cfg,
            depformer: None,
            audio_vocab_size: self.card + 1,
            text_in_vocab_size: self.text_card + 1,
            text_out_vocab_size: self.text_card,
            audio_codebooks: self.n_q,
            conditioners: Default::default(),
            extra_heads,
        }
    }
}

/// Loaded ASR model and tokenizer.
struct Model {
    state: moshi::asr::State,
    tokenizer: sentencepiece::SentencePieceProcessor,
}

impl Model {
    fn load(model_id: &str, device: &Device) -> Result<(Self, ModelConfig)> {
        let api = hf_hub::api::sync::Api::new()?;
        let repo = api.model(model_id.to_string());

        // Load config.json
        let config_path = repo
            .get("config.json")
            .context("Failed to download config.json")?;
        let config_str = std::fs::read_to_string(&config_path)?;
        let config: ModelConfig = serde_json::from_str(&config_str)?;

        // Load tokenizer
        let tokenizer_path = repo
            .get(&config.tokenizer_name)
            .context("Failed to download tokenizer")?;
        let tokenizer = sentencepiece::SentencePieceProcessor::open(&tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        // Load mimi codec weights
        let mimi_path = repo
            .get(&config.mimi_name)
            .context("Failed to download mimi weights")?;
        let mimi_data = std::fs::read(&mimi_path)?;
        let mimi_vb = candle_nn::VarBuilder::from_buffered_safetensors(
            mimi_data,
            candle_core::DType::F32,
            device,
        )?;

        let mimi_cfg = moshi::mimi::Config::v0_1(Some(config.n_q));
        let mimi = moshi::mimi::Mimi::new(mimi_cfg, mimi_vb)?;

        // Load LM weights (safetensors)
        let lm_config = config.lm_config(true);
        let st_path = repo
            .get("model.safetensors")
            .context("Failed to download model weights")?;
        let st_data = std::fs::read(&st_path)?;
        let vb = candle_nn::VarBuilder::from_buffered_safetensors(
            st_data,
            candle_core::DType::F32,
            device,
        )?;
        let mqvb = moshi::nn::MaybeQuantizedVarBuilder::Real(vb);
        let lm = moshi::lm::LmModel::new(&lm_config, mqvb)?;

        // Compute ASR delay in tokens from config
        let asr_delay_in_tokens =
            (config.stt_config.audio_delay_seconds * 12.5) as usize;

        let state = moshi::asr::State::new(
            1, // batch_size = 1
            asr_delay_in_tokens,
            0.0, // temperature (greedy)
            mimi,
            lm,
        )?;

        Ok((Model { state, tokenizer }, config))
    }
}

/// Decode base64 PCM s16le to f32 samples.
fn decode_pcm_s16le(b64_data: &str) -> Vec<f32> {
    let bytes = B64.decode(b64_data).unwrap_or_default();
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

/// Create a resampler from input_rate to output_rate.
fn create_resampler(
    input_rate: usize,
    output_rate: usize,
    chunk_size: usize,
) -> Result<FftFixedIn<f32>> {
    let resampler = FftFixedIn::new(input_rate, output_rate, chunk_size, 1, 1)?;
    Ok(resampler)
}

fn main() -> Result<()> {
    // Parse settings early so --acpfx-* flags can use model ID
    let settings_str = std::env::var("ACPFX_SETTINGS").unwrap_or_default();
    let settings: Value = if settings_str.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&settings_str).unwrap_or_else(|_| json!({}))
    };

    let model_id = settings["model"]
        .as_str()
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    // Handle --acpfx-* flags before normal startup
    handle_acpfx_flags(&model_id);

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let _language = settings["language"]
        .as_str()
        .unwrap_or("en")
        .to_string();
    let device_pref = settings["device"].as_str().unwrap_or("auto").to_string();

    emit_log(&mut out, "info", &format!("Loading model: {}", model_id));
    emit_log(
        &mut out,
        "info",
        &format!("Device preference: {}", device_pref),
    );

    // Select device
    let device = select_device(&device_pref)?;
    let device_name = match &device {
        Device::Cpu => "CPU",
        Device::Cuda(_) => "CUDA",
        Device::Metal(_) => "Metal",
    };
    emit_log(
        &mut out,
        "info",
        &format!("Using device: {}", device_name),
    );

    // Load model
    let (mut model, config) = Model::load(&model_id, &device)?;
    emit_log(&mut out, "info", "Model loaded successfully");

    // Emit lifecycle.ready
    emit(
        &mut out,
        &json!({"type": "lifecycle.ready", "component": "stt-kyutai"}),
    );

    // Audio buffer for accumulating samples at 24kHz (after resampling)
    let mut audio_buffer: Vec<f32> = Vec::new();
    // Buffer for accumulating input samples at 16kHz (before resampling)
    let mut input_buffer: Vec<f32> = Vec::new();

    // Resampler: 16kHz -> 24kHz
    // We pick a reasonable input chunk size for the resampler
    let resample_chunk_size = 1600; // 100ms at 16kHz
    let mut resampler = create_resampler(INPUT_SAMPLE_RATE, MODEL_SAMPLE_RATE, resample_chunk_size)?;

    // Track accumulated text for partial/final events
    let mut accumulated_text = String::new();
    let mut pending_text = String::new();
    let mut silence_prepended = false;

    // Prepend silence prefix to the audio buffer (number of samples at 24kHz)
    let silence_samples =
        (config.stt_config.audio_silence_prefix_seconds * MODEL_SAMPLE_RATE as f64) as usize;

    // StreamMask for batch_size=1 (no masking needed, use empty)
    let mask = moshi::StreamMask::empty();

    // Read NDJSON from stdin
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let event: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = event["type"].as_str().unwrap_or("");
        if event_type != "audio.chunk" {
            continue;
        }

        let data = match event["data"].as_str() {
            Some(d) => d,
            None => continue,
        };

        // Decode PCM s16le to f32 at input sample rate (16kHz)
        let samples = decode_pcm_s16le(data);
        if samples.is_empty() {
            continue;
        }

        // Prepend silence on first audio (only once)
        if !silence_prepended {
            audio_buffer.extend(vec![0.0f32; silence_samples]);
            silence_prepended = true;
        }

        // Accumulate input samples and resample in chunks
        input_buffer.extend_from_slice(&samples);

        while input_buffer.len() >= resample_chunk_size {
            let chunk: Vec<f32> = input_buffer.drain(..resample_chunk_size).collect();
            let resampled = resampler.process(&[&chunk], None)?;
            audio_buffer.extend_from_slice(&resampled[0]);
        }

        // Feed moshi in MOSHI_CHUNK_SIZE chunks
        while audio_buffer.len() >= MOSHI_CHUNK_SIZE {
            let chunk: Vec<f32> = audio_buffer.drain(..MOSHI_CHUNK_SIZE).collect();
            // PCM tensor shape: (batch=1, channels=1, samples=MOSHI_CHUNK_SIZE)
            let pcm_tensor = Tensor::from_vec(chunk, (1, 1, MOSHI_CHUNK_SIZE), &device)?;

            let messages =
                model
                    .state
                    .step_pcm(pcm_tensor, None, &mask, |_, _, _| ())?;

            for msg in messages {
                match msg {
                    moshi::asr::AsrMsg::Word { tokens, .. } => {
                        // Decode tokens to text
                        let word = model
                            .tokenizer
                            .decode_piece_ids(&tokens)
                            .unwrap_or_default();
                        if !word.is_empty() {
                            accumulated_text.push_str(&word);
                            let partial = accumulated_text.trim().to_string();
                            if !partial.is_empty() {
                                emit(
                                    &mut out,
                                    &json!({
                                        "type": "speech.partial",
                                        "trackId": "stt",
                                        "text": format!("{}{}", pending_text, partial),
                                    }),
                                );
                            }
                        }
                    }
                    moshi::asr::AsrMsg::EndWord { .. } => {
                        let word_text = accumulated_text.trim().to_string();
                        if !word_text.is_empty() {
                            pending_text.push_str(&word_text);
                            pending_text.push(' ');
                            emit(
                                &mut out,
                                &json!({
                                    "type": "speech.final",
                                    "trackId": "stt",
                                    "text": word_text,
                                }),
                            );
                            accumulated_text.clear();
                        }
                    }
                    moshi::asr::AsrMsg::Step { prs, .. } => {
                        // Check VAD end-of-turn: prs[2][0] > 0.5
                        if prs.len() > 2 && !prs[2].is_empty() && prs[2][0] > 0.5 {
                            let full_text = format!(
                                "{}{}",
                                pending_text,
                                accumulated_text.trim()
                            ).trim().to_string();
                            if !full_text.is_empty() {
                                emit(
                                    &mut out,
                                    &json!({
                                        "type": "speech.pause",
                                        "trackId": "stt",
                                        "pendingText": full_text,
                                        "silenceMs": 2000,
                                    }),
                                );
                                pending_text.clear();
                                accumulated_text.clear();
                            }
                        }
                    }
                }
            }
        }
    }

    // Emit lifecycle.done
    emit(
        &mut out,
        &json!({"type": "lifecycle.done", "component": "stt-kyutai"}),
    );

    Ok(())
}
