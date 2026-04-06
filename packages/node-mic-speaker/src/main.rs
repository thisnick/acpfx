/// mic-speaker node — microphone capture with OS-level echo cancellation.
///
/// Uses `sys-voice` which leverages platform-native AEC:
///   - macOS: CoreAudio VoiceProcessingIO
///   - Windows: WASAPI IAcousticEchoCancellationControl
///   - Linux: PulseAudio module-echo-cancel
///   - Android: Oboe VoiceCommunication
///
/// This node handles BOTH mic capture AND speaker playback in one process,
/// because OS-level AEC requires the capture and playback to be on the
/// same audio unit so the OS can correlate them.
///
/// Receives audio.chunk events on stdin (from TTS/player) to play through speaker.
/// Emits audio.chunk and audio.level events on stdout from mic (with echo cancelled).
///
/// Settings (via ACPFX_SETTINGS):
///   sampleRate?: number     — target sample rate (default: 16000)
///   chunkMs?: number        — chunk duration in ms (default: 100)
///   speaker?: string         — node name whose audio is the speaker reference for AEC (default: "player")
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, BufRead, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const DEFAULT_SAMPLE_RATE: u32 = 16000;
const DEFAULT_CHUNK_MS: u32 = 100;

/// Manifest YAML embedded at compile time — single source of truth.
const MANIFEST_YAML: &str = include_str!("../manifest.yaml");

/// Print manifest JSON to stdout and exit.
fn handle_manifest() {
    let manifest: serde_json::Value = serde_yaml::from_str(MANIFEST_YAML)
        .expect("embedded manifest.yaml is invalid");
    println!("{}", manifest);
    std::process::exit(0);
}

/// Handle --acpfx-* convention flags (and legacy --manifest) before normal startup.
fn handle_acpfx_flags() {
    let acpfx_flag = std::env::args().find(|a| a.starts_with("--acpfx-"));
    let legacy_manifest = std::env::args().any(|a| a == "--manifest");

    let flag = match acpfx_flag.or(if legacy_manifest { Some("--acpfx-manifest".to_string()) } else { None }) {
        Some(f) => f,
        None => return,
    };

    match flag.as_str() {
        "--acpfx-manifest" => handle_manifest(),
        "--acpfx-setup-check" => {
            // mic-speaker has no setup requirements (no model downloads)
            println!("{}", json!({"needed": false}));
            std::process::exit(0);
        }
        _ => {
            println!("{}", json!({"unsupported": true, "flag": flag}));
            std::process::exit(0);
        }
    }
}

fn samples_to_base64(samples: &[f32]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|&s| {
            let i = (s * 32768.0).clamp(-32768.0, 32767.0) as i16;
            i.to_le_bytes()
        })
        .collect();
    B64.encode(&bytes)
}

