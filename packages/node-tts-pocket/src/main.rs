/// tts-pocket node — local text-to-speech via Pocket TTS.
///
/// Uses pocket-tts (Rust/Candle) for on-device TTS with no external API calls.
/// Supports CPU, Metal (macOS), and CUDA acceleration.
///
/// Reads agent.delta/agent.complete events on stdin, accumulates text,
/// and streams synthesized audio as audio.chunk events on stdout.
///
/// Settings (via ACPFX_SETTINGS):
///   voice?: string        — voice name or path (default: "alba")
///   temperature?: number  — sampling temperature (default: 0.7)
///   variant?: string      — model variant (default: "b6369a24")
use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pocket_tts::{ModelState, TTSModel};
use rubato::{FftFixedIn, Resampler};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const DEFAULT_VOICE: &str = "alba";
const DEFAULT_VARIANT: &str = "b6369a24";
const DEFAULT_TEMPERATURE: f32 = 0.7;
const DEFAULT_LSD_DECODE_STEPS: usize = 25;
const DEFAULT_EOS_THRESHOLD: f32 = 0.3;

const OUTPUT_SAMPLE_RATE: usize = 16000;
const OUTPUT_CHANNELS: usize = 1;
const CHUNK_DURATION_MS: usize = 100;
/// Number of output samples per chunk (16000 * 100 / 1000 = 1600)
const OUTPUT_CHUNK_SAMPLES: usize = OUTPUT_SAMPLE_RATE * CHUNK_DURATION_MS / 1000;

/// Predefined voice names that map to HuggingFace embeddings
const PREDEFINED_VOICES: &[&str] = &[
    "alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma",
];

#[derive(Debug, Deserialize)]
struct Settings {
    voice: Option<String>,
    temperature: Option<f32>,
    variant: Option<String>,
}

/// Emit a JSON event to stdout (NDJSON protocol)
fn emit(out: &Mutex<io::BufWriter<io::StdoutLock<'_>>>, event: &Value) {
    if let Ok(mut w) = out.lock() {
        let _ = writeln!(w, "{}", event);
        let _ = w.flush();
    }
}

/// Emit a log event
fn log_msg(out: &Mutex<io::BufWriter<io::StdoutLock<'_>>>, level: &str, message: &str) {
    emit(
        out,
        &json!({
            "type": "log",
            "level": level,
            "component": "tts-pocket",
            "message": message,
        }),
    );
}

/// Convert f32 samples to s16le base64
fn samples_to_base64(samples: &[f32]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|&s| {
            let clamped = (s * 32768.0).clamp(-32768.0, 32767.0) as i16;
            clamped.to_le_bytes()
        })
        .collect();
    B64.encode(&bytes)
}

/// Resample audio from source rate to target rate using rubato
fn resample(input: &[f32], from_rate: usize, to_rate: usize) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(input.to_vec());
    }

    let chunk_size = 1024;
    let mut resampler = FftFixedIn::<f32>::new(from_rate, to_rate, chunk_size, 1, 1)
        .context("Failed to create resampler")?;

    let mut output = Vec::new();
    let mut pos = 0;

    while pos < input.len() {
        let end = (pos + chunk_size).min(input.len());
        let mut chunk = input[pos..end].to_vec();

        // Pad last chunk if needed
        if chunk.len() < chunk_size {
            chunk.resize(chunk_size, 0.0);
        }

        let resampled = resampler
            .process(&[&chunk], None)
            .context("Resampling failed")?;

        if !resampled.is_empty() {
            output.extend_from_slice(&resampled[0]);
        }

        pos += chunk_size;
    }

    // Trim output to expected length
    let expected_len = (input.len() as f64 * to_rate as f64 / from_rate as f64).ceil() as usize;
    output.truncate(expected_len);

    Ok(output)
}

/// Strip markdown from streaming text tokens for cleaner TTS output
struct MarkdownStripper {
    in_url: bool,
    in_code_block: bool,
}

impl MarkdownStripper {
    fn new() -> Self {
        Self {
            in_url: false,
            in_code_block: false,
        }
    }

