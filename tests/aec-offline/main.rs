/// Offline AEC test: process captured mic + speaker ref WAVs through aec3-rs
/// and measure echo suppression.
///
/// Usage: aec-offline-test <mic.wav> <ref.wav> <output.wav>

use aec3::voip::VoipAec3;
use hound::{WavReader, WavSpec, WavWriter, SampleFormat};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: {} <mic.wav> <ref.wav> <output.wav>", args[0]);
        eprintln!("  Processes mic audio through AEC3 using ref as speaker reference.");
        eprintln!("  Writes cleaned output to output.wav.");
        std::process::exit(1);
    }

    let mic_path = &args[1];
    let ref_path = &args[2];
    let out_path = &args[3];

    // Load WAV files
    let mic_samples = load_wav_i16(mic_path);
    let ref_samples = load_wav_i16(ref_path);

    eprintln!("Mic: {} samples ({:.1}s)", mic_samples.len(), mic_samples.len() as f64 / 16000.0);
    eprintln!("Ref: {} samples ({:.1}s)", ref_samples.len(), ref_samples.len() as f64 / 16000.0);

    // Create AEC3 processor with aggressive suppression
    use aec3::api::config::*;

    let mut config = EchoCanceller3Config::default();
    // More aggressive suppression: lower enr_suppress = suppress more
    config.suppressor.normal_tuning.mask_lf.enr_suppress = 0.05;  // default 0.4
    config.suppressor.normal_tuning.mask_hf.enr_suppress = 0.02;  // default 0.1
    config.suppressor.nearend_tuning.mask_lf.enr_suppress = 0.2;  // default 1.1
    config.suppressor.nearend_tuning.mask_hf.enr_suppress = 0.1;  // default 0.3
    config.ep_strength.default_gain = 2.0;  // stronger echo path gain estimate

    let mut pipeline = VoipAec3::builder(16000, 1, 1)
        .with_config(config)
        .initial_delay_ms(800)  // measured delay from captures
        .enable_high_pass(true)
        .enable_noise_suppression(true)
        .build()
        .expect("Failed to create AEC3");

    let frame_size = 160; // 10ms at 16kHz

    // Pad ref to same length as mic (silence after speaker stops)
    let mut ref_padded = ref_samples.clone();
    ref_padded.resize(mic_samples.len(), 0i16);

    let mut output: Vec<i16> = Vec::with_capacity(mic_samples.len());
    let mut mic_energy_during_ref = 0.0f64;
    let mut out_energy_during_ref = 0.0f64;
    let mut ref_active_frames = 0u32;

    // Process frame by frame
    let num_frames = mic_samples.len() / frame_size;
    for i in 0..num_frames {
        let start = i * frame_size;
        let end = start + frame_size;

        // Convert to f32
        let ref_frame: Vec<f32> = ref_padded[start..end].iter().map(|&s| s as f32 / 32768.0).collect();
        let capture_frame: Vec<f32> = mic_samples[start..end].iter().map(|&s| s as f32 / 32768.0).collect();
        let mut out_frame = vec![0.0f32; frame_size];

        // Feed render (speaker reference) - async mode
        pipeline.handle_render_frame(&ref_frame).ok();

        // Process capture (mic) - modifies in place
        pipeline.process_capture_frame(&capture_frame, false, &mut out_frame).ok();

        // Convert back to i16
        let out_i16: Vec<i16> = out_frame.iter().map(|&s| {
            (s * 32768.0).clamp(-32768.0, 32767.0) as i16
        }).collect();
        output.extend_from_slice(&out_i16);

        // Measure energy during ref active periods
        let ref_rms: f64 = ref_frame.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / frame_size as f64;
        if ref_rms > 0.0001 { // ref is active
            let mic_rms: f64 = capture_frame.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
            let out_rms: f64 = out_frame.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
            mic_energy_during_ref += mic_rms;
            out_energy_during_ref += out_rms;
            ref_active_frames += 1;
        }
    }

    // Write output WAV
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(out_path, spec).expect("Failed to create output WAV");
    for s in &output {
        writer.write_sample(*s).unwrap();
    }
    writer.finalize().unwrap();

    eprintln!("\nOutput: {} samples ({:.1}s) → {}", output.len(), output.len() as f64 / 16000.0, out_path);

    // Report suppression
    if ref_active_frames > 0 && out_energy_during_ref > 0.0 {
        let suppression_db = 10.0 * (mic_energy_during_ref / out_energy_during_ref).log10();
        eprintln!("\n=== Results (during speaker playback: {} frames) ===", ref_active_frames);
        eprintln!("Mic energy:    {:.2}", (mic_energy_during_ref / ref_active_frames as f64).sqrt());
        eprintln!("Output energy: {:.2}", (out_energy_during_ref / ref_active_frames as f64).sqrt());
        eprintln!("Suppression:   {:.1} dB", suppression_db);
    } else {
        eprintln!("\nNo ref-active frames detected");
    }

    // Also measure per-second suppression to see convergence
    eprintln!("\n=== Per-second suppression ===");
    let frames_per_sec = 16000 / frame_size;
    let total_secs = num_frames / frames_per_sec;
    for sec in 0..total_secs {
        let start_frame = sec * frames_per_sec;
        let end_frame = start_frame + frames_per_sec;
        let mut mic_e = 0.0f64;
        let mut out_e = 0.0f64;
        let mut ref_active = 0;

        for f in start_frame..end_frame {
            let s = f * frame_size;
            let e = s + frame_size;
            if e > ref_padded.len() { break; }
            let ref_rms: f64 = ref_padded[s..e].iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / frame_size as f64;
            if ref_rms > 100.0 {
                mic_e += mic_samples[s..e].iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
                out_e += output[s..e].iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
                ref_active += 1;
            }
        }

        if ref_active > 0 && out_e > 0.0 {
            let db = 10.0 * (mic_e / out_e).log10();
            eprintln!("  {}s: {:.1} dB suppression ({} active frames)", sec, db, ref_active);
        }
    }
}

fn load_wav_i16(path: &str) -> Vec<i16> {
    let mut reader = WavReader::open(path).expect(&format!("Failed to open {}", path));
    reader.samples::<i16>().map(|s| s.unwrap()).collect()
}
