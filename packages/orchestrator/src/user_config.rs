//! User configuration system for acpfx.
//!
//! Manages two config layers:
//!   - Global: `~/.acpfx/config.json`
//!   - Project: `.acpfx/config.json` (relative to cwd)
//!
//! Project config overrides global config.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The config.json format.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    /// Default pipeline name (resolved via pipeline_resolver).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_pipeline: Option<String>,

    /// Environment variables to inject when spawning nodes.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Merged view of both config layers.
#[derive(Debug, Clone)]
pub struct MergedConfig {
    pub global: UserConfig,
    pub project: UserConfig,
}

impl MergedConfig {
    /// Get the effective default pipeline (project overrides global).
    pub fn default_pipeline(&self) -> Option<&str> {
        self.project
            .default_pipeline
            .as_deref()
            .or(self.global.default_pipeline.as_deref())
    }

    /// Get merged env vars (project overrides global).
    #[allow(dead_code)]
    pub fn merged_env(&self) -> BTreeMap<String, String> {
        let mut env = self.global.env.clone();
        for (k, v) in &self.project.env {
            env.insert(k.clone(), v.clone());
        }
        env
    }

    /// Get a config value by key path (e.g., "defaultPipeline", "env.DEEPGRAM_API_KEY").
    pub fn get(&self, key: &str) -> Option<String> {
        // Check project first, then global
        get_from_config(&self.project, key)
            .or_else(|| get_from_config(&self.global, key))
    }
}

fn get_from_config(config: &UserConfig, key: &str) -> Option<String> {
    match key {
        "defaultPipeline" => config.default_pipeline.clone(),
        k if k.starts_with("env.") => {
            let env_key = &k[4..];
            config.env.get(env_key).cloned()
        }
        _ => None,
    }
}

/// Path to global config directory.
pub fn global_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".acpfx")
}

/// Path to project config directory.
pub fn project_config_dir() -> PathBuf {
    PathBuf::from(".acpfx")
}

/// Load config from a directory (reads config.json if it exists).
pub fn load_config_from_dir(dir: &Path) -> UserConfig {
    let path = dir.join("config.json");
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => UserConfig::default(),
        }
    } else {
        UserConfig::default()
    }
}

/// Load both config layers and return a merged view.
pub fn load_merged_config() -> MergedConfig {
    let global = load_config_from_dir(&global_config_dir());
    let project = load_config_from_dir(&project_config_dir());
    MergedConfig { global, project }
}

