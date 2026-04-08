use crate::backends::PlaybackCommand;
use crate::AecError;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::types::IOType;
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};

use flume::{Receiver, Sender};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Shared buffer for playback samples
struct PlaybackBuffer {
    samples: VecDeque<f32>,
}

/// Create macOS backend. Spawns a task that owns audio resources.
/// Returns (sample_rate, buffer_size). Task stops when sender fails.
pub fn create_backend(
    public_sender: Sender<Vec<f32>>,
    playback_rx: Receiver<PlaybackCommand>,
) -> Result<(u32, usize), AecError> {
    let (callback_tx, callback_rx) = flume::bounded::<Vec<f32>>(32);

    // Create shared playback buffer for render callback
    let playback_buffer = Arc::new(Mutex::new(PlaybackBuffer {
        samples: VecDeque::with_capacity(48000), // ~1 second at 48kHz
    }));
    // Create VoiceProcessingIO audio unit - this enables OS-level AEC
    // VoiceProcessingIO automatically monitors system output for echo reference
    let mut audio_unit = AudioUnit::new(IOType::VoiceProcessingIO).map_err(|e| {
        AecError::BackendError(format!("failed to create VoiceProcessingIO: {e:?}"))
    })?;

    // coreaudio-rs may auto-initialize; must uninitialize before configuring properties
    let _ = audio_unit.uninitialize();

    let enable_input: u32 = 1;
    audio_unit
        .set_property(
            coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable_input),
        )
        .map_err(|e| AecError::BackendError(format!("failed to enable input: {e:?}")))?;

    // let enable_output: u32 = 1;
    // audio_unit
    //     .set_property(
    //         coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
    //         Scope::Output,
    //         Element::Output,
    //         Some(&enable_output),
    //     )
    //     .map_err(|e| AecError::BackendError(format!("failed to enable output: {e:?}")))?;

    // Query native format - VoiceProcessingIO has strict requirements
    let native_format = audio_unit
        .stream_format(Scope::Output, Element::Input)
        .map_err(|e| AecError::BackendError(format!("failed to get native format: {e:?}")))?;

    // Use native sample rate but request f32 mono non-interleaved (canonical for VPIO)
    let stream_format = StreamFormat {
        sample_rate: native_format.sample_rate,
        sample_format: SampleFormat::F32,
        flags: coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_FLOAT
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_PACKED
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_NON_INTERLEAVED,
        channels: 1,
    };

    audio_unit
        .set_stream_format(stream_format, Scope::Output, Element::Input)
        .map_err(|e| AecError::BackendError(format!("failed to set input stream format: {e:?}")))?;

    // Also set stream format for output element (for render callback)
    audio_unit
        .set_stream_format(stream_format, Scope::Input, Element::Output)
        .map_err(|e| {
            AecError::BackendError(format!("failed to set output stream format: {e:?}"))
        })?;

    let native_rate = native_format.sample_rate as u32;

    audio_unit
        .set_input_callback(
            move |args: render_callback::Args<data::NonInterleaved<f32>>| {
                let buffer = args.data.channels().next().unwrap();
                let _ = callback_tx.try_send(buffer.to_vec());
                Ok(())
            },
        )
        .map_err(|e| AecError::BackendError(format!("failed to set input callback: {e:?}")))?;

    // Set render callback for playback output - VoiceProcessingIO AEC uses this as echo reference
    let buffer_for_render = playback_buffer.clone();
    audio_unit
        .set_render_callback(
            move |mut args: render_callback::Args<data::NonInterleaved<f32>>| {
                let output_buffer = args.data.channels_mut().next().unwrap();
                // Use try_lock to avoid blocking in audio callback
                if let Ok(mut buffer) = buffer_for_render.try_lock() {
                    for sample in output_buffer.iter_mut() {
                        *sample = buffer.samples.pop_front().unwrap_or(0.0);
                    }
                } else {
                    for sample in output_buffer.iter_mut() {
                        *sample = 0.0;
                    }
                }
                Ok(())
            },
        )
        .map_err(|e| AecError::BackendError(format!("failed to set render callback: {e:?}")))?;

    audio_unit
        .initialize()
        .map_err(|e| AecError::BackendError(format!("failed to initialize: {e:?}")))?;

    audio_unit
        .start()
        .map_err(|e| AecError::BackendError(format!("failed to start: {e:?}")))?;

    // Query buffer size from audio unit (frames per slice)
    let buffer_size: u32 = audio_unit
        .get_property(
            coreaudio::sys::kAudioUnitProperty_MaximumFramesPerSlice,
            Scope::Global,
            Element::Output,
        )
        .unwrap_or(512);

    let buffer_for_playback = playback_buffer.clone();
    tokio::spawn(async move {
        while let Ok(command) = playback_rx.recv_async().await {
            match command {
                PlaybackCommand::OneShot(samples) => {
                    let Ok(mut buf) = buffer_for_playback.lock() else {
                        continue;
                    };
                    buf.samples.extend(samples);
                }
                PlaybackCommand::StartStream(chunk_rx) => {
                    let buf = buffer_for_playback.clone();
                    tokio::spawn(async move {
                        while let Ok(samples) = chunk_rx.recv_async().await {
                            let Ok(mut b) = buf.lock() else {
                                break;
                            };
                            b.samples.extend(samples);
                        }
                    });
                }
                PlaybackCommand::ClearBuffer => {
                    if let Ok(mut buf) = buffer_for_playback.lock() {
                        buf.samples.clear();
                    }
                }
            }
        }
    });

    // Spawn task that owns audio_unit and forwards capture - stops on sender disconnect
    tokio::spawn(async move {
        let _audio_unit = audio_unit; // Hold for RAII, Drop stops audio

        while let Ok(samples) = callback_rx.recv_async().await {
            if public_sender.send_async(samples).await.is_err() {
                break;
            }
        }
    });

    Ok((native_rate, buffer_size as usize))
}

