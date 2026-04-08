#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

use crate::resampler::Resampler;
use crate::AecError;

use std::sync::Mutex;

/// Handle for sending audio to the backend for playback.
/// Audio played through this handle goes through the same engine as capture,
/// enabling AEC to cancel it from the recorded audio.

#[derive(Clone)]
pub struct BackendHandle {
    playback_tx: flume::Sender<PlaybackCommand>,
    native_sample_rate: u32,
    /// Persistent resampler — avoids creating a new one per play_audio() call,
    /// which causes audio discontinuities at chunk boundaries.
    resampler: std::sync::Arc<Mutex<Option<Resampler>>>,
    resampler_source_rate: std::sync::Arc<Mutex<u32>>,
}

pub(crate) enum PlaybackCommand {
    OneShot(Vec<f32>),
    StartStream(flume::Receiver<Vec<f32>>),
    ClearBuffer,
}

impl BackendHandle {
    /// Play a complete audio buffer. Uses a persistent resampler for smooth playback.
    pub fn play_audio(&self, samples: Vec<f32>, sample_rate: u32) -> Result<(), AecError> {
        let resampled = if sample_rate == self.native_sample_rate {
            samples
        } else {
            let mut resampler_guard = self.resampler.lock()
                .map_err(|_| AecError::BackendError("resampler lock poisoned".to_string()))?;
            let mut rate_guard = self.resampler_source_rate.lock()
                .map_err(|_| AecError::BackendError("resampler lock poisoned".to_string()))?;

            // Recreate resampler if source rate changed
            if resampler_guard.is_none() || *rate_guard != sample_rate {
                *resampler_guard = Some(Resampler::new(sample_rate, self.native_sample_rate)?);
                *rate_guard = sample_rate;
            }

            resampler_guard.as_mut().unwrap().process(&samples)?
        };
        self.playback_tx
            .send(PlaybackCommand::OneShot(resampled))
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))
    }

    /// Start a streaming playback session. Returns a sender for audio chunks.
    /// The stream ends when the sender is dropped.
    pub fn start_playback_stream(
        &self,
        sample_rate: u32,
    ) -> Result<flume::Sender<Vec<f32>>, AecError> {
        let (user_tx, user_rx) = flume::bounded::<Vec<f32>>(64);
        let (backend_tx, backend_rx) = flume::bounded::<Vec<f32>>(64);

        spawn_resampler(user_rx, backend_tx, sample_rate, self.native_sample_rate);

        self.playback_tx
            .send(PlaybackCommand::StartStream(backend_rx))
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))?;

        Ok(user_tx)
    }

    /// Clear the playback buffer immediately — used for interrupt/barge-in.
    pub fn clear_playback(&self) -> Result<(), AecError> {
        self.playback_tx
            .send(PlaybackCommand::ClearBuffer)
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))
    }
}


fn spawn_resampler(
    user_rx: flume::Receiver<Vec<f32>>,
    backend_tx: flume::Sender<Vec<f32>>,
    source_rate: u32,
    target_rate: u32,
) {
    tokio::spawn(async move {
        let mut resampler = if source_rate != target_rate {
            Resampler::new(source_rate, target_rate).ok()
        } else {
            None
        };

        while let Ok(chunk) = user_rx.recv_async().await {
            let samples = resample_chunk(&mut resampler, chunk);
            if backend_tx.send_async(samples).await.is_err() {
                break;
            }
        }
    });
}

fn resample_chunk(resampler: &mut Option<Resampler>, chunk: Vec<f32>) -> Vec<f32> {
    let Some(r) = resampler else {
        return chunk;
    };
    r.process(&chunk).unwrap_or(chunk)
}

/// Create the appropriate platform backend.
/// Spawns a capture task that owns audio resources.
/// Returns (sample_rate, buffer_size, handle). Task stops when sender disconnects.
pub(crate) fn create_backend(
    sender: flume::Sender<Vec<f32>>,
) -> Result<(u32, usize, BackendHandle), AecError> {
    let (playback_tx, playback_rx) = flume::bounded::<PlaybackCommand>(16);

    #[cfg(target_os = "macos")]
    {
        let (rate, size) = macos::create_backend(sender, playback_rx)?;
        let handle = BackendHandle {
            playback_tx,
            native_sample_rate: rate,
            resampler: std::sync::Arc::new(Mutex::new(None)),
            resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
        };
        Ok((rate, size, handle))
    }

    #[cfg(target_os = "ios")]
    {
        let (rate, size) = ios::create_backend(sender, playback_rx)?;
        let handle = BackendHandle {
            playback_tx,
            native_sample_rate: rate,
            resampler: std::sync::Arc::new(Mutex::new(None)),
            resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
        };
        Ok((rate, size, handle))
    }

    #[cfg(target_os = "windows")]
    {
        let (rate, size) = windows::create_backend(sender, playback_rx)?;
        let handle = BackendHandle {
            playback_tx,
            native_sample_rate: rate,
            resampler: std::sync::Arc::new(Mutex::new(None)),
            resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
        };
        Ok((rate, size, handle))
    }

    #[cfg(target_os = "linux")]
    {
        let (rate, size) = linux::create_backend(sender, playback_rx)?;
        let handle = BackendHandle {
            playback_tx,
            native_sample_rate: rate,
            resampler: std::sync::Arc::new(Mutex::new(None)),
            resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
        };
        Ok((rate, size, handle))
    }

    #[cfg(target_os = "android")]
    {
        let (rate, size) = android::create_backend(sender, playback_rx)?;
        let handle = BackendHandle {
            playback_tx,
            native_sample_rate: rate,
            resampler: std::sync::Arc::new(Mutex::new(None)),
            resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
        };
        Ok((rate, size, handle))
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "windows",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (sender, playback_rx);
        Err(AecError::AecNotSupported)
    }
}

