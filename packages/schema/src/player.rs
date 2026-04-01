//! Player events: player.status

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Current playback status of the audio player.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    /// What kind of audio is currently playing (null/false if idle).
    pub playing: serde_json::Value,
    /// Current agent state as seen by the player.
    pub agent_state: serde_json::Value,
    /// Whether SFX is currently active.
    pub sfx_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_status_roundtrip() {
        let event = PlayerStatus {
            playing: serde_json::Value::String("speech".into()),
            agent_state: serde_json::Value::String("responding".into()),
            sfx_active: true,
            ts: Some(100),
            from: Some("player".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"agentState\""));
        assert!(json.contains("\"sfxActive\""));
        assert!(!json.contains("\"agent_state\""));
        let back: PlayerStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn player_status_playing_false() {
        let event = PlayerStatus {
            playing: serde_json::Value::Bool(false),
            agent_state: serde_json::Value::Null,
            sfx_active: false,
            ts: None,
            from: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"playing\":false"));
    }
}
