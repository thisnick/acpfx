//! Control events: control.interrupt, control.state, control.error

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Interrupt signal — stop current processing.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlInterrupt {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Node state change notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    pub component: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Error report from a node.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub component: String,
    pub message: String,
    pub fatal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_interrupt_roundtrip() {
        let event = ControlInterrupt {
            reason: "barge-in".into(),
            ts: Some(100),
            from: Some("bridge".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: ControlInterrupt = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn control_error_roundtrip() {
        let event = ControlError {
            component: "stt".into(),
            message: "connection lost".into(),
            fatal: false,
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"fatal\":false"));
        let back: ControlError = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }
}
