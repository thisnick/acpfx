//! YAML config loader and validator for acpfx pipeline configs.
//!
//! Config format:
//! ```yaml
//! nodes:
//!   <name>:
//!     use: "@acpfx/<impl>"
//!     settings: { ... }
//!     outputs: [<name>, ...]
//! env:
//!   KEY: value
//! ```

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    #[serde(rename = "use")]
    pub use_: String,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    pub outputs: Vec<String>,
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
        for out in &node.outputs {
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
    use: "@acpfx/mic-sox"
    settings: {sampleRate: 16000}
    outputs: [stt]
  stt:
    use: "@acpfx/stt-deepgram"
    outputs: []
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.nodes.len(), 2);
        assert_eq!(config.nodes["mic"].use_, "@acpfx/mic-sox");
        assert_eq!(config.nodes["mic"].outputs, vec!["stt"]);
    }

    #[test]
    fn rejects_undefined_output() {
        let yaml = r#"
nodes:
  mic:
    use: "@acpfx/mic-sox"
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
}
