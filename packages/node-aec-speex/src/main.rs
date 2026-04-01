use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::time::Instant;

// Raw FFI bindings for speexdsp echo cancellation
mod ffi {
    use libc::c_int;

    #[repr(C)]
    pub struct SpeexEchoState {
        _opaque: [u8; 0],
    }

    pub const SPEEX_ECHO_SET_SAMPLING_RATE: c_int = 24;

    unsafe extern "C" {
        pub fn speex_echo_state_init(frame_size: c_int, filter_length: c_int) -> *mut SpeexEchoState;
        pub fn speex_echo_state_destroy(st: *mut SpeexEchoState);
        pub fn speex_echo_state_reset(st: *mut SpeexEchoState);
        pub fn speex_echo_cancellation(
            st: *mut SpeexEchoState,
            rec: *const i16,
            play: *const i16,
            out: *mut i16,
        );
        pub fn speex_echo_ctl(st: *mut SpeexEchoState, request: c_int, ptr: *mut libc::c_void) -> c_int;
    }
}

const SAMPLE_RATE: u32 = 16000;
const FRAME_SIZE: usize = 160; // 10ms at 16kHz

struct AecState {
    state: *mut ffi::SpeexEchoState,
    mic_buf: Vec<i16>,
    ref_buf: Vec<i16>,
}

impl AecState {
    fn new(filter_length: usize) -> Self {
        let state = unsafe {
            ffi::speex_echo_state_init(FRAME_SIZE as i32, filter_length as i32)
        };
        unsafe {
            let mut rate = SAMPLE_RATE as i32;
            ffi::speex_echo_ctl(
                state,
                ffi::SPEEX_ECHO_SET_SAMPLING_RATE,
                &mut rate as *mut i32 as *mut libc::c_void,
            );
        }
        AecState {
            state,
            mic_buf: Vec::new(),
            ref_buf: Vec::new(),
        }
    }

    fn reset(&mut self) {
        unsafe { ffi::speex_echo_state_reset(self.state) };
        self.mic_buf.clear();
        self.ref_buf.clear();
    }

    fn feed_mic(&mut self, samples: &[i16]) -> Vec<i16> {
        self.mic_buf.extend_from_slice(samples);
        self.process_frames()
    }

    fn feed_ref(&mut self, samples: &[i16]) {
        self.ref_buf.extend_from_slice(samples);
    }

    fn process_frames(&mut self) -> Vec<i16> {
        let mut output = Vec::new();
        while self.mic_buf.len() >= FRAME_SIZE {
            // If no ref available, use silence — the adaptive filter
            // needs a continuous ref stream to learn the echo path
            let ref_frame: Vec<i16>;
            if self.ref_buf.len() >= FRAME_SIZE {
                ref_frame = self.ref_buf[..FRAME_SIZE].to_vec();
                self.ref_buf.drain(..FRAME_SIZE);
            } else {
                ref_frame = vec![0i16; FRAME_SIZE]; // silence
            }

            let mut out_frame = vec![0i16; FRAME_SIZE];
            unsafe {
                ffi::speex_echo_cancellation(
                    self.state,
                    self.mic_buf[..FRAME_SIZE].as_ptr(),
                    ref_frame.as_ptr(),
                    out_frame.as_mut_ptr(),
                );
            }
            output.extend_from_slice(&out_frame);
            self.mic_buf.drain(..FRAME_SIZE);
        }
        output
    }
}

impl Drop for AecState {
    fn drop(&mut self) {
        unsafe { ffi::speex_echo_state_destroy(self.state) };
    }
}

fn samples_to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

fn bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

// ---- WAV debug recording ----

struct WavWriter {
    file: File,
    data_len: u32,
}

impl WavWriter {
    fn new(path: &str, sample_rate: u32) -> io::Result<Self> {
        let mut file = File::create(path)?;
        // Write placeholder header (44 bytes), update on drop
        let header = [0u8; 44];
        file.write_all(&header)?;
        eprintln!("[aec] Recording to {}", path);
        Ok(WavWriter { file, data_len: 0 })
    }

    fn write_samples(&mut self, samples: &[i16]) {
        let bytes = samples.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>();
        let _ = self.file.write_all(&bytes);
        self.data_len += bytes.len() as u32;
    }

    fn finalize(&mut self, sample_rate: u32) {
        use std::io::Seek;
        let _ = self.file.seek(io::SeekFrom::Start(0));
        let file_size = 36 + self.data_len;
        let mut hdr = Vec::with_capacity(44);
        hdr.extend_from_slice(b"RIFF");
        hdr.extend_from_slice(&file_size.to_le_bytes());
        hdr.extend_from_slice(b"WAVEfmt ");
        hdr.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        hdr.extend_from_slice(&1u16.to_le_bytes());  // PCM
        hdr.extend_from_slice(&1u16.to_le_bytes());  // mono
        hdr.extend_from_slice(&sample_rate.to_le_bytes());
        hdr.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        hdr.extend_from_slice(&2u16.to_le_bytes());  // block align
        hdr.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        hdr.extend_from_slice(b"data");
        hdr.extend_from_slice(&self.data_len.to_le_bytes());
        let _ = self.file.write_all(&hdr);
    }
}

