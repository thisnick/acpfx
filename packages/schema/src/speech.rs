//! Speech recognition events: speech.partial, speech.delta, speech.final, speech.pause

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Partial (in-progress) speech recognition result.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPartial {
    pub track_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Incremental speech delta (replaces previous partial).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDelta {
    pub track_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Final speech recognition result.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFinal {
    pub track_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Speech pause detection (silence after speech).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPause {
    pub track_id: String,
    pub pending_text: String,
    pub silence_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_partial_roundtrip() {
        let event = SpeechPartial {
            track_id: "mic-0".into(),
            text: "hello".into(),
            ts: Some(100),
            from: Some("stt".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"trackId\""));
        let back: SpeechPartial = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn speech_delta_replaces_optional() {
        let json = r#"{"trackId":"t","text":"hi"}"#;
        let event: SpeechDelta = serde_json::from_str(json).unwrap();
        assert_eq!(event.replaces, None);
    }

    #[test]
    fn speech_final_roundtrip() {
        let event = SpeechFinal {
            track_id: "mic-0".into(),
            text: "hello world".into(),
            confidence: Some(0.95),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"confidence\""));
        let back: SpeechFinal = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn speech_pause_camel_case() {
        let event = SpeechPause {
            track_id: "mic-0".into(),
            pending_text: "hello".into(),
            silence_ms: 500,
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"pendingText\""));
        assert!(json.contains("\"silenceMs\""));
        assert!(!json.contains("\"pending_text\""));
    }
}
