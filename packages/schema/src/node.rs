//! Node events: node.status

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A display status string emitted by any node.
///
/// The orchestrator renders this in the status bar as `nodeName: text`.
/// Nodes that never emit `node.status` don't appear in the status bar.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// Human-readable status text (e.g., "Listening", "Muted").
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_status_roundtrip() {
        let event = NodeStatus {
            text: "Listening".into(),
            ts: Some(100),
            from: Some("mic".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"text\":\"Listening\""));
        let back: NodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn node_status_minimal() {
        let json = r#"{"text":"Idle"}"#;
        let event: NodeStatus = serde_json::from_str(json).unwrap();
        assert_eq!(event.text, "Idle");
        assert_eq!(event.ts, None);
        assert_eq!(event.from, None);
    }
}