fn base64_to_f32(b64: &str) -> Vec<f32> {
    let bytes = B64.decode(b64).unwrap_or_default();
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

fn compute_level(samples: &[f32]) -> (u32, u32, f32) {
    if samples.is_empty() {
        return (0, 0, f32::NEG_INFINITY);
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for &s in samples {
        sum_sq += (s as f64) * (s as f64);
        let abs = s.abs();
        if abs > peak { peak = abs; }
    }
    let rms = (sum_sq / samples.len() as f64).sqrt() as f32;
    let rms_i16 = (rms * 32768.0) as u32;
    let peak_i16 = (peak * 32768.0) as u32;
    let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { f32::NEG_INFINITY };
    (rms_i16, peak_i16, (dbfs * 10.0).round() / 10.0)
}

struct WavWriter {
    file: File,
    data_len: u32,
    sample_rate: u32,
}

impl WavWriter {
    fn new(path: &str, sample_rate: u32) -> io::Result<Self> {
        let mut file = File::create(path)?;
        file.write_all(&[0u8; 44])?; // placeholder header
        eprintln!("[mic-speaker] Recording to {}", path);
        Ok(WavWriter { file, data_len: 0, sample_rate })
    }

    fn write_f32(&mut self, samples: &[f32]) {
        let bytes: Vec<u8> = samples.iter().flat_map(|&s| {
            ((s * 32768.0).clamp(-32768.0, 32767.0) as i16).to_le_bytes()
        }).collect();
        let _ = self.file.write_all(&bytes);
        self.data_len += bytes.len() as u32;
    }

    fn finalize(&mut self) {
        let _ = self.file.seek(SeekFrom::Start(0));
        let sr = self.sample_rate;
        let file_size = 36 + self.data_len;
        let mut h = Vec::with_capacity(44);
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&file_size.to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());  // PCM
        h.extend_from_slice(&1u16.to_le_bytes());  // mono
        h.extend_from_slice(&sr.to_le_bytes());
        h.extend_from_slice(&(sr * 2).to_le_bytes());
        h.extend_from_slice(&2u16.to_le_bytes());
        h.extend_from_slice(&16u16.to_le_bytes());
        h.extend_from_slice(b"data");
        h.extend_from_slice(&self.data_len.to_le_bytes());
        let _ = self.file.write_all(&h);
        eprintln!("[mic-speaker] WAV finalized ({} bytes)", self.data_len);
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        self.finalize();
    }
}

#[tokio::main]
async fn main() {
    // Handle --acpfx-* flags before normal startup
    handle_acpfx_flags();

    let settings_str = std::env::var("ACPFX_SETTINGS").unwrap_or_default();
    let settings: Value = if settings_str.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&settings_str).expect("Invalid ACPFX_SETTINGS JSON")
    };

    let sample_rate = settings["sampleRate"].as_u64().unwrap_or(DEFAULT_SAMPLE_RATE as u64) as u32;
    let chunk_ms = settings["chunkMs"].as_u64().unwrap_or(DEFAULT_CHUNK_MS as u64) as u32;
    let chunk_samples = (sample_rate * chunk_ms / 1000) as usize;
    let speaker = settings["speaker"]
        .as_str()
        .unwrap_or("player")
        .to_string();

    // Debug recording
    let debug_dir = settings["debugDir"].as_str().map(|s| s.to_string())
        .or_else(|| std::env::var("ACPFX_MIC_DEBUG").ok().filter(|v| v == "1").map(|_| "./mic-debug".to_string()));

    let capture_wav: Arc<Mutex<Option<WavWriter>>> = Arc::new(Mutex::new(None));
    let playback_wav: Arc<Mutex<Option<WavWriter>>> = Arc::new(Mutex::new(None));

    if let Some(ref dir) = debug_dir {
        std::fs::create_dir_all(dir).ok();
        *capture_wav.lock().unwrap() = WavWriter::new(&format!("{}/capture.wav", dir), sample_rate).ok();
        *playback_wav.lock().unwrap() = WavWriter::new(&format!("{}/playback.wav", dir), sample_rate).ok();
    }

    let playback_wav_for_stdin = playback_wav.clone();

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    // Create capture handle with AEC
    let config = sys_voice::AecConfig {
        sample_rate,
        channels: sys_voice::Channels::Mono,
    };

    let handle = match sys_voice::CaptureHandle::new(config) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[mic-speaker] Failed to start AEC capture: {:?}", e);
            let err = json!({
                "type": "control.error",
                "component": "mic-speaker",
                "message": format!("AEC capture failed: {:?}", e),
                "fatal": true
            });
            writeln!(out, "{}", err).unwrap();
            out.flush().unwrap();
            std::process::exit(1);
        }
    };

    let native_rate = handle.native_sample_rate();
    eprintln!("[mic-speaker] OS AEC capture started at {}Hz (native: {}Hz), {}ms chunks, speech from \"{}\"",
        sample_rate, native_rate, chunk_ms, speaker);

    // Emit lifecycle.ready
    let ready = json!({"type": "lifecycle.ready", "component": "mic-speaker"});
    writeln!(out, "{}", ready).unwrap();
    out.flush().unwrap();

    // Handle stdin events in a separate thread (play speaker audio, handle interrupts)
    let handle = Arc::new(handle);
    let handle_for_capture = handle.clone();
    let handle_for_playback = handle.clone();
    let interrupted = Arc::new(AtomicBool::new(false));
    let interrupted_clone = interrupted.clone();
    let muted = Arc::new(AtomicBool::new(true)); // start muted (push-to-talk: hold Space to unmute)
    let muted_for_stdin = muted.clone();
    let muted_for_capture = muted.clone();
    let speaker_clone = speaker.clone();

    // Stdin thread — parse events, play speaker audio directly per-chunk
    // No local buffering — play_audio() feeds sys-voice's CoreAudio render buffer.
    // If sample_rate matches native rate, no resampling happens (no stutter).
    // Interrupt just stops sending new chunks — CoreAudio buffer is small (~20ms).
    if sample_rate != native_rate {
        eprintln!("[mic-speaker] WARNING: sample_rate {}Hz != native {}Hz — playback will resample (may stutter)", sample_rate, native_rate);
        eprintln!("[mic-speaker] Consider setting sampleRate: {} in config", native_rate);
    }

    // Emit initial node.status (muted by default)
    let status_msg = json!({"type": "node.status", "text": "Muted (hold Space)"});
    writeln!(out, "{}", status_msg).unwrap();
    out.flush().unwrap();

    std::thread::spawn(move || {
        let stdin = io::stdin();
        let stdout_for_status = io::stdout();
        let mut status_out = io::BufWriter::new(stdout_for_status.lock());
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() { continue; }

            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                let event_type = event["type"].as_str().unwrap_or("");

                if event_type == "custom.mute" {
                    let is_muted = event["muted"].as_bool().unwrap_or(true);
                    muted_for_stdin.store(is_muted, Ordering::Relaxed);
                    let text = if is_muted { "Muted (hold Space)" } else { "Listening" };
                    let status = json!({"type": "node.status", "text": text});
                    let _ = writeln!(status_out, "{}", status);
                    let _ = status_out.flush();
                    eprintln!("[mic-speaker] Mute: {}", is_muted);
                } else if event_type == "control.interrupt" {
                    interrupted_clone.store(true, Ordering::Relaxed);
                    // Instantly clear sys-voice's playback buffer — speaker goes silent
                    let _ = handle_for_playback.clear_playback();
                    eprintln!("[mic-speaker] Interrupt — cleared playback buffer");
                } else if event_type == "audio.chunk" {
                    // No need to drop chunks — clear_playback() already emptied the buffer.
                    // Any chunk arriving now is either a straggler (plays briefly, harmless)
                    // or from the new response (should play).
                    let from = event["_from"].as_str().unwrap_or("");
                    if from == speaker_clone {
                        if let Some(data) = event["data"].as_str() {
                            let samples = base64_to_f32(data);
                            if let Ok(mut w) = playback_wav_for_stdin.lock() {
                                if let Some(ref mut wav) = *w { wav.write_f32(&samples); }
                            }
                            if let Err(e) = handle_for_playback.play_audio(samples, sample_rate) {
                                eprintln!("[mic-speaker] play_audio error: {:?}", e);
                            }
                        }
                    }
                }
            }
        }
        std::process::exit(0);
    });

    // Capture loop — read mic audio with echo cancelled
    let mut buffer: Vec<f32> = Vec::with_capacity(chunk_samples * 2);

    loop {
        if interrupted.load(Ordering::Relaxed) {
            interrupted.store(false, Ordering::Relaxed);
            buffer.clear();
        }

        match handle_for_capture.recv().await {
            Some(Ok(samples)) => {
                buffer.extend_from_slice(&samples);

                while buffer.len() >= chunk_samples {
                    let chunk: Vec<f32> = buffer.drain(..chunk_samples).collect();
                    // Record capture audio (even when muted, to keep session alive)
                    if let Ok(mut w) = capture_wav.lock() {
                        if let Some(ref mut wav) = *w { wav.write_f32(&chunk); }
                    }
                    // Skip emitting events when muted (still reading audio to keep capture alive)
                    if muted_for_capture.load(Ordering::Relaxed) {
                        continue;
                    }
                    let b64 = samples_to_base64(&chunk);
                    let (rms, peak, dbfs) = compute_level(&chunk);

                    let audio_event = json!({
                        "type": "audio.chunk",
                        "trackId": "mic",
                        "format": "pcm_s16le",
                        "sampleRate": sample_rate,
                        "channels": 1,
                        "data": b64,
                        "durationMs": chunk_ms,
                    });
                    writeln!(out, "{}", audio_event).unwrap();

                    let level_event = json!({
                        "type": "audio.level",
                        "trackId": "mic",
                        "rms": rms,
                        "peak": peak,
                        "dbfs": dbfs,
                    });
                    writeln!(out, "{}", level_event).unwrap();
                    out.flush().unwrap();
                }
            }
            Some(Err(e)) => {
                eprintln!("[mic-speaker] Capture error: {:?}", e);
                break;
            }
            None => {
                eprintln!("[mic-speaker] Capture channel closed");
                break;
            }
        }
    }

    let done = json!({"type": "lifecycle.done", "component": "mic-speaker"});
    writeln!(out, "{}", done).unwrap();
    out.flush().unwrap();
}
