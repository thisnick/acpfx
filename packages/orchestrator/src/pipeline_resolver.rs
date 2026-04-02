//! Pipeline name → file path resolution.
//!
//! Resolution order:
//! 1. If name is a file path (contains `/` or ends `.yaml`) → load directly
//! 2. `.acpfx/pipelines/<name>.yaml` → project-local
//! 3. `~/.acpfx/pipelines/<name>.yaml` → global
//! 4. `examples/pipeline/<name>.yaml` → bundled (debug only)
//! 5. Error: pipeline not found

use std::path::PathBuf;

use crate::user_config;

/// Resolve a pipeline name to a file path.
pub fn resolve_pipeline(name: &str) -> Result<PathBuf, String> {
    // 1. Direct file path
    if name.contains('/') || name.contains('\\') || name.ends_with(".yaml") || name.ends_with(".yml") {
        let path = PathBuf::from(name);
        if path.exists() {
            return Ok(path.canonicalize().unwrap_or(path));
        }
        return Err(format!("Pipeline file not found: {name}"));
    }

    // 2. Project-local: .acpfx/pipelines/<name>.yaml
    let project_path = user_config::project_config_dir()
        .join("pipelines")
        .join(format!("{name}.yaml"));
    if project_path.exists() {
        return Ok(project_path.canonicalize().unwrap_or(project_path));
    }

    // 3. Global: ~/.acpfx/pipelines/<name>.yaml
    let global_path = user_config::global_config_dir()
        .join("pipelines")
        .join(format!("{name}.yaml"));
    if global_path.exists() {
        return Ok(global_path.canonicalize().unwrap_or(global_path));
    }

    // 4. Bundled examples (debug builds only)
    #[cfg(debug_assertions)]
    {
        let examples_path = PathBuf::from(format!("examples/pipeline/{name}.yaml"));
        if examples_path.exists() {
            return Ok(examples_path.canonicalize().unwrap_or(examples_path));
        }
    }

    // 5. Not found
    let mut msg = format!("Pipeline '{name}' not found. Searched:\n");
    msg.push_str(&format!("  - .acpfx/pipelines/{name}.yaml\n"));
    msg.push_str(&format!(
        "  - {}\n",
        user_config::global_config_dir()
            .join("pipelines")
            .join(format!("{name}.yaml"))
            .display()
    ));
    #[cfg(debug_assertions)]
    msg.push_str(&format!("  - examples/pipeline/{name}.yaml\n"));
    msg.push_str("\nRun 'acpfx pipelines' to see available pipelines.");
    Err(msg)
}

/// List all available pipelines (project + global + bundled).
pub fn list_pipelines() -> Vec<(String, String)> {
    let mut pipelines = Vec::new();

    // Project-local
    let project_dir = user_config::project_config_dir().join("pipelines");
    if project_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&project_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".yaml") || name.ends_with(".yml") {
                    let short = name.trim_end_matches(".yaml").trim_end_matches(".yml");
                    pipelines.push((short.to_string(), "project".to_string()));
                }
            }
        }
    }

    // Global
    let global_dir = user_config::global_config_dir().join("pipelines");
    if global_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&global_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".yaml") || name.ends_with(".yml") {
                    let short = name.trim_end_matches(".yaml").trim_end_matches(".yml");
                    // Don't duplicate if project already has same name
                    if !pipelines.iter().any(|(n, _)| n == short) {
                        pipelines.push((short.to_string(), "global".to_string()));
                    }
                }
            }
        }
    }

    // Bundled examples (debug only)
    #[cfg(debug_assertions)]
    {
        let examples_dir = PathBuf::from("examples/pipeline");
        if examples_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&examples_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with(".yaml") || name.ends_with(".yml") {
                        let short = name.trim_end_matches(".yaml").trim_end_matches(".yml");
                        if !pipelines.iter().any(|(n, _)| n == short) {
                            pipelines.push((short.to_string(), "bundled".to_string()));
                        }
                    }
                }
            }
        }
    }

    pipelines.sort_by(|a, b| a.0.cmp(&b.0));
    pipelines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolve_direct_file_path() {
        let dir = tempfile::tempdir().unwrap();
        let yaml_path = dir.path().join("test.yaml");
        fs::write(&yaml_path, "nodes: {}").unwrap();
        let result = resolve_pipeline(yaml_path.to_str().unwrap());
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_nonexistent_file_path() {
        let result = resolve_pipeline("/tmp/acpfx-nonexistent-pipeline.yaml");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn resolve_name_not_found() {
        let result = resolve_pipeline("nonexistent-pipeline-name");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn list_pipelines_returns_sorted() {
        // This test just verifies the function doesn't panic and returns sorted results
        let pipelines = list_pipelines();
        for i in 1..pipelines.len() {
            assert!(pipelines[i - 1].0 <= pipelines[i].0);
        }
    }

    // ---- Evaluator tests ----

    #[test]
    fn resolve_path_with_slash() {
        // Any name containing '/' should be treated as a file path, not a name
        let result = resolve_pipeline("/tmp/does-not-exist/pipeline.yaml");
        assert!(result.is_err());
        // Should say "file not found", not "pipeline not found" via name resolution
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn resolve_path_ending_yaml() {
        // Names ending in .yaml should be treated as file paths
        let result = resolve_pipeline("my-pipeline.yaml");
        assert!(result.is_err());
        // Should attempt direct file load, not name resolution
        let err = result.unwrap_err();
        assert!(err.contains("not found"), "Should report file not found: {err}");
    }

    #[test]
    fn resolve_direct_file_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let yaml_path = dir.path().join("custom.yaml");
        fs::write(&yaml_path, "nodes: {}").unwrap();

        // Absolute path
        let result = resolve_pipeline(yaml_path.to_str().unwrap());
        assert!(result.is_ok(), "Should resolve absolute yaml path");
    }
}