    fn strip(&mut self, text: &str) -> String {
        if text.contains("```") {
            self.in_code_block = !self.in_code_block;
            return String::new();
        }
        if self.in_code_block {
            return String::new();
        }

        let mut result = String::new();
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            let ch = chars[i];
            if self.in_url {
                if ch == ')' {
                    self.in_url = false;
                }
                i += 1;
                continue;
            }
            if ch == ']' && i + 1 < chars.len() && chars[i + 1] == '(' {
                self.in_url = true;
                i += 2;
                continue;
            }
            if ch == '[' || ch == ']' {
                i += 1;
                continue;
            }
            if ch == '*' || ch == '~' || ch == '`' {
                i += 1;
                continue;
            }
            if ch == '#' && (i == 0 || chars[i - 1] == '\n') {
                i += 1;
                continue;
            }
            result.push(ch);
            i += 1;
        }
        result
    }

    fn reset(&mut self) {
        self.in_url = false;
        self.in_code_block = false;
    }
}

/// Resolve a voice setting to a ModelState.
///
/// - If it ends with .safetensors, load as pre-computed prompt file
/// - If it ends with .wav, extract voice state from audio
/// - If it matches a predefined voice name, download from HF and load
/// - Otherwise, try as a path
fn resolve_voice(model: &TTSModel, voice: &str) -> Result<ModelState> {
    if voice.ends_with(".safetensors") {
        return model
            .get_voice_state_from_prompt_file(voice)
            .context("Failed to load voice from safetensors file");
    }

    if voice.ends_with(".wav") {
        return model
            .get_voice_state(voice)
            .context("Failed to load voice from WAV file");
    }

    // Check if it's a predefined voice name
    if PREDEFINED_VOICES.contains(&voice) {
        let hf_path = format!(
            "hf://kyutai/pocket-tts-without-voice-cloning/embeddings/{}.safetensors",
            voice
        );
        let local_path = pocket_tts::weights::download_if_necessary(&hf_path)
            .context("Failed to download predefined voice embeddings")?;
        return model
            .get_voice_state_from_prompt_file(&local_path)
            .context("Failed to load predefined voice state");
    }

    // Try as a generic path
    let path = Path::new(voice);
    if path.exists() {
        if voice.ends_with(".safetensors") {
            return model
                .get_voice_state_from_prompt_file(voice)
                .context("Failed to load voice from file");
        }
        return model
            .get_voice_state(voice)
            .context("Failed to load voice from file");
    }

    anyhow::bail!(
        "Unknown voice '{}'. Use a predefined name ({}) or a path to a .wav/.safetensors file.",
        voice,
        PREDEFINED_VOICES.join(", ")
    );
}

/// Print manifest JSON to stdout and exit.
/// Manifest YAML embedded at compile time — single source of truth.
const MANIFEST_YAML: &str = include_str!("../manifest.yaml");

fn handle_manifest() {
    let manifest: serde_json::Value = serde_yaml::from_str(MANIFEST_YAML)
        .expect("embedded manifest.yaml is invalid");
    println!("{}", manifest);
    std::process::exit(0);
}

/// Check if the required pocket-tts model files are already cached locally.
/// Format a download error with auth hint if it's a 401.
fn format_download_error(filename: &str, repo: &str, err: &dyn std::fmt::Display) -> String {
    let msg = err.to_string();
    if msg.contains("401") {
        format!(
            "Authentication required to download '{filename}' from {repo}. Run: huggingface-cli login"
        )
    } else if msg.contains("404") {
        format!(
            "File '{filename}' not found in {repo}. Check that the model exists at https://huggingface.co/{repo}"
        )
    } else {
        format!("Failed to download '{filename}' from {repo}: {msg}")
    }
}

///
/// pocket-tts downloads from two HF repos:
/// - kyutai/pocket-tts (model weights)
/// - kyutai/pocket-tts-without-voice-cloning (tokenizer + voice embeddings)
fn handle_setup_check(variant: &str) {
    let cache_dir = dirs::home_dir()
        .map(|h| h.join(".cache/huggingface/hub"))
        .unwrap_or_default();

    // Helper to check if a specific file exists in any snapshot revision
    let has_file = |repo_name: &str, filename: &str| -> bool {
        let snapshot_dir = cache_dir.join(repo_name).join("snapshots");
        if !snapshot_dir.exists() { return false; }
        std::fs::read_dir(&snapshot_dir)
            .ok()
            .and_then(|mut d| d.next())
            .and_then(|e| e.ok())
            .map(|rev| rev.path().join(filename).exists())
            .unwrap_or(false)
    };

    // Check model weights repo has the actual safetensors file
    let weights_repo = "models--kyutai--pocket-tts";
    let weights_cached = has_file(weights_repo, &format!("tts_{}.safetensors", variant));

    // Check tokenizer/embeddings repo has tokenizer
    let aux_repo = "models--kyutai--pocket-tts-without-voice-cloning";
    let aux_cached = has_file(aux_repo, "tokenizer.model");

    let needed = !weights_cached || !aux_cached;

    let response = if needed {
        json!({"needed": true, "description": format!("Download Pocket TTS model files (variant {})", variant)})
    } else {
        json!({"needed": false})
    };
    println!("{}", response);
    std::process::exit(0);
}