fn main() {
    let settings_str = std::env::var("ACPFX_SETTINGS").unwrap_or_default();
    let settings: Value = if settings_str.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&settings_str).expect("Invalid ACPFX_SETTINGS JSON")
    };

    let mic_source = settings["micSource"]
        .as_str()
        .unwrap_or("mic")
        .to_string();
    let speaker_source = settings["speakerSource"]
        .as_str()
        .unwrap_or("player")
        .to_string();
    let filter_length = settings["filterLength"]
        .as_u64()
        .unwrap_or(16000) as usize; // 1s at 16kHz — covers speaker buffer + room + air

    // Debug recording: set ACPFX_AEC_DEBUG=1 or debugDir in settings
    let debug_dir = settings["debugDir"].as_str().map(|s| s.to_string())
        .or_else(|| std::env::var("ACPFX_AEC_DEBUG").ok().filter(|v| v == "1").map(|_| "./aec-debug".to_string()));

    let mut aec = AecState::new(filter_length);
    eprintln!("[aec] filter_length={}", filter_length);

    let mut mic_wav: Option<WavWriter> = None;
    let mut ref_wav: Option<WavWriter> = None;
    let mut out_wav: Option<WavWriter> = None;
    let mut debug_log: Option<File> = None;
    let start_time = Instant::now();

    if let Some(ref dir) = debug_dir {
        std::fs::create_dir_all(dir).ok();
        mic_wav = WavWriter::new(&format!("{}/mic_raw.wav", dir), SAMPLE_RATE).ok();
        ref_wav = WavWriter::new(&format!("{}/speaker_ref.wav", dir), SAMPLE_RATE).ok();
        out_wav = WavWriter::new(&format!("{}/aec_output.wav", dir), SAMPLE_RATE).ok();
        debug_log = File::create(format!("{}/aec_events.jsonl", dir)).ok();
        if debug_log.is_some() {
            eprintln!("[aec] Debug recording to {}/", dir);
        }
    }

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    // Emit lifecycle.ready
    let ready = json!({"type": "lifecycle.ready"});
    writeln!(out, "{}", ready).unwrap();
    out.flush().unwrap();

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
            Err(_) => {
                eprintln!("[aec-speex] invalid JSON: {}", &line[..line.len().min(80)]);
                continue;
            }
        };

        let event_type = event["type"].as_str().unwrap_or("");

        match event_type {
            "audio.chunk" => {
                let from = event["_from"].as_str().unwrap_or("");
                let data = match event["data"].as_str() {
                    Some(d) => d,
                    None => continue,
                };
                let bytes = match B64.decode(data) {
                    Ok(b) => b,
                    Err(_) => {
                        eprintln!("[aec-speex] invalid base64 in audio.chunk");
                        continue;
                    }
                };
                let samples = bytes_to_samples(&bytes);

                if from == speaker_source {
                    if let Some(ref mut w) = ref_wav { w.write_samples(&samples); }
                    if let Some(ref mut log) = debug_log {
                        let elapsed = start_time.elapsed().as_millis();
                        let ts = event["ts"].as_u64().unwrap_or(0);
                        let rms = (samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt();
                        let _ = writeln!(log, "{{\"t\":{},\"ts\":{},\"src\":\"ref\",\"samples\":{},\"rms\":{:.0},\"mic_buf\":{},\"ref_buf\":{}}}",
                            elapsed, ts, samples.len(), rms, aec.mic_buf.len(), aec.ref_buf.len());
                    }
                    aec.feed_ref(&samples);
                } else if from == mic_source {
                    if let Some(ref mut w) = mic_wav { w.write_samples(&samples); }
                    let ref_buf_before = aec.ref_buf.len();
                    if let Some(ref mut log) = debug_log {
                        let elapsed = start_time.elapsed().as_millis();
                        let ts = event["ts"].as_u64().unwrap_or(0);
                        let rms = (samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt();
                        let _ = writeln!(log, "{{\"t\":{},\"ts\":{},\"src\":\"mic\",\"samples\":{},\"rms\":{:.0},\"mic_buf\":{},\"ref_buf\":{},\"passthrough\":{}}}",
                            elapsed, ts, samples.len(), rms, aec.mic_buf.len(), ref_buf_before, ref_buf_before == 0);
                    }
                    let cleaned = aec.feed_mic(&samples);
                    if !cleaned.is_empty() {
                        if let Some(ref mut w) = out_wav { w.write_samples(&cleaned); }
                        if let Some(ref mut log) = debug_log {
                            let rms = (cleaned.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / cleaned.len() as f64).sqrt();
                            let _ = writeln!(log, "{{\"t\":{},\"src\":\"out\",\"samples\":{},\"rms\":{:.0}}}",
                                start_time.elapsed().as_millis(), cleaned.len(), rms);
                        }
                        let out_bytes = samples_to_bytes(&cleaned);
                        let out_b64 = B64.encode(&out_bytes);
                        let duration_ms = (cleaned.len() as f64 / SAMPLE_RATE as f64 * 1000.0) as u64;
                        // Preserve original event fields, update data and duration
                        let mut out_event = event.clone();
                        out_event["data"] = json!(out_b64);
                        out_event["durationMs"] = json!(duration_ms);
                        // Remove _from so orchestrator re-stamps it
                        out_event.as_object_mut().map(|o| o.remove("_from"));
                        out_event.as_object_mut().map(|o| o.remove("ts"));
                        writeln!(out, "{}", out_event).unwrap();
                        out.flush().unwrap();
                    }
                }
            }
            "control.interrupt" => {
                aec.reset();
            }
            _ => {
                // Pass through other events unchanged
                writeln!(out, "{}", line).unwrap();
                out.flush().unwrap();
            }
        }
    }

    // Finalize WAV files on stdin close
    if let Some(ref mut w) = mic_wav { w.finalize(SAMPLE_RATE); }
    if let Some(ref mut w) = ref_wav { w.finalize(SAMPLE_RATE); }
    if let Some(ref mut w) = out_wav { w.finalize(SAMPLE_RATE); }
    eprintln!("[aec] Debug WAVs finalized");
}
