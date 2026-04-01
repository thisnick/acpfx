use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

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
        while self.mic_buf.len() >= FRAME_SIZE && self.ref_buf.len() >= FRAME_SIZE {
            let mut out_frame = vec![0i16; FRAME_SIZE];
            unsafe {
                ffi::speex_echo_cancellation(
                    self.state,
                    self.mic_buf[..FRAME_SIZE].as_ptr(),
                    self.ref_buf[..FRAME_SIZE].as_ptr(),
                    out_frame.as_mut_ptr(),
                );
            }
            output.extend_from_slice(&out_frame);
            self.mic_buf.drain(..FRAME_SIZE);
            self.ref_buf.drain(..FRAME_SIZE);
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
        .unwrap_or(1024) as usize;

    let mut aec = AecState::new(filter_length);

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
                    aec.feed_ref(&samples);
                } else if from == mic_source {
                    let cleaned = aec.feed_mic(&samples);
                    if !cleaned.is_empty() {
                        let out_bytes = samples_to_bytes(&cleaned);
                        let out_b64 = B64.encode(&out_bytes);
                        let out_event = json!({
                            "type": "audio.chunk",
                            "data": out_b64,
                        });
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
}
