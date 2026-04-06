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

    // ---- Evaluator Phase 1: node.status stress tests ----

    #[test]
    fn node_status_with_all_fields() {
        let event = NodeStatus {
            text: "Muted (hold Space)".into(),
            ts: Some(999),
            from: Some("mic".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"_from\":\"mic\""));
        assert!(json.contains("\"ts\":999"));
        let back: NodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn node_status_empty_text() {
        let event = NodeStatus {
            text: "".into(),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: NodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn node_status_unicode_text() {
        let event = NodeStatus {
            text: "\u{25B6} speech \u{266B}".into(),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: NodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(event.text, back.text);
    }

    #[test]
    fn node_status_via_event_enum() {
        // Verify node.status parses through the top-level Event enum
        let json = r#"{"type":"node.status","text":"Listening","ts":42,"_from":"mic"}"#;
        let event: crate::Event = serde_json::from_str(json).unwrap();
        assert_eq!(event.event_type(), "node.status");
        match event {
            crate::Event::NodeStatus(ns) => {
                assert_eq!(ns.text, "Listening");
                assert_eq!(ns.ts, Some(42));
                assert_eq!(ns.from.as_deref(), Some("mic"));
            }
            _ => panic!("expected NodeStatus variant"),
        }
    }
}
