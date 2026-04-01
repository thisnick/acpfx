//! Log event: log

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Log level.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Debug,
}

/// Structured log event emitted by a node.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub level: LogLevel,
    pub component: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_roundtrip() {
        let event = Log {
            level: LogLevel::Info,
            component: "stt".into(),
            message: "connected".into(),
            ts: Some(100),
            from: Some("stt".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"level\":\"info\""));
        let back: Log = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn log_level_lowercase() {
        let event = Log {
            level: LogLevel::Error,
            component: "tts".into(),
            message: "failed".into(),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"error\""));
        assert!(!json.contains("\"Error\""));
    }
}
