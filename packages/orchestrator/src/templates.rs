//! Embedded pipeline templates and node registry.
//!
//! Templates are baked into the binary at compile time via `include_str!()`.
//! Node manifests are similarly embedded for the onboarding TUI.

use acpfx_schema::manifest::NodeManifest;

/// A pipeline template with a human-readable name and embedded YAML content.
pub struct Template {
    /// Short identifier (e.g., "elevenlabs")
    pub id: &'static str,
    /// Human-readable display name
    pub label: &'static str,
    /// Raw YAML content
    pub yaml: &'static str,
}

/// All embedded pipeline templates.
const TEMPLATES: &[Template] = &[
    Template {
        id: "elevenlabs",
        label: "ElevenLabs (STT + TTS)",
        yaml: include_str!("../../../examples/pipeline/elevenlabs.yaml"),
    },
    Template {
        id: "deepgram",
        label: "Deepgram (STT + TTS)",
        yaml: include_str!("../../../examples/pipeline/deepgram.yaml"),
    },
    Template {
        id: "local",
        label: "Local (Kyutai STT + Pocket TTS, no API key)",
        yaml: include_str!("../../../examples/pipeline/local.yaml"),
    },
    Template {
        id: "local-gpu",
        label: "Local GPU (Kyutai STT + TTS, no API key)",
        yaml: include_str!("../../../examples/pipeline/local-gpu.yaml"),
    },
];

/// Get all templates.
pub fn list_templates() -> &'static [Template] {
    TEMPLATES
}