/// Save config to a directory.
pub fn save_config_to_dir(dir: &Path, config: &UserConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

/// Set a value in the config.
pub fn set_config_value(config: &mut UserConfig, key: &str, value: &str) -> Result<(), String> {
    match key {
        "defaultPipeline" => {
            config.default_pipeline = Some(value.to_string());
            Ok(())
        }
        k if k.starts_with("env.") => {
            let env_key = &k[4..];
            config.env.insert(env_key.to_string(), value.to_string());
            Ok(())
        }
        _ => Err(format!("Unknown config key: {key}")),
    }
}

/// Build the full environment for spawning nodes.
/// Priority: system env > project config env > global config env > pipeline yaml env.
#[allow(dead_code)]
pub fn build_node_env(
    merged: &MergedConfig,
    yaml_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    // Layer 4 (lowest): pipeline YAML env block
    for (k, v) in yaml_env {
        env.insert(k.clone(), v.clone());
    }

    // Layer 3: global config env
    for (k, v) in &merged.global.env {
        env.insert(k.clone(), v.clone());
    }

    // Layer 2: project config env
    for (k, v) in &merged.project.env {
        env.insert(k.clone(), v.clone());
    }

    // Layer 1 (highest): system env — override any config values
    let keys: Vec<String> = env.keys().cloned().collect();
    for k in keys {
        if let Ok(sys_val) = std::env::var(&k) {
            env.insert(k, sys_val);
        }
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn load_nonexistent_config() {
        let config = load_config_from_dir(Path::new("/tmp/acpfx-test-nonexistent"));
        assert_eq!(config.default_pipeline, None);
        assert!(config.env.is_empty());
    }

    #[test]
    fn roundtrip_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = UserConfig {
            default_pipeline: Some("my-pipeline".into()),
            env: {
                let mut m = BTreeMap::new();
                m.insert("API_KEY".into(), "sk-test".into());
                m
            },
        };
        save_config_to_dir(dir.path(), &config).unwrap();
        let loaded = load_config_from_dir(dir.path());
        assert_eq!(loaded.default_pipeline, Some("my-pipeline".into()));
        assert_eq!(loaded.env.get("API_KEY").unwrap(), "sk-test");
    }

    #[test]
    fn merge_project_overrides_global() {
        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: Some("global-default".into()),
                env: {
                    let mut m = BTreeMap::new();
                    m.insert("KEY".into(), "global-val".into());
                    m.insert("ONLY_GLOBAL".into(), "g".into());
                    m
                },
            },
            project: UserConfig {
                default_pipeline: Some("project-default".into()),
                env: {
                    let mut m = BTreeMap::new();
                    m.insert("KEY".into(), "project-val".into());
                    m
                },
            },
        };

        assert_eq!(merged.default_pipeline(), Some("project-default"));
        let env = merged.merged_env();
        assert_eq!(env.get("KEY").unwrap(), "project-val");
        assert_eq!(env.get("ONLY_GLOBAL").unwrap(), "g");
    }

    #[test]
    fn set_config_value_works() {
        let mut config = UserConfig::default();
        set_config_value(&mut config, "defaultPipeline", "test").unwrap();
        assert_eq!(config.default_pipeline, Some("test".into()));

        set_config_value(&mut config, "env.MY_KEY", "my_val").unwrap();
        assert_eq!(config.env.get("MY_KEY").unwrap(), "my_val");

        assert!(set_config_value(&mut config, "unknown", "val").is_err());
    }

    #[test]
    fn get_config_value() {
        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: None,
                env: {
                    let mut m = BTreeMap::new();
                    m.insert("KEY".into(), "val".into());
                    m
                },
            },
            project: UserConfig::default(),
        };

        assert_eq!(merged.get("env.KEY"), Some("val".into()));
        assert_eq!(merged.get("defaultPipeline"), None);
    }

    #[test]
    fn build_env_layering() {
        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: None,
                env: {
                    let mut m = BTreeMap::new();
                    m.insert("A".into(), "global".into());
                    m.insert("B".into(), "global".into());
                    m
                },
            },
            project: UserConfig {
                default_pipeline: None,
                env: {
                    let mut m = BTreeMap::new();
                    m.insert("B".into(), "project".into());
                    m.insert("C".into(), "project".into());
                    m
                },
            },
        };

        let yaml_env = {
            let mut m = BTreeMap::new();
            m.insert("A".into(), "yaml".into());
            m.insert("D".into(), "yaml".into());
            m
        };

        let env = build_node_env(&merged, &yaml_env);
        // A: global overrides yaml
        assert_eq!(env.get("A").unwrap(), "global");
        // B: project overrides global
        assert_eq!(env.get("B").unwrap(), "project");
        // C: project only
        assert_eq!(env.get("C").unwrap(), "project");
        // D: yaml only
        assert_eq!(env.get("D").unwrap(), "yaml");
    }

    // ---- Evaluator tests ----

    #[test]
    fn build_env_system_env_overrides_all() {
        // System env should override project, global, and yaml
        let key = "ACPFX_TEST_SYS_OVERRIDE_1234";
        std::env::set_var(key, "system-wins");

        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: None,
                env: {
                    let mut m = BTreeMap::new();
                    m.insert(key.into(), "global".into());
                    m
                },
            },
            project: UserConfig {
                default_pipeline: None,
                env: {
                    let mut m = BTreeMap::new();
                    m.insert(key.into(), "project".into());
                    m
                },
            },
        };

        let yaml_env = {
            let mut m = BTreeMap::new();
            m.insert(key.into(), "yaml".into());
            m
        };

        let env = build_node_env(&merged, &yaml_env);
        assert_eq!(env.get(key).unwrap(), "system-wins",
            "System env must override all config layers");

        std::env::remove_var(key);
    }

    #[test]
    fn default_pipeline_project_overrides_global() {
        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: Some("global-pipeline".into()),
                env: BTreeMap::new(),
            },
            project: UserConfig {
                default_pipeline: Some("project-pipeline".into()),
                env: BTreeMap::new(),
            },
        };
        assert_eq!(merged.default_pipeline(), Some("project-pipeline"));
    }

    #[test]
    fn default_pipeline_falls_back_to_global() {
        let merged = MergedConfig {
            global: UserConfig {
                default_pipeline: Some("global-pipeline".into()),
                env: BTreeMap::new(),
            },
            project: UserConfig::default(),
        };
        assert_eq!(merged.default_pipeline(), Some("global-pipeline"));
    }

    #[test]
    fn default_pipeline_none_when_both_empty() {
        let merged = MergedConfig {
            global: UserConfig::default(),
            project: UserConfig::default(),
        };
        assert_eq!(merged.default_pipeline(), None);
    }

    #[test]
    fn config_json_uses_camel_case() {
        let config = UserConfig {
            default_pipeline: Some("test".into()),
            env: BTreeMap::new(),
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("defaultPipeline"),
            "config.json should use camelCase: {json}");
        assert!(!json.contains("default_pipeline"),
            "config.json should not use snake_case: {json}");
    }
}
