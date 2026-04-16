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

/// The type of a UI control declared in a manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlType {
    Toggle,
}

/// The event payload for a UI control action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlEventSpec {
    /// The event type to send (e.g., "custom.mute").
    #[serde(rename = "type")]
    pub type_: String,
    /// The field name for the value (e.g., "muted").
    pub field: String,
}

/// A single UI control declared in a manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestControl {
    /// Unique control identifier within this node.
    pub id: String,
    /// The control type.
    #[serde(rename = "type")]
    pub type_: ControlType,
    /// Display label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// If true, the control is hold-to-activate (vs press-to-toggle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<bool>,
    /// Global keybind (e.g., "space").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybind: Option<String>,
    /// The event to send when the control is toggled.
    pub event: ControlEventSpec,
}

/// UI section of a manifest: declares controls the orchestrator renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestUi {
    /// Controls declared by this node.
    #[serde(default)]
    pub controls: Vec<ManifestControl>,
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
    /// what's declared. Supports nodes like bridge-acp that pass through
    /// args to external systems.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_arguments: Option<bool>,

    /// Environment variable declarations.
    #[serde(default)]
    pub env: BTreeMap<String, ManifestEnvField>,

    /// UI controls declared by this node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<ManifestUi>,
}

impl NodeManifest {
    /// Whether additional (undeclared) arguments are allowed.
    pub fn allows_additional_arguments(&self) -> bool {
        self.additional_arguments.unwrap_or(false)
    }
}

// ---- acpfx flag protocol types ----
// These are the structured payloads for --acpfx-* convention flags.

/// Response from `--acpfx-setup-check`.
///
/// Nodes emit this as a single JSON line on stdout to indicate whether
/// first-time setup (e.g., model download) is needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupCheckResponse {
    pub needed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Progress line from `--acpfx-setup` (NDJSON on stdout).
///
/// Nodes emit one of these per line during setup. The orchestrator
/// parses them for progress display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SetupProgress {
    Progress {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pct: Option<u8>,
    },
    Complete {
        message: String,
    },
    Error {
        message: String,
    },
}