// ---------------------------------------------------------------------------
// Independent capture (RemoteIO, no AEC) — for PTT mode
// ---------------------------------------------------------------------------

/// Create a capture-only AudioUnit using RemoteIO (no VoiceProcessingIO).
/// No render callback, no AEC. Dropping the returned AudioUnit stops capture
/// and the OS mic indicator disappears.
///
/// Returns (native_sample_rate, buffer_size, Box holding the AudioUnit for RAII).
pub fn create_capture_only(
    public_sender: Sender<Vec<f32>>,
) -> Result<(u32, usize, Box<dyn std::any::Any + Send>), AecError> {
    let (callback_tx, callback_rx) = flume::bounded::<Vec<f32>>(32);

    // Use RemoteIO — lightweight, no AEC processing
    let mut audio_unit = AudioUnit::new(IOType::RemoteIO).map_err(|e| {
        AecError::BackendError(format!("failed to create RemoteIO: {e:?}"))
    })?;

    let _ = audio_unit.uninitialize();

    // Enable input
    let enable_input: u32 = 1;
    audio_unit
        .set_property(
            coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable_input),
        )
        .map_err(|e| AecError::BackendError(format!("failed to enable input: {e:?}")))?;

    // Disable output (capture only)
    let disable_output: u32 = 0;
    audio_unit
        .set_property(
            coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
            Scope::Output,
            Element::Output,
            Some(&disable_output),
        )
        .map_err(|e| AecError::BackendError(format!("failed to disable output: {e:?}")))?;

    // Query native format
    let native_format = audio_unit
        .stream_format(Scope::Output, Element::Input)
        .map_err(|e| AecError::BackendError(format!("failed to get native format: {e:?}")))?;

    let stream_format = StreamFormat {
        sample_rate: native_format.sample_rate,
        sample_format: SampleFormat::F32,
        flags: coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_FLOAT
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_PACKED
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_NON_INTERLEAVED,
        channels: 1,
    };

    audio_unit
        .set_stream_format(stream_format, Scope::Output, Element::Input)
        .map_err(|e| AecError::BackendError(format!("failed to set input stream format: {e:?}")))?;

    let native_rate = native_format.sample_rate as u32;

    audio_unit
        .set_input_callback(
            move |args: render_callback::Args<data::NonInterleaved<f32>>| {
                let buffer = args.data.channels().next().unwrap();
                let _ = callback_tx.try_send(buffer.to_vec());
                Ok(())
            },
        )
        .map_err(|e| AecError::BackendError(format!("failed to set input callback: {e:?}")))?;

    audio_unit
        .initialize()
        .map_err(|e| AecError::BackendError(format!("failed to initialize: {e:?}")))?;

    audio_unit
        .start()
        .map_err(|e| AecError::BackendError(format!("failed to start: {e:?}")))?;

    let buffer_size: u32 = audio_unit
        .get_property(
            coreaudio::sys::kAudioUnitProperty_MaximumFramesPerSlice,
            Scope::Global,
            Element::Output,
        )
        .unwrap_or(512);

    // The AudioUnit must stay alive for capture to work.
    // We move it into a spawned task that also forwards samples.
    // When the public_sender's receiver is dropped, the task exits and
    // the AudioUnit is dropped, stopping capture.
    let handle: Box<dyn std::any::Any + Send> = Box::new(public_sender.clone());

    tokio::spawn(async move {
        let _audio_unit = audio_unit; // RAII — Drop stops capture

        while let Ok(samples) = callback_rx.recv_async().await {
            if public_sender.send_async(samples).await.is_err() {
                break;
            }
        }
    });

    Ok((native_rate, buffer_size as usize, handle))
}