/// Download all required model files by triggering pocket-tts's download mechanism.
fn handle_setup(variant: &str, voice: &str) {
    println!("{}", json!({"type": "progress", "message": format!("Downloading model weights (variant {})...", variant), "pct": 0}));

    // Use pocket-tts's download_if_necessary for model weights
    let weights_path = format!(
        "hf://kyutai/pocket-tts/tts_{}.safetensors@427e3d61b276ed69fdd03de0d185fa8a8d97fc5b",
        variant
    );
    if let Err(e) = pocket_tts::weights::download_if_necessary(&weights_path) {
        let msg = format_download_error("model weights", "kyutai/pocket-tts", &e);
        println!("{}", json!({"type": "error", "message": msg}));
        std::process::exit(1);
    }

    println!("{}", json!({"type": "progress", "message": "Downloading tokenizer...", "pct": 33}));
    let tokenizer_path = "hf://kyutai/pocket-tts-without-voice-cloning/tokenizer.model@d4fdd22ae8c8e1cb3634e150ebeff1dab2d16df3";
    if let Err(e) = pocket_tts::weights::download_if_necessary(tokenizer_path) {
        let msg = format_download_error("tokenizer", "kyutai/pocket-tts-without-voice-cloning", &e);
        println!("{}", json!({"type": "error", "message": msg}));
        std::process::exit(1);
    }

    println!("{}", json!({"type": "progress", "message": format!("Downloading voice embeddings ({})...", voice), "pct": 66}));
    let voice_path = format!(
        "hf://kyutai/pocket-tts-without-voice-cloning/embeddings/{}.safetensors",
        voice
    );
    if let Err(e) = pocket_tts::weights::download_if_necessary(&voice_path) {
        let msg = format_download_error("voice embeddings", "kyutai/pocket-tts-without-voice-cloning", &e);
        println!("{}", json!({"type": "error", "message": msg}));
        std::process::exit(1);
    }

    println!("{}", json!({"type": "complete", "message": "Setup complete"}));
    std::process::exit(0);
}

/// Handle --acpfx-* convention flags (and legacy --manifest) before normal startup.
fn handle_acpfx_flags(variant: &str, voice: &str) {
    let acpfx_flag = std::env::args().find(|a| a.starts_with("--acpfx-"));
    let legacy_manifest = std::env::args().any(|a| a == "--manifest");

    let flag = match acpfx_flag.or(if legacy_manifest { Some("--acpfx-manifest".to_string()) } else { None }) {
        Some(f) => f,
        None => return,
    };

    match flag.as_str() {
        "--acpfx-manifest" => handle_manifest(),
        "--acpfx-setup-check" => handle_setup_check(variant),
        "--acpfx-setup" => handle_setup(variant, voice),
        _ => {
            println!("{}", json!({"unsupported": true, "flag": flag}));
            std::process::exit(0);
        }
    }
}