/// Response for unrecognized `--acpfx-*` flags (forward compatibility).
///
/// Nodes that receive an `--acpfx-*` flag they don't understand should
/// emit this and exit 0, rather than failing or ignoring the flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsupportedFlagResponse {
    pub unsupported: bool,
    pub flag: String,
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
name: bridge-acp
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

    // ---- Evaluator tests: edge cases and negative cases ----

    #[test]
    fn reject_invalid_argument_type() {
        let yaml = r#"
name: bad-node
consumes: []
emits: []
arguments:
  foo:
    type: object
    description: "invalid type"
"#;
        let result: Result<NodeManifest, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err(), "Should reject unknown argument type 'object'");
    }

    #[test]
    fn reject_missing_name() {
        let yaml = r#"
consumes: []
emits: []
"#;
        let result: Result<NodeManifest, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err(), "Should reject manifest without 'name' field");
    }

    #[test]
    fn reject_missing_argument_type() {
        let yaml = r#"
name: bad-node
consumes: []
emits: []
arguments:
  foo:
    description: "no type specified"
"#;
        let result: Result<NodeManifest, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err(), "Should reject argument without 'type' field");
    }

    #[test]
    fn boolean_argument_with_default() {
        let yaml = r#"
name: test-node
consumes: []
emits: []
arguments:
  verbose:
    type: boolean
    default: true
    description: "Enable verbose output"
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let verbose = &manifest.arguments["verbose"];
        assert_eq!(verbose.type_, ArgumentType::Boolean);
        assert_eq!(verbose.default, Some(serde_json::Value::Bool(true)));
    }

    #[test]
    fn env_field_defaults_to_not_required() {
        let yaml = r#"
name: test-node
consumes: []
emits: []
env:
  OPTIONAL_KEY:
    description: "An optional key"
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let key = &manifest.env["OPTIONAL_KEY"];
        assert!(!key.is_required());
        assert_eq!(key.required, None);
    }

    #[test]
    fn additional_arguments_defaults_to_false() {
        let yaml = r#"
name: test-node
consumes: []
emits: []
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        assert!(!manifest.allows_additional_arguments());
        assert_eq!(manifest.additional_arguments, None);
    }

    // ---- Evaluator: parse all 12 real manifest.yaml files ----

    #[test]
    fn parse_all_node_manifests() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();

        let expected_nodes = [
            "node-stt-deepgram",
            "node-stt-elevenlabs",
            "node-stt-kyutai",
            "node-mic-file",
            "node-bridge-acp",
            "node-tts-deepgram",
            "node-tts-elevenlabs",
            "node-tts-kyutai",
            "node-tts-pocket",
            "node-audio-player",
            "node-recorder",
            "node-play-file",
            "node-echo",
            "node-mic-speaker",
        ];

        for node_dir_name in &expected_nodes {
            let manifest_path = manifest_dir
                .join("packages")
                .join(node_dir_name)
                .join("manifest.yaml");
            let content = std::fs::read_to_string(&manifest_path).unwrap_or_else(|e| {
                panic!("Failed to read {}: {}", manifest_path.display(), e)
            });
            let manifest: NodeManifest = serde_yaml::from_str(&content).unwrap_or_else(|e| {
                panic!("Failed to parse {}: {}", manifest_path.display(), e)
            });

            // Every manifest must have a name
            assert!(
                !manifest.name.is_empty(),
                "{} has empty name",
                node_dir_name
            );

            // Every manifest must emit lifecycle.ready
            assert!(
                manifest.emits.contains(&"lifecycle.ready".to_string()),
                "{} does not emit lifecycle.ready",
                node_dir_name
            );

            // Arguments with defaults must have matching types
            for (arg_name, arg) in &manifest.arguments {
                if let Some(ref default) = arg.default {
                    match arg.type_ {
                        ArgumentType::String => assert!(
                            default.is_string(),
                            "{}:{} default should be string, got {:?}",
                            node_dir_name, arg_name, default
                        ),
                        ArgumentType::Number => assert!(
                            default.is_number(),
                            "{}:{} default should be number, got {:?}",
                            node_dir_name, arg_name, default
                        ),
                        ArgumentType::Boolean => assert!(
                            default.is_boolean(),
                            "{}:{} default should be boolean, got {:?}",
                            node_dir_name, arg_name, default
                        ),
                    }
                }
            }

            // Env fields must have descriptions
            for (env_name, env_field) in &manifest.env {
                assert!(
                    env_field.description.is_some(),
                    "{}:{} env var missing description",
                    node_dir_name, env_name
                );
            }
        }
    }

    #[test]
    fn bridge_acp_has_required_agent() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let path = manifest_dir
            .join("packages/node-bridge-acp/manifest.yaml");
        let content = std::fs::read_to_string(&path).unwrap();
        let manifest: NodeManifest = serde_yaml::from_str(&content).unwrap();
        // agent should be required
        assert!(
            manifest.arguments["agent"].is_required(),
            "bridge-acp 'agent' argument should be required"
        );
    }

    #[test]
    fn required_path_arguments() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();

        for node_name in &["node-mic-file", "node-play-file"] {
            let path = manifest_dir
                .join("packages")
                .join(node_name)
                .join("manifest.yaml");
            let content = std::fs::read_to_string(&path).unwrap();
            let manifest: NodeManifest = serde_yaml::from_str(&content).unwrap();
            assert!(
                manifest.arguments["path"].is_required(),
                "{} 'path' argument should be required",
                node_name
            );
        }
    }

    #[test]
    fn api_key_env_vars_declared() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();

        let expected = [
            ("node-stt-deepgram", "DEEPGRAM_API_KEY"),
            ("node-tts-deepgram", "DEEPGRAM_API_KEY"),
            ("node-stt-elevenlabs", "ELEVENLABS_API_KEY"),
            ("node-tts-elevenlabs", "ELEVENLABS_API_KEY"),
        ];

        for (node_name, env_var) in &expected {
            let path = manifest_dir
                .join("packages")
                .join(node_name)
                .join("manifest.yaml");
            let content = std::fs::read_to_string(&path).unwrap();
            let manifest: NodeManifest = serde_yaml::from_str(&content).unwrap();
            assert!(
                manifest.env.contains_key(*env_var),
                "{} should declare env var {}",
                node_name, env_var
            );
            assert!(
                manifest.env[*env_var].is_required(),
                "{}:{} should be required",
                node_name, env_var
            );
        }
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
            ui: None,
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

    #[test]
    fn deserialize_manifest_with_ui_controls() {
        let yaml = r#"
name: mic-speaker
consumes:
  - audio.chunk
  - custom.mute
emits:
  - audio.chunk
  - audio.level
  - node.status
  - lifecycle.ready
  - lifecycle.done
ui:
  controls:
    - id: mute
      type: toggle
      label: "Mute"
      hold: true
      keybind: space
      event:
        type: custom.mute
        field: muted
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let ui = manifest.ui.as_ref().unwrap();
        assert_eq!(ui.controls.len(), 1);
        let ctrl = &ui.controls[0];
        assert_eq!(ctrl.id, "mute");
        assert_eq!(ctrl.type_, ControlType::Toggle);
        assert_eq!(ctrl.label.as_deref(), Some("Mute"));
        assert_eq!(ctrl.hold, Some(true));
        assert_eq!(ctrl.keybind.as_deref(), Some("space"));
        assert_eq!(ctrl.event.type_, "custom.mute");
        assert_eq!(ctrl.event.field, "muted");
    }

    #[test]
    fn manifest_without_ui_field() {
        let yaml = r#"
name: echo
consumes: []
emits:
  - lifecycle.ready
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        assert!(manifest.ui.is_none());
    }

    // ---- Evaluator Phase 1: ManifestUi stress tests ----

    #[test]
    fn manifest_ui_roundtrip_json() {
        let manifest = NodeManifest {
            name: "test-mic".into(),
            description: None,
            consumes: vec!["custom.mute".into()],
            emits: vec!["node.status".into(), "lifecycle.ready".into()],
            arguments: BTreeMap::new(),
            additional_arguments: None,
            env: BTreeMap::new(),
            ui: Some(ManifestUi {
                controls: vec![ManifestControl {
                    id: "mute".into(),
                    type_: ControlType::Toggle,
                    label: Some("Mute".into()),
                    hold: Some(true),
                    keybind: Some("space".into()),
                    event: ControlEventSpec {
                        type_: "custom.mute".into(),
                        field: "muted".into(),
                    },
                }],
            }),
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let back: NodeManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, back);
    }

    #[test]
    fn manifest_ui_roundtrip_yaml() {
        let manifest = NodeManifest {
            name: "test-mic".into(),
            description: None,
            consumes: vec![],
            emits: vec!["lifecycle.ready".into()],
            arguments: BTreeMap::new(),
            additional_arguments: None,
            env: BTreeMap::new(),
            ui: Some(ManifestUi {
                controls: vec![ManifestControl {
                    id: "mute".into(),
                    type_: ControlType::Toggle,
                    label: None,
                    hold: None,
                    keybind: None,
                    event: ControlEventSpec {
                        type_: "custom.mute".into(),
                        field: "muted".into(),
                    },
                }],
            }),
        };
        let yaml = serde_yaml::to_string(&manifest).unwrap();
        let back: NodeManifest = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(manifest, back);
    }

    #[test]
    fn manifest_ui_empty_controls_list() {
        let yaml = r#"
name: test
consumes: []
emits:
  - lifecycle.ready
ui:
  controls: []
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let ui = manifest.ui.unwrap();
        assert!(ui.controls.is_empty());
    }

    #[test]
    fn manifest_ui_multiple_controls() {
        let yaml = r#"
name: test
consumes: []
emits:
  - lifecycle.ready
ui:
  controls:
    - id: mute
      type: toggle
      keybind: space
      event:
        type: custom.mute
        field: muted
    - id: hold
      type: toggle
      label: "Hold"
      hold: true
      keybind: h
      event:
        type: custom.hold
        field: held
"#;
        let manifest: NodeManifest = serde_yaml::from_str(yaml).unwrap();
        let ui = manifest.ui.unwrap();
        assert_eq!(ui.controls.len(), 2);
        assert_eq!(ui.controls[0].id, "mute");
        assert_eq!(ui.controls[1].id, "hold");
        assert_eq!(ui.controls[1].keybind.as_deref(), Some("h"));
    }

    #[test]
    fn manifest_ui_reject_unknown_control_type() {
        let yaml = r#"
name: test
consumes: []
emits:
  - lifecycle.ready
ui:
  controls:
    - id: foo
      type: slider
      event:
        type: custom.foo
        field: val
"#;
        let result: Result<NodeManifest, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err(), "Should reject unknown control type 'slider'");
    }

    #[test]
    fn manifest_ui_control_missing_event() {
        let yaml = r#"
name: test
consumes: []
emits:
  - lifecycle.ready
ui:
  controls:
    - id: foo
      type: toggle
"#;
        let result: Result<NodeManifest, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err(), "Should reject control without 'event' field");
    }
}
