//! Agent/LLM events: agent.submit, agent.delta, agent.complete,
//! agent.thinking, agent.tool_start, agent.tool_done, agent.history

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Token usage statistics.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

/// Submit text to the agent for processing.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubmit {
    pub request_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Incremental agent response token.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDelta {
    pub request_id: String,
    pub delta: String,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Agent response complete.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentComplete {
    pub request_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Agent is thinking (before first token).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentThinking {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Agent started a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolStart {
    pub request_id: String,
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Agent tool call completed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDone {
    pub request_id: String,
    pub tool_call_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Replayed conversation history entry (from session resume).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistory {
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_submit_roundtrip() {
        let event = AgentSubmit {
            request_id: "req-1".into(),
            text: "hello".into(),
            ts: Some(100),
            from: Some("bridge".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"requestId\""));
        assert!(!json.contains("\"request_id\""));
        let back: AgentSubmit = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn agent_delta_roundtrip() {
        let event = AgentDelta {
            request_id: "req-1".into(),
            delta: "Hello".into(),
            seq: 0,
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: AgentDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn agent_complete_token_usage_optional() {
        let json = r#"{"requestId":"r","text":"done"}"#;
        let event: AgentComplete = serde_json::from_str(json).unwrap();
        assert_eq!(event.token_usage, None);
    }

    #[test]
    fn agent_complete_with_token_usage() {
        let event = AgentComplete {
            request_id: "r".into(),
            text: "done".into(),
            token_usage: Some(TokenUsage { input: 100, output: 50 }),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"tokenUsage\""));
        assert!(json.contains("\"input\":100"));
        let back: AgentComplete = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn agent_tool_start_camel_case() {
        let event = AgentToolStart {
            request_id: "r".into(),
            tool_call_id: "tc-1".into(),
            title: Some("read_file".into()),
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"toolCallId\""));
        assert!(!json.contains("\"tool_call_id\""));
    }
}
