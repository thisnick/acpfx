//! acpfx-schema: Canonical event type definitions for acpfx pipelines.
//!
//! This crate is the single source of truth for the NDJSON event protocol.
//! TypeScript types are generated from these Rust definitions via codegen.

pub mod agent;
pub mod audio;
pub mod categories;
pub mod control;
pub mod envelope;
pub mod lifecycle;
pub mod log;
pub mod player;
pub mod speech;

// Re-export all event structs at crate root for convenience.
pub use agent::*;
pub use audio::*;
pub use categories::{category_of, is_known_event_type, types_in_category, Category};
pub use control::*;
pub use envelope::OrchestratorStamp;
pub use lifecycle::*;
pub use log::*;
pub use player::*;
pub use speech::*;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Top-level event enum, discriminated by the `type` field.
///
/// Serializes to JSON with `{"type": "audio.chunk", ...}` format.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    // Audio
    #[serde(rename = "audio.chunk")]
    AudioChunk(AudioChunk),
    #[serde(rename = "audio.level")]
    AudioLevel(AudioLevel),

    // Speech
    #[serde(rename = "speech.partial")]
    SpeechPartial(SpeechPartial),
    #[serde(rename = "speech.delta")]
    SpeechDelta(SpeechDelta),
    #[serde(rename = "speech.final")]
    SpeechFinal(SpeechFinal),
    #[serde(rename = "speech.pause")]
    SpeechPause(SpeechPause),

    // Agent
    #[serde(rename = "agent.submit")]
    AgentSubmit(AgentSubmit),
    #[serde(rename = "agent.delta")]
    AgentDelta(AgentDelta),
    #[serde(rename = "agent.complete")]
    AgentComplete(AgentComplete),
    #[serde(rename = "agent.thinking")]
    AgentThinking(AgentThinking),
    #[serde(rename = "agent.tool_start")]
    AgentToolStart(AgentToolStart),
    #[serde(rename = "agent.tool_done")]
    AgentToolDone(AgentToolDone),

    // Control
    #[serde(rename = "control.interrupt")]
    ControlInterrupt(ControlInterrupt),
    #[serde(rename = "control.state")]
    ControlState(ControlState),
    #[serde(rename = "control.error")]
    ControlError(ControlError),

    // Lifecycle
    #[serde(rename = "lifecycle.ready")]
    LifecycleReady(LifecycleReady),
    #[serde(rename = "lifecycle.done")]
    LifecycleDone(LifecycleDone),

    // Log
    #[serde(rename = "log")]
    Log(Log),

    // Player
    #[serde(rename = "player.status")]
    PlayerStatus(PlayerStatus),
}

impl Event {
    /// Get the event type string (e.g., "audio.chunk").
    pub fn event_type(&self) -> &'static str {
        match self {
            Event::AudioChunk(_) => "audio.chunk",
            Event::AudioLevel(_) => "audio.level",
            Event::SpeechPartial(_) => "speech.partial",
            Event::SpeechDelta(_) => "speech.delta",
            Event::SpeechFinal(_) => "speech.final",
            Event::SpeechPause(_) => "speech.pause",
            Event::AgentSubmit(_) => "agent.submit",
            Event::AgentDelta(_) => "agent.delta",
            Event::AgentComplete(_) => "agent.complete",
            Event::AgentThinking(_) => "agent.thinking",
            Event::AgentToolStart(_) => "agent.tool_start",
            Event::AgentToolDone(_) => "agent.tool_done",
            Event::ControlInterrupt(_) => "control.interrupt",
            Event::ControlState(_) => "control.state",
            Event::ControlError(_) => "control.error",
            Event::LifecycleReady(_) => "lifecycle.ready",
            Event::LifecycleDone(_) => "lifecycle.done",
            Event::Log(_) => "log",
            Event::PlayerStatus(_) => "player.status",
        }
    }

    /// Get the category of this event.
    pub fn category(&self) -> Category {
        // Safe to unwrap: all enum variants are known types.
        category_of(self.event_type()).unwrap()
    }
}

/// Parse an NDJSON line into an Event.
pub fn parse_event(json: &str) -> Result<Event, serde_json::Error> {
    serde_json::from_str(json)
}

