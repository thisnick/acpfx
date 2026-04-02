//! Manifest schema types for acpfx node manifests.
//!
//! Defines the structure of `manifest.yaml` files, including the new
//! `arguments` and `env` sections for type-safe settings validation.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The type of a manifest argument value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgumentType {
    String,
    Number,
    Boolean,
}

/// A single argument declaration in a node manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestArgument {
    /// The value type (string, number, boolean).
    #[serde(rename = "type")]
    pub type_: ArgumentType,

    /// Default value for this argument.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,

    /// Human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Whether this argument is required (default: false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,

    /// Constrained set of allowed values.
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<serde_json::Value>>,
}

impl ManifestArgument {
    /// Whether this argument is required (defaults to false).
    pub fn is_required(&self) -> bool {
        self.required.unwrap_or(false)
    }
}

/// An environment variable declaration in a node manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEnvField {
    /// Whether this env var is required (default: false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,

    /// Human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl ManifestEnvField {
    /// Whether this env var is required (defaults to false).
    pub fn is_required(&self) -> bool {
        self.required.unwrap_or(false)
    }
}

/// A complete node manifest (`manifest.yaml`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeManifest {
    /// Node package short name (e.g., "stt-deepgram").
    pub name: String,

    /// Human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Event types this node consumes.
    #[serde(default)]
    pub consumes: Vec<String>,

    /// Event types this node emits.
    #[serde(default)]
    pub emits: Vec<String>,

    /// Typed argument declarations (maps to YAML config `settings:` block).
    #[serde(default)]
    pub arguments: BTreeMap<String, ManifestArgument>,

    /// When true, the node accepts arbitrary additional arguments beyond
    /// what's declared. Supports nodes like bridge-acpx that pass through
    /// args to external systems.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_arguments: Option<bool>,

    /// Environment variable declarations.
    #[serde(default)]
    pub env: BTreeMap<String, ManifestEnvField>,
}

impl NodeManifest {
    /// Whether additional (undeclared) arguments are allowed.
    pub fn allows_additional_arguments(&self) -> bool {
        self.additional_arguments.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_minimal_manifest() {
        let yaml = r#"
name: echo
consumes: []
emits:
  - lifecycle.ready
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(manifest.name, "echo");
        assert!(manifest.arguments.is_empty());
        assert!(manifest.env.is_empty());
        assert!(!manifest.allows_additional_arguments());
    }

    #[test]
    fn deserialize_full_manifest() {
        let yaml = r#"
name: stt-deepgram
description: "Speech-to-text via Deepgram streaming API"
consumes:
  - audio.chunk
emits:
  - speech.partial
  - speech.final
  - speech.pause
  - lifecycle.ready
  - lifecycle.done
  - control.error
arguments:
  language:
    type: string
    default: "en"
    description: "Language code for transcription"
  model:
    type: string
    default: "nova-3"
    description: "Deepgram model name"
  utteranceEndMs:
    type: number
    default: 1000
    description: "Milliseconds of silence before utterance end"
  endpointing:
    type: number
    default: 300
    description: "VAD endpointing threshold in ms"
env:
  DEEPGRAM_API_KEY:
    required: true
    description: "Deepgram API key for STT"
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(manifest.name, "stt-deepgram");
        assert_eq!(manifest.arguments.len(), 4);
        assert_eq!(manifest.env.len(), 1);

        let lang = &manifest.arguments["language"];
        assert_eq!(lang.type_, ArgumentType::String);
        assert_eq!(lang.default, Some(serde_json::Value::String("en".into())));
        assert!(!lang.is_required());

        let api_key = &manifest.env["DEEPGRAM_API_KEY"];
        assert!(api_key.is_required());
    }

    #[test]
    fn deserialize_additional_arguments() {
        let yaml = r#"
name: bridge-acpx
consumes: []
emits: []
additional_arguments: true
arguments:
  agent:
    type: string
    required: true
    description: "Agent to connect to"
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        assert!(manifest.allows_additional_arguments());
        assert!(manifest.arguments["agent"].is_required());
    }

    #[test]
    fn deserialize_enum_argument() {
        let yaml = r#"
name: test-node
consumes: []
emits: []
arguments:
  level:
    type: string
    enum: ["info", "warn", "error"]
    description: "Log level"
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let level = &manifest.arguments["level"];
        let enums = level.enum_values.as_ref().unwrap();
        assert_eq!(enums.len(), 3);
        assert_eq!(enums[0], serde_json::Value::String("info".into()));
    }

    #[test]
    fn roundtrip_serde() {
        let manifest = NodeManifest {
            name: "test".into(),
            description: Some("A test node".into()),
            consumes: vec!["audio.chunk".into()],
            emits: vec!["lifecycle.ready".into()],
            arguments: {
                let mut m = BTreeMap::new();
                m.insert(
                    "rate".into(),
                    ManifestArgument {
                        type_: ArgumentType::Number,
                        default: Some(serde_json::json!(16000)),
                        description: Some("Sample rate".into()),
                        required: None,
                        enum_values: None,
                    },
                );
                m
            },
            additional_arguments: Some(false),
            env: {
                let mut m = BTreeMap::new();
                m.insert(
                    "API_KEY".into(),
                    ManifestEnvField {
                        required: Some(true),
                        description: Some("API key".into()),
                    },
                );
                m
            },
        };

        // Roundtrip via JSON
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let back: NodeManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, back);

        // Roundtrip via YAML
        let yaml = serde_yaml::to_string(&manifest).unwrap();
        let back_yaml: NodeManifest = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(manifest, back_yaml);
    }
}