/// Get a template by ID.
#[allow(dead_code)]
pub fn get_template(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

/// Entry in the node registry: package name + parsed manifest.
pub struct NodeRegistryEntry {
    /// npm package name (e.g., "@acpfx/mic-speaker")
    pub package: &'static str,
    /// Parsed manifest
    pub manifest: NodeManifest,
}

/// Node registry entries with their raw YAML.
const NODE_REGISTRY_RAW: &[(&str, &str)] = &[
    ("@acpfx/mic-file", include_str!("../../../packages/node-mic-file/manifest.yaml")),
    ("@acpfx/mic-speaker", include_str!("../../../packages/node-mic-speaker/manifest.yaml")),
    ("@acpfx/stt-deepgram", include_str!("../../../packages/node-stt-deepgram/manifest.yaml")),
    ("@acpfx/stt-elevenlabs", include_str!("../../../packages/node-stt-elevenlabs/manifest.yaml")),
    ("@acpfx/bridge-acp", include_str!("../../../packages/node-bridge-acp/manifest.yaml")),
    ("@acpfx/tts-deepgram", include_str!("../../../packages/node-tts-deepgram/manifest.yaml")),
    ("@acpfx/tts-elevenlabs", include_str!("../../../packages/node-tts-elevenlabs/manifest.yaml")),
    ("@acpfx/audio-player", include_str!("../../../packages/node-audio-player/manifest.yaml")),
    ("@acpfx/recorder", include_str!("../../../packages/node-recorder/manifest.yaml")),
    ("@acpfx/play-file", include_str!("../../../packages/node-play-file/manifest.yaml")),
    ("@acpfx/echo", include_str!("../../../packages/node-echo/manifest.yaml")),
    ("@acpfx/stt-kyutai", include_str!("../../../packages/node-stt-kyutai/manifest.yaml")),
    ("@acpfx/tts-pocket", include_str!("../../../packages/node-tts-pocket/manifest.yaml")),
    ("@acpfx/tts-kyutai", include_str!("../../../packages/node-tts-kyutai/manifest.yaml")),
];

/// Parse and return all node registry entries.
pub fn available_nodes() -> Vec<NodeRegistryEntry> {
    NODE_REGISTRY_RAW
        .iter()
        .filter_map(|(package, yaml)| {
            let manifest: NodeManifest = serde_yaml::from_str(yaml).ok()?;
            Some(NodeRegistryEntry { package, manifest })
        })
        .collect()
}

/// Extract all required env vars from a set of manifests (deduplicated).
/// Returns (env_var_name, required, description, used_by_packages).
pub fn extract_env_vars(
    manifests: &[&NodeManifest],
) -> Vec<(String, bool, String, Vec<String>)> {
    use std::collections::BTreeMap;

    let mut env_map: BTreeMap<String, (bool, String, Vec<String>)> = BTreeMap::new();

    for manifest in manifests {
        for (name, field) in &manifest.env {
            let entry = env_map.entry(name.clone()).or_insert_with(|| {
                (
                    field.is_required(),
                    field.description.clone().unwrap_or_default(),
                    Vec::new(),
                )
            });
            // If any manifest says it's required, it's required
            if field.is_required() {
                entry.0 = true;
            }
            entry.2.push(manifest.name.clone());
        }
    }

    env_map
        .into_iter()
        .map(|(name, (required, desc, used_by))| (name, required, desc, used_by))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_templates_parse() {
        for template in list_templates() {
            let result: Result<crate::config::PipelineConfig, _> =
                serde_yaml::from_str(template.yaml);
            assert!(
                result.is_ok(),
                "Template '{}' failed to parse: {:?}",
                template.id,
                result.err()
            );
        }
    }

    #[test]
    fn all_node_manifests_parse() {
        let nodes = available_nodes();
        assert!(
            nodes.len() >= 10,
            "Expected at least 10 nodes, got {}",
            nodes.len()
        );
    }

    #[test]
    fn extract_env_vars_deduplicates() {
        let nodes = available_nodes();
        let manifests: Vec<&NodeManifest> = nodes.iter().map(|n| &n.manifest).collect();
        let env_vars = extract_env_vars(&manifests);

        // DEEPGRAM_API_KEY should appear once (used by stt-deepgram + tts-deepgram)
        let dg = env_vars.iter().find(|(name, _, _, _)| name == "DEEPGRAM_API_KEY");
        assert!(dg.is_some(), "DEEPGRAM_API_KEY not found in env vars");
        let (_, required, _, used_by) = dg.unwrap();
        assert!(*required);
        assert!(
            used_by.len() >= 2,
            "DEEPGRAM_API_KEY should be used by at least 2 nodes, got {:?}",
            used_by
        );
    }

    // ---- Evaluator tests ----

    #[test]
    fn templates_embedded_via_include_str() {
        // Verify templates are non-empty (include_str! worked)
        for template in list_templates() {
            assert!(!template.yaml.is_empty(),
                "Template '{}' has empty yaml content", template.id);
            assert!(!template.id.is_empty());
            assert!(!template.label.is_empty());
        }
    }

    #[test]
    fn at_least_four_templates() {
        assert!(
            list_templates().len() >= 4,
            "Expected at least 4 templates, got {}",
            list_templates().len()
        );
    }

    #[test]
    fn node_registry_has_14_nodes() {
        let nodes = available_nodes();
        assert_eq!(
            nodes.len(),
            14,
            "Expected 14 nodes in registry, got {}",
            nodes.len()
        );
    }

    #[test]
    fn node_registry_packages_are_scoped() {
        // All packages should be @acpfx/*
        for entry in &available_nodes() {
            assert!(
                entry.package.starts_with("@acpfx/"),
                "Package '{}' should be @acpfx/ scoped",
                entry.package
            );
        }
    }

    #[test]
    fn get_template_by_id() {
        assert!(get_template("elevenlabs").is_some());
        assert!(get_template("deepgram").is_some());
        assert!(get_template("nonexistent").is_none());
    }

    #[test]
    fn templates_contain_nodes_key() {
        // Each template YAML should have a `nodes:` key
        for template in list_templates() {
            let config: crate::config::PipelineConfig =
                serde_yaml::from_str(template.yaml).unwrap();
            assert!(
                !config.nodes.is_empty(),
                "Template '{}' has no nodes",
                template.id
            );
        }
    }

    #[test]
    fn extract_env_vars_both_api_keys() {
        let nodes = available_nodes();
        let manifests: Vec<&NodeManifest> = nodes.iter().map(|n| &n.manifest).collect();
        let env_vars = extract_env_vars(&manifests);

        let names: Vec<&str> = env_vars.iter().map(|(n, _, _, _)| n.as_str()).collect();
        assert!(names.contains(&"DEEPGRAM_API_KEY"), "Missing DEEPGRAM_API_KEY");
        assert!(names.contains(&"ELEVENLABS_API_KEY"), "Missing ELEVENLABS_API_KEY");
    }
}