// ---------------------------------------------------------------------------
// Independent capture / playback handles (for PTT mode — no AEC)
// ---------------------------------------------------------------------------

/// Playback-only backend handle. Same playback logic as BackendHandle but
/// decoupled from capture. Speaker output is always-on.
#[derive(Clone)]
pub(crate) struct PlaybackBackendHandle {
    playback_tx: flume::Sender<PlaybackCommand>,
    native_sample_rate: u32,
    resampler: std::sync::Arc<Mutex<Option<Resampler>>>,
    resampler_source_rate: std::sync::Arc<Mutex<u32>>,
}

impl PlaybackBackendHandle {
    /// Play a complete audio buffer. Uses a persistent resampler for smooth playback.
    pub fn play_audio(&self, samples: Vec<f32>, sample_rate: u32) -> Result<(), AecError> {
        let resampled = if sample_rate == self.native_sample_rate {
            samples
        } else {
            let mut resampler_guard = self
                .resampler
                .lock()
                .map_err(|_| AecError::BackendError("resampler lock poisoned".to_string()))?;
            let mut rate_guard = self
                .resampler_source_rate
                .lock()
                .map_err(|_| AecError::BackendError("resampler lock poisoned".to_string()))?;

            if resampler_guard.is_none() || *rate_guard != sample_rate {
                *resampler_guard = Some(Resampler::new(sample_rate, self.native_sample_rate)?);
                *rate_guard = sample_rate;
            }

            resampler_guard.as_mut().unwrap().process(&samples)?
        };
        self.playback_tx
            .send(PlaybackCommand::OneShot(resampled))
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))
    }

    /// Start a streaming playback session.
    pub fn start_playback_stream(
        &self,
        sample_rate: u32,
    ) -> Result<flume::Sender<Vec<f32>>, AecError> {
        let (user_tx, user_rx) = flume::bounded::<Vec<f32>>(64);
        let (backend_tx, backend_rx) = flume::bounded::<Vec<f32>>(64);

        spawn_resampler(user_rx, backend_tx, sample_rate, self.native_sample_rate);

        self.playback_tx
            .send(PlaybackCommand::StartStream(backend_rx))
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))?;

        Ok(user_tx)
    }

    /// Clear the playback buffer immediately.
    pub fn clear_playback(&self) -> Result<(), AecError> {
        self.playback_tx
            .send(PlaybackCommand::ClearBuffer)
            .map_err(|_| AecError::BackendError("playback channel closed".to_string()))
    }
}

/// Capture-only backend handle. RAII — dropping stops capture and releases
/// the OS microphone (indicator goes away).
pub(crate) struct CaptureBackendHandle {
    _handle: Box<dyn std::any::Any + Send>,
}

/// Create a capture-only backend (no AEC, no playback).
/// Returns (native_sample_rate, buffer_size, handle).
pub(crate) fn create_capture_backend(
    sender: flume::Sender<Vec<f32>>,
) -> Result<(u32, usize, CaptureBackendHandle), AecError> {
    #[cfg(target_os = "macos")]
    {
        let (rate, size, handle) = macos::create_capture_only(sender)?;
        Ok((rate, size, CaptureBackendHandle { _handle: handle }))
    }

    #[cfg(target_os = "linux")]
    {
        let (rate, size, handle) = linux::create_capture_only(sender)?;
        Ok((rate, size, CaptureBackendHandle { _handle: handle }))
    }

    #[cfg(target_os = "windows")]
    {
        let (rate, size, handle) = windows::create_capture_only(sender)?;
        Ok((rate, size, CaptureBackendHandle { _handle: handle }))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = sender;
        Err(AecError::AecNotSupported)
    }
}

/// Create a playback-only backend (no capture, no AEC).
/// Returns (native_sample_rate, handle). The handle owns the send side of
/// the playback command channel; the platform backend owns the receive side.
pub(crate) fn create_playback_backend() -> Result<(u32, PlaybackBackendHandle), AecError> {
    let (playback_tx, playback_rx) = flume::bounded::<PlaybackCommand>(16);

    #[cfg(target_os = "macos")]
    let native_rate = macos::create_playback_only(playback_rx)?;

    #[cfg(target_os = "linux")]
    let native_rate = linux::create_playback_only(playback_rx)?;

    #[cfg(target_os = "windows")]
    let native_rate = windows::create_playback_only(playback_rx)?;

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = playback_rx;
        return Err(AecError::AecNotSupported);
    }

    let handle = PlaybackBackendHandle {
        playback_tx,
        native_sample_rate: native_rate,
        resampler: std::sync::Arc::new(Mutex::new(None)),
        resampler_source_rate: std::sync::Arc::new(Mutex::new(0)),
    };

    Ok((native_rate, handle))
}