/// Serialize an Event to an NDJSON line (no trailing newline).
pub fn serialize_event(event: &Event) -> Result<String, serde_json::Error> {
    serde_json::to_string(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_enum_audio_chunk_roundtrip() {
        let event = Event::AudioChunk(AudioChunk {
            track_id: "mic-0".into(),
            format: "s16le".into(),
            sample_rate: 16000,
            channels: 1,
            data: "AAAA".into(),
            duration_ms: 20,
            kind: None,
            ts: Some(100),
            from: Some("mic".into()),
        });
        let json = serialize_event(&event).unwrap();
        assert!(json.contains(r#""type":"audio.chunk""#));
        assert!(json.contains(r#""trackId":"mic-0""#));
        let back = parse_event(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn event_enum_speech_final_roundtrip() {
        let event = Event::SpeechFinal(SpeechFinal {
            track_id: "mic-0".into(),
            text: "hello world".into(),
            confidence: Some(0.95),
            ts: None,
            from: None,
        });
        let json = serialize_event(&event).unwrap();
        assert!(json.contains(r#""type":"speech.final""#));
        let back = parse_event(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn event_enum_agent_complete_with_token_usage() {
        let json = r#"{"type":"agent.complete","requestId":"r1","text":"done","tokenUsage":{"input":100,"output":50}}"#;
        let event = parse_event(json).unwrap();
        match &event {
            Event::AgentComplete(ac) => {
                assert_eq!(ac.request_id, "r1");
                assert_eq!(ac.token_usage.as_ref().unwrap().input, 100);
            }
            _ => panic!("expected AgentComplete"),
        }
        assert_eq!(event.event_type(), "agent.complete");
        assert_eq!(event.category(), Category::Agent);
    }

    #[test]
    fn event_enum_control_interrupt() {
        let json = r#"{"type":"control.interrupt","reason":"barge-in","ts":12345,"_from":"bridge"}"#;
        let event = parse_event(json).unwrap();
        match &event {
            Event::ControlInterrupt(ci) => {
                assert_eq!(ci.reason, "barge-in");
                assert_eq!(ci.ts, Some(12345));
                assert_eq!(ci.from.as_deref(), Some("bridge"));
            }
            _ => panic!("expected ControlInterrupt"),
        }
    }

    #[test]
    fn event_enum_log() {
        let json = r#"{"type":"log","level":"warn","component":"tts","message":"reconnecting"}"#;
        let event = parse_event(json).unwrap();
        assert_eq!(event.event_type(), "log");
        assert_eq!(event.category(), Category::Log);
    }

    #[test]
    fn event_enum_player_status() {
        let json = r#"{"type":"player.status","playing":"speech","agentState":"responding","sfxActive":true}"#;
        let event = parse_event(json).unwrap();
        assert_eq!(event.event_type(), "player.status");
        assert_eq!(event.category(), Category::Player);
    }

    #[test]
    fn event_enum_lifecycle_ready() {
        let json = r#"{"type":"lifecycle.ready","component":"stt-deepgram"}"#;
        let event = parse_event(json).unwrap();
        assert_eq!(event.event_type(), "lifecycle.ready");
        assert_eq!(event.category(), Category::Lifecycle);
    }

    #[test]
    fn event_type_tag_in_json() {
        // Verify that the type tag appears correctly for every variant
        let events = vec![
            Event::AudioChunk(AudioChunk {
                track_id: "t".into(), format: "f".into(), sample_rate: 16000,
                channels: 1, data: "d".into(), duration_ms: 10,
                kind: None, ts: None, from: None,
            }),
            Event::AudioLevel(AudioLevel {
                track_id: "t".into(), rms: 0.0, peak: 0.0, dbfs: 0.0,
                ts: None, from: None,
            }),
            Event::SpeechPartial(SpeechPartial {
                track_id: "t".into(), text: "".into(), ts: None, from: None,
            }),
            Event::SpeechDelta(SpeechDelta {
                track_id: "t".into(), text: "".into(), replaces: None,
                ts: None, from: None,
            }),
            Event::SpeechFinal(SpeechFinal {
                track_id: "t".into(), text: "".into(), confidence: None,
                ts: None, from: None,
            }),
            Event::SpeechPause(SpeechPause {
                track_id: "t".into(), pending_text: "".into(), silence_ms: 0,
                ts: None, from: None,
            }),
            Event::AgentSubmit(AgentSubmit {
                request_id: "r".into(), text: "".into(), ts: None, from: None,
            }),
            Event::AgentDelta(AgentDelta {
                request_id: "r".into(), delta: "".into(), seq: 0,
                ts: None, from: None,
            }),
            Event::AgentComplete(AgentComplete {
                request_id: "r".into(), text: "".into(), token_usage: None,
                ts: None, from: None,
            }),
            Event::AgentThinking(AgentThinking {
                request_id: "r".into(), ts: None, from: None,
            }),
            Event::AgentToolStart(AgentToolStart {
                request_id: "r".into(), tool_call_id: "tc".into(), title: None,
                ts: None, from: None,
            }),
            Event::AgentToolDone(AgentToolDone {
                request_id: "r".into(), tool_call_id: "tc".into(), status: "ok".into(),
                ts: None, from: None,
            }),
            Event::ControlInterrupt(ControlInterrupt {
                reason: "r".into(), ts: None, from: None,
            }),
            Event::ControlState(ControlState {
                component: "c".into(), state: "s".into(), ts: None, from: None,
            }),
            Event::ControlError(ControlError {
                component: "c".into(), message: "m".into(), fatal: false,
                ts: None, from: None,
            }),
            Event::LifecycleReady(LifecycleReady {
                component: "c".into(), ts: None, from: None,
            }),
            Event::LifecycleDone(LifecycleDone {
                component: "c".into(), ts: None, from: None,
            }),
            Event::Log(Log {
                level: log::LogLevel::Info, component: "c".into(), message: "m".into(),
                ts: None, from: None,
            }),
            Event::PlayerStatus(PlayerStatus {
                playing: serde_json::Value::Bool(false),
                agent_state: serde_json::Value::Null,
                sfx_active: false, ts: None, from: None,
            }),
        ];

        for event in &events {
            let json = serialize_event(event).unwrap();
            let expected_type = event.event_type();
            let type_str = format!(r#""type":"{}""#, expected_type);
            assert!(
                json.contains(&type_str),
                "Event {:?} serialized to {} but expected type tag '{}'",
                expected_type, json, type_str,
            );
            // Round-trip
            let back = parse_event(&json).unwrap();
            assert_eq!(*event, back, "Round-trip failed for {}", expected_type);
        }
    }

    #[test]
    fn unknown_event_type_fails() {
        let json = r#"{"type":"foo.bar","data":"test"}"#;
        assert!(parse_event(json).is_err());
    }

    #[test]
    fn all_event_types_covered_by_enum() {
        // Verify ALL_EVENT_TYPES matches the enum variants
        for ty in categories::ALL_EVENT_TYPES {
            assert!(
                is_known_event_type(ty),
                "ALL_EVENT_TYPES contains '{}' but is_known_event_type returns false",
                ty
            );
        }
        assert_eq!(categories::ALL_EVENT_TYPES.len(), 19);
    }
}
