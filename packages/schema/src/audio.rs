//! Audio events: audio.chunk, audio.level

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Kind of audio content being played.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioKind {
    Speech,
    Sfx,
}

/// PCM audio data chunk.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pub track_id: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// Base64-encoded PCM data.
    pub data: String,
    pub duration_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<AudioKind>,
    // Orchestrator stamp fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Audio level metrics for a track.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    pub track_id: String,
    pub rms: f64,
    pub peak: f64,
    pub dbfs: f64,
    // Orchestrator stamp fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_chunk_roundtrip() {
        let event = AudioChunk {
            track_id: "mic-0".into(),
            format: "s16le".into(),
            sample_rate: 16000,
            channels: 1,
            data: "AAAA".into(),
            duration_ms: 20,
            kind: Some(AudioKind::Speech),
            ts: Some(1234567890),
            from: Some("mic".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"trackId\""));
        assert!(json.contains("\"sampleRate\":16000"));
        assert!(json.contains("\"durationMs\":20"));
        assert!(json.contains("\"_from\""));
        assert!(!json.contains("\"track_id\""));
        // Verify no decimal points on integer fields
        assert!(!json.contains("16000.0"));
        assert!(!json.contains("20.0"));
        let back: AudioChunk = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn audio_chunk_kind_optional() {
        let json = r#"{"trackId":"t","format":"s16le","sampleRate":16000,"channels":1,"data":"AA","durationMs":10}"#;
        let event: AudioChunk = serde_json::from_str(json).unwrap();
        assert_eq!(event.kind, None);
        assert_eq!(event.ts, None);
        assert_eq!(event.from, None);
    }

    #[test]
    fn audio_level_roundtrip() {
        let event = AudioLevel {
            track_id: "mic-0".into(),
            rms: 0.5,
            peak: 0.8,
            dbfs: -24.0,
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"trackId\""));
        assert!(!json.contains("\"ts\""));
        assert!(!json.contains("\"_from\""));
        let back: AudioLevel = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn audio_chunk_wire_compat_with_ts() {
        // Verify we can parse JSON as TS nodes produce it (integer numbers, no decimals)
        let ts_json = r#"{"trackId":"mic","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAA","durationMs":100}"#;
        let event: AudioChunk = serde_json::from_str(ts_json).unwrap();
        assert_eq!(event.sample_rate, 16000);
        assert_eq!(event.duration_ms, 100);
        // Re-serialize and verify identical wire format
        let rust_json = serde_json::to_string(&event).unwrap();
        let reparsed: serde_json::Value = serde_json::from_str(&rust_json).unwrap();
        let original: serde_json::Value = serde_json::from_str(ts_json).unwrap();
        assert_eq!(reparsed, original);
    }
}