fn main() {
    // Parse settings early so --acpfx-* flags can use variant/voice
    let settings_str = std::env::var("ACPFX_SETTINGS").unwrap_or_default();
    let settings: Settings = if settings_str.is_empty() {
        Settings {
            voice: None,
            temperature: None,
            variant: None,
        }
    } else {
        serde_json::from_str(&settings_str).unwrap_or(Settings {
            voice: None,
            temperature: None,
            variant: None,
        })
    };

    let voice_name = settings.voice.as_deref().unwrap_or(DEFAULT_VOICE);
    let temperature = settings.temperature.unwrap_or(DEFAULT_TEMPERATURE);
    let variant = settings.variant.as_deref().unwrap_or(DEFAULT_VARIANT);

    // Handle --acpfx-* flags before normal startup
    handle_acpfx_flags(variant, voice_name);

    let node_name =
        std::env::var("ACPFX_NODE_NAME").unwrap_or_else(|_| "tts-pocket".to_string());

    let stdout = io::stdout();
    // Arc is used for API consistency with synthesize_and_emit; single-threaded in practice.
    #[allow(clippy::arc_with_non_send_sync)]
    let out = Arc::new(Mutex::new(io::BufWriter::new(stdout.lock())));

    // Select device
    let device = select_device(&out);

    log_msg(
        &out,
        "info",
        &format!(
            "Loading Pocket TTS model (variant={}, voice={}, temp={}, device={:?})",
            variant, voice_name, temperature, device
        ),
    );

    // Load model
    let model = match TTSModel::load_with_params_device(
        variant,
        temperature,
        DEFAULT_LSD_DECODE_STEPS,
        DEFAULT_EOS_THRESHOLD,
        None,
        &device,
    ) {
        Ok(m) => m,
        Err(e) => {
            log_msg(&out, "error", &format!("Failed to load TTS model: {}", e));
            emit(
                &out,
                &json!({
                    "type": "control.error",
                    "component": node_name,
                    "message": format!("Model load failed: {}", e),
                    "fatal": true,
                }),
            );
            std::process::exit(1);
        }
    };

    let model_sample_rate = model.sample_rate;
    log_msg(
        &out,
        "info",
        &format!(
            "Model loaded (native sample rate: {}Hz, output: {}Hz)",
            model_sample_rate, OUTPUT_SAMPLE_RATE
        ),
    );

    // Load voice state
    let voice_state = match resolve_voice(&model, voice_name) {
        Ok(vs) => vs,
        Err(e) => {
            log_msg(&out, "error", &format!("Failed to load voice '{}': {}", voice_name, e));
            emit(
                &out,
                &json!({
                    "type": "control.error",
                    "component": node_name,
                    "message": format!("Voice load failed: {}", e),
                    "fatal": true,
                }),
            );
            std::process::exit(1);
        }
    };

    log_msg(
        &out,
        "info",
        &format!("Voice '{}' loaded successfully", voice_name),
    );

    // Emit lifecycle.ready
    emit(
        &out,
        &json!({"type": "lifecycle.ready", "component": node_name}),
    );

    // Shared state for interrupt handling
    let interrupted = Arc::new(AtomicBool::new(false));
    let model = Arc::new(model);
    let voice_state = Arc::new(voice_state);

    // Text accumulation buffer
    let mut text_buffer = String::new();
    let mut stripper = MarkdownStripper::new();
    let mut _current_request_id: Option<String> = None;

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

        match event_type {
            "agent.delta" => {
                if let Some(delta) = event["delta"].as_str() {
                    if interrupted.load(Ordering::Relaxed) {
                        // New content after interrupt — reset
                        interrupted.store(false, Ordering::Relaxed);
                        text_buffer.clear();
                        stripper.reset();
                    }

                    _current_request_id =
                        event["requestId"].as_str().map(|s| s.to_string());

                    let clean = stripper.strip(delta);
                    if !clean.is_empty() {
                        text_buffer.push_str(&clean);
                    }
                }
            }

            "agent.complete" => {
                if !interrupted.load(Ordering::Relaxed) {
                    // Use the complete text if available, otherwise use accumulated buffer
                    let text = if let Some(full_text) = event["text"].as_str() {
                        let mut s = MarkdownStripper::new();
                        s.strip(full_text)
                    } else {
                        std::mem::take(&mut text_buffer)
                    };

                    if !text.trim().is_empty() {
                        synthesize_and_emit(
                            &model,
                            &voice_state,
                            &text,
                            model_sample_rate,
                            &out,
                            &interrupted,
                        );
                    }

                    text_buffer.clear();
                    stripper.reset();
                    _current_request_id = None;
                }
            }

            "agent.tool_start" => {
                if !interrupted.load(Ordering::Relaxed) && !text_buffer.trim().is_empty() {
                    log_msg(&out, "info", "Tool started — flushing accumulated text");
                    let text = std::mem::take(&mut text_buffer);
                    synthesize_and_emit(
                        &model,
                        &voice_state,
                        &text,
                        model_sample_rate,
                        &out,
                        &interrupted,
                    );
                    stripper.reset();
                }
            }

            "control.interrupt" => {
                interrupted.store(true, Ordering::Relaxed);
                text_buffer.clear();
                stripper.reset();
                _current_request_id = None;
                log_msg(&out, "info", "Interrupted — cleared text buffer");
            }

            _ => {}
        }
    }

    // stdin closed — emit lifecycle.done
    emit(
        &out,
        &json!({"type": "lifecycle.done", "component": node_name}),
    );
}

