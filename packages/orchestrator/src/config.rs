//! YAML config loader and validator for acpfx pipeline configs.
//!
//! Config format:
//! ```yaml
//! nodes:
//!   <name>:
//!     use: "@acpfx/<impl>"
//!     settings: { ... }
//!     outputs:
//!       - <name>                                    # unconditional
//!       - node: <name>                              # conditional
//!         whenFieldEquals: { field: "value", ... }
//! env:
//!   KEY: value
//! ```

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// An output edge — either a plain node name or a filtered edge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OutputEdge {
    /// Plain string: `"stt"` — unconditional
    Simple(String),
    /// Filtered: `{ node: "tts", whenFieldEquals: { responseMode: "voice" } }`
    Filtered {
        node: String,
        #[serde(default, rename = "whenFieldEquals")]
        when_field_equals: Option<BTreeMap<String, serde_json::Value>>,
    },
}

impl OutputEdge {
    /// Get the destination node name.
    pub fn node_name(&self) -> &str {
        match self {
            OutputEdge::Simple(name) => name,
            OutputEdge::Filtered { node, .. } => node,
        }
    }

    /// Check if an event matches this edge's filter conditions.
    /// Returns true if no filter is set (unconditional).
    pub fn matches(&self, event: &serde_json::Value) -> bool {
        match self {
            OutputEdge::Simple(_) => true,
            OutputEdge::Filtered {
                when_field_equals, ..
            } => {
                let Some(filter) = when_field_equals else {
                    return true;
                };
                if filter.is_empty() {
                    return true;
                }
                for (key, expected) in filter {
                    match event.get(key) {
                        Some(actual) if actual == expected => {}
                        _ => return false,
                    }
                }
                true
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    #[serde(rename = "use")]
    pub use_: String,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    pub outputs: Vec<OutputEdge>,
}

impl NodeConfig {
    /// Extract destination node names from outputs (for validation / DAG building).
    pub fn output_node_names(&self) -> Vec<String> {
        self.outputs.iter().map(|e| e.node_name().to_string()).collect()
    }

    /// Check if any output edge targets the given node name.
    pub fn outputs_to(&self, name: &str) -> bool {
        self.outputs.iter().any(|e| e.node_name() == name)
    }

    /// Add an unconditional output edge (Simple) if not already present.
    pub fn add_simple_output(&mut self, name: String) {
        if !self.outputs_to(&name) {
            self.outputs.push(OutputEdge::Simple(name));
        }
    }

    /// Remove all output edges targeting the given node name.
    pub fn remove_output(&mut self, name: &str) {
        self.outputs.retain(|e| e.node_name() != name);
    }
}

impl OutputEdge {
    /// Rename the destination node. Used by onboard when renaming nodes.
    pub fn rename_dest(&mut self, from: &str, to: &str) {
        match self {
            OutputEdge::Simple(ref mut name) if name == from => *name = to.to_string(),
            OutputEdge::Filtered { ref mut node, .. } if node == from => *node = to.to_string(),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    /// Nodes in YAML declaration order (IndexMap preserves insertion order).
    pub nodes: IndexMap<String, NodeConfig>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("Validation error: {0}")]
    Validation(String),
}

/// Load and validate a YAML config file.
pub fn load_config(path: &Path) -> Result<PipelineConfig, ConfigError> {
    let raw = std::fs::read_to_string(path)?;
    parse_config(&raw)
}

/// Parse and validate a YAML string.
pub fn parse_config(yaml: &str) -> Result<PipelineConfig, ConfigError> {
    let config: PipelineConfig = serde_yaml::from_str(yaml)?;
    validate_config(&config)?;
    Ok(config)
}

fn validate_config(config: &PipelineConfig) -> Result<(), ConfigError> {
    if config.nodes.is_empty() {
        return Err(ConfigError::Validation(
            "Config must have at least one node".into(),
        ));
    }

    for (name, node) in &config.nodes {
        if node.use_.is_empty() {
            return Err(ConfigError::Validation(format!(
                "Node '{name}' must have a 'use' string"
            )));
        }
        for edge in &node.outputs {
            let out = edge.node_name();
            if !config.nodes.contains_key(out) {
                return Err(ConfigError::Validation(format!(
                    "Node '{name}' outputs to undefined node '{out}'"
                )));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_config() {
        let yaml = r#"
nodes:
  mic:
    use: "@acpfx/mic-speaker"
    settings: {sampleRate: 16000}
    outputs: [stt]
  stt:
    use: "@acpfx/stt-deepgram"
    outputs: []
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.nodes.len(), 2);
        assert_eq!(config.nodes["mic"].use_, "@acpfx/mic-speaker");
        assert_eq!(config.nodes["mic"].output_node_names(), vec!["stt"]);
    }

    #[test]
    fn rejects_undefined_output() {
        let yaml = r#"
nodes:
  mic:
    use: "@acpfx/mic-speaker"
    outputs: [nonexistent]
"#;
        let err = parse_config(yaml).unwrap_err();
        assert!(err.to_string().contains("undefined node"));
    }

    #[test]
    fn rejects_empty_nodes() {
        let yaml = "nodes: {}";
        let err = parse_config(yaml).unwrap_err();
        assert!(err.to_string().contains("at least one node"));
    }

    #[test]
    fn parse_filtered_output() {
        let yaml = r#"
nodes:
  bridge:
    use: "@acpfx/bridge"
    outputs:
      - node: tts
        whenFieldEquals: { responseMode: "voice" }
  tts:
    use: "@acpfx/tts"
    outputs: []
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.nodes["bridge"].output_node_names(), vec!["tts"]);
        let edge = &config.nodes["bridge"].outputs[0];
        assert!(matches!(edge, OutputEdge::Filtered { .. }));
    }

    #[test]
    fn parse_mixed_plain_and_filtered() {
        let yaml = r#"
nodes:
  bridge:
    use: "@acpfx/bridge"
    outputs:
      - stt
      - node: tts
        whenFieldEquals: { responseMode: "voice" }
      - node: phone
        whenFieldEquals: { responseMode: "text" }
  stt:
    use: echo
    outputs: []
  tts:
    use: echo
    outputs: []
  phone:
    use: echo
    outputs: []
"#;
        let config = parse_config(yaml).unwrap();
        let names = config.nodes["bridge"].output_node_names();
        assert_eq!(names, vec!["stt", "tts", "phone"]);
        assert!(matches!(&config.nodes["bridge"].outputs[0], OutputEdge::Simple(s) if s == "stt"));
        assert!(matches!(&config.nodes["bridge"].outputs[1], OutputEdge::Filtered { .. }));
    }

    #[test]
    fn rejects_filtered_to_undefined_node() {
        let yaml = r#"
nodes:
  bridge:
    use: "@acpfx/bridge"
    outputs:
      - node: nonexistent
        whenFieldEquals: { responseMode: "voice" }
"#;
        let err = parse_config(yaml).unwrap_err();
        assert!(err.to_string().contains("undefined node"));
    }

    #[test]
    fn output_edge_matches_simple() {
        let edge = OutputEdge::Simple("tts".into());
        let event = serde_json::json!({"type": "agent.delta", "responseMode": "text"});
        assert!(edge.matches(&event)); // simple always matches
    }

    #[test]
    fn output_edge_matches_field_equals() {
        let mut filter = BTreeMap::new();
        filter.insert("responseMode".into(), serde_json::json!("voice"));
        let edge = OutputEdge::Filtered {
            node: "tts".into(),
            when_field_equals: Some(filter),
        };

        let voice_event = serde_json::json!({"type": "agent.delta", "responseMode": "voice"});
        assert!(edge.matches(&voice_event));

        let text_event = serde_json::json!({"type": "agent.delta", "responseMode": "text"});
        assert!(!edge.matches(&text_event));

        let no_mode = serde_json::json!({"type": "agent.delta"});
        assert!(!edge.matches(&no_mode));
    }

    #[test]
    fn output_edge_empty_filter_matches_all() {
        let edge = OutputEdge::Filtered {
            node: "tts".into(),
            when_field_equals: Some(BTreeMap::new()),
        };
        let event = serde_json::json!({"type": "agent.delta"});
        assert!(edge.matches(&event));
    }

    #[test]
    fn output_edge_multiple_fields_all_must_match() {
        let mut filter = BTreeMap::new();
        filter.insert("responseMode".into(), serde_json::json!("voice"));
        filter.insert("priority".into(), serde_json::json!("high"));
        let edge = OutputEdge::Filtered {
            node: "tts".into(),
            when_field_equals: Some(filter),
        };

        let both = serde_json::json!({"responseMode": "voice", "priority": "high"});
        assert!(edge.matches(&both));

        let one = serde_json::json!({"responseMode": "voice", "priority": "low"});
        assert!(!edge.matches(&one));
    }
}
