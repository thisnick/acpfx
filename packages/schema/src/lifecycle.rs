//! Lifecycle events: lifecycle.ready, lifecycle.done

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Node is ready to process events.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleReady {
    pub component: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Node has finished and is shutting down.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleDone {
    pub component: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_ready_roundtrip() {
        let event = LifecycleReady {
            component: "stt-deepgram".into(),
            ts: Some(100),
            from: Some("stt".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: LifecycleReady = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn lifecycle_done_roundtrip() {
        let event = LifecycleDone {
            component: "stt-deepgram".into(),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("\"ts\""));
        let back: LifecycleDone = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }
}