/// Select the best available compute device
fn select_device(out: &Mutex<io::BufWriter<io::StdoutLock<'_>>>) -> candle_core::Device {
    #[cfg(feature = "metal")]
    {
        match candle_core::Device::new_metal(0) {
            Ok(d) => {
                log_msg(out, "info", "Using Metal device");
                return d;
            }
            Err(e) => {
                log_msg(
                    out,
                    "warn",
                    &format!("Metal not available, falling back to CPU: {}", e),
                );
            }
        }
    }

    #[cfg(feature = "cuda")]
    {
        match candle_core::Device::new_cuda(0) {
            Ok(d) => {
                log_msg(out, "info", "Using CUDA device");
                return d;
            }
            Err(e) => {
                log_msg(
                    out,
                    "warn",
                    &format!("CUDA not available, falling back to CPU: {}", e),
                );
            }
        }
    }

    log_msg(out, "info", "Using CPU device");
    candle_core::Device::Cpu
}

/// Synthesize text to audio and emit as audio.chunk events
fn synthesize_and_emit(
    model: &TTSModel,
    voice_state: &ModelState,
    text: &str,
    model_sample_rate: usize,
    out: &Mutex<io::BufWriter<io::StdoutLock<'_>>>,
    interrupted: &AtomicBool,
) {
    log_msg(
        out,
        "debug",
        &format!(
            "Synthesizing: \"{}\"",
            if text.len() > 80 {
                format!("{}...", &text[..77])
            } else {
                text.to_string()
            }
        ),
    );

    // Use streaming generation for lower latency
    let stream = model.generate_stream(text, voice_state);

    let mut resample_buffer: Vec<f32> = Vec::new();

    for chunk_result in stream {
        if interrupted.load(Ordering::Relaxed) {
            log_msg(out, "debug", "Synthesis interrupted mid-stream");
            break;
        }

        let chunk_tensor = match chunk_result {
            Ok(t) => t,
            Err(e) => {
                log_msg(
                    out,
                    "warn",
                    &format!("Stream chunk error: {}", e),
                );
                continue;
            }
        };

        // Extract f32 samples from tensor
        // Tensor shape is typically [1, channels, samples] or [samples]
        let flat_samples: Vec<f32> = match chunk_tensor.flatten_all() {
            Ok(flat) => match flat.to_vec1::<f32>() {
                Ok(v) => v,
                Err(e) => {
                    log_msg(out, "warn", &format!("Failed to extract samples: {}", e));
                    continue;
                }
            },
            Err(e) => {
                log_msg(out, "warn", &format!("Failed to flatten tensor: {}", e));
                continue;
            }
        };

        // Resample from model rate to output rate
        let resampled = match resample(&flat_samples, model_sample_rate, OUTPUT_SAMPLE_RATE) {
            Ok(r) => r,
            Err(e) => {
                log_msg(out, "warn", &format!("Resample error: {}", e));
                continue;
            }
        };

        resample_buffer.extend_from_slice(&resampled);

        // Emit complete chunks from the buffer
        while resample_buffer.len() >= OUTPUT_CHUNK_SAMPLES
            && !interrupted.load(Ordering::Relaxed)
        {
            let chunk: Vec<f32> = resample_buffer.drain(..OUTPUT_CHUNK_SAMPLES).collect();
            let duration_ms = (chunk.len() * 1000) / OUTPUT_SAMPLE_RATE;
            let b64 = samples_to_base64(&chunk);

            emit(
                out,
                &json!({
                    "type": "audio.chunk",
                    "trackId": "tts",
                    "format": "pcm_s16le",
                    "sampleRate": OUTPUT_SAMPLE_RATE,
                    "channels": OUTPUT_CHANNELS,
                    "data": b64,
                    "durationMs": duration_ms,
                }),
            );
        }
    }

    // Flush remaining samples in buffer
    if !resample_buffer.is_empty() && !interrupted.load(Ordering::Relaxed) {
        let duration_ms = (resample_buffer.len() * 1000) / OUTPUT_SAMPLE_RATE;
        let b64 = samples_to_base64(&resample_buffer);

        emit(
            out,
            &json!({
                "type": "audio.chunk",
                "trackId": "tts",
                "format": "pcm_s16le",
                "sampleRate": OUTPUT_SAMPLE_RATE,
                "channels": OUTPUT_CHANNELS,
                "data": b64,
                "durationMs": duration_ms,
            }),
        );
    }
}