// ---------------------------------------------------------------------------
// Independent playback (DefaultOutput, no AEC) — for PTT mode
// ---------------------------------------------------------------------------

/// Create a playback-only AudioUnit using DefaultOutput.
/// Always-on for speaker output. Returns the native sample rate.
pub fn create_playback_only(
    playback_rx: Receiver<PlaybackCommand>,
) -> Result<u32, AecError> {
    let playback_buffer = Arc::new(Mutex::new(PlaybackBuffer {
        samples: VecDeque::with_capacity(48000),
    }));

    let mut audio_unit = AudioUnit::new(IOType::DefaultOutput).map_err(|e| {
        AecError::BackendError(format!("failed to create DefaultOutput: {e:?}"))
    })?;

    let _ = audio_unit.uninitialize();

    let native_format = audio_unit
        .stream_format(Scope::Input, Element::Output)
        .map_err(|e| AecError::BackendError(format!("failed to get output format: {e:?}")))?;

    let stream_format = StreamFormat {
        sample_rate: native_format.sample_rate,
        sample_format: SampleFormat::F32,
        flags: coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_FLOAT
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_PACKED
            | coreaudio::audio_unit::audio_format::LinearPcmFlags::IS_NON_INTERLEAVED,
        channels: 1,
    };

    audio_unit
        .set_stream_format(stream_format, Scope::Input, Element::Output)
        .map_err(|e| {
            AecError::BackendError(format!("failed to set output stream format: {e:?}"))
        })?;

    let native_rate = native_format.sample_rate as u32;

    let buffer_for_render = playback_buffer.clone();
    audio_unit
        .set_render_callback(
            move |mut args: render_callback::Args<data::NonInterleaved<f32>>| {
                let output_buffer = args.data.channels_mut().next().unwrap();
                if let Ok(mut buffer) = buffer_for_render.try_lock() {
                    for sample in output_buffer.iter_mut() {
                        *sample = buffer.samples.pop_front().unwrap_or(0.0);
                    }
                } else {
                    for sample in output_buffer.iter_mut() {
                        *sample = 0.0;
                    }
                }
                Ok(())
            },
        )
        .map_err(|e| AecError::BackendError(format!("failed to set render callback: {e:?}")))?;

    audio_unit
        .initialize()
        .map_err(|e| AecError::BackendError(format!("failed to initialize: {e:?}")))?;

    audio_unit
        .start()
        .map_err(|e| AecError::BackendError(format!("failed to start: {e:?}")))?;

    let buffer_for_playback = playback_buffer.clone();
    tokio::spawn(async move {
        let _audio_unit = audio_unit; // RAII — Drop stops playback

        while let Ok(command) = playback_rx.recv_async().await {
            match command {
                PlaybackCommand::OneShot(samples) => {
                    let Ok(mut buf) = buffer_for_playback.lock() else {
                        continue;
                    };
                    buf.samples.extend(samples);
                }
                PlaybackCommand::StartStream(chunk_rx) => {
                    let buf = buffer_for_playback.clone();
                    tokio::spawn(async move {
                        while let Ok(samples) = chunk_rx.recv_async().await {
                            let Ok(mut b) = buf.lock() else {
                                break;
                            };
                            b.samples.extend(samples);
                        }
                    });
                }
                PlaybackCommand::ClearBuffer => {
                    if let Ok(mut buf) = buffer_for_playback.lock() {
                        buf.samples.clear();
                    }
                }
            }
        }
    });

    Ok(native_rate)
}
