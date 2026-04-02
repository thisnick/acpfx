//! Onboarding TUI for acpfx.
//!
//! Interactive terminal prompts using crossterm for pipeline creation,
//! env var setup, and config saving.

use std::collections::BTreeMap;
use std::io::{self, Write};

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    style::{self, Stylize},
    terminal::{self, ClearType},
};

use crate::config::PipelineConfig;
use crate::templates;
use crate::user_config;

/// Result of the onboarding flow.
pub struct OnboardResult {
    /// Name the user chose for the pipeline.
    pub pipeline_name: String,
    /// Path where the pipeline was saved.
    pub pipeline_path: std::path::PathBuf,
    /// Whether to run the pipeline immediately.
    pub run_now: bool,
}

/// Run the full onboarding flow.
pub fn run_onboard(auto_triggered: bool) -> Result<Option<OnboardResult>, String> {
    terminal::enable_raw_mode().map_err(|e| format!("Failed to enable raw mode: {e}"))?;
    let result = run_onboard_inner(auto_triggered);
    terminal::disable_raw_mode().ok();
    result
}

fn run_onboard_inner(auto_triggered: bool) -> Result<Option<OnboardResult>, String> {
    let mut stdout = io::stdout();

    // Step 1: Welcome
    clear_screen(&mut stdout);
    print_header(&mut stdout);

    if auto_triggered {
        print_line(&mut stdout, "  No pipeline configured. Let's set one up!\n");
    }

    print_line(&mut stdout, "  How would you like to start?\n");

    let choices = &["Start from a template", "Build from scratch"];
    let choice = select_menu(&mut stdout, choices)?;

    match choice {
        Some(0) => template_flow(&mut stdout),
        Some(1) => build_flow(&mut stdout),
        _ => Ok(None), // User cancelled or invalid
    }
}

fn template_flow(stdout: &mut io::Stdout) -> Result<Option<OnboardResult>, String> {
    // Step 2a: Template selection
    clear_screen(stdout);
    print_line(stdout, "\n  Choose a template:\n");

    let templates = templates::list_templates();
    let labels: Vec<&str> = templates.iter().map(|t| t.label).collect();
    let choice = select_menu(stdout, &labels)?;

    let template = match choice {
        Some(idx) => &templates[idx],
        None => return Ok(None),
    };

    // Parse the template
    let config: PipelineConfig = serde_yaml::from_str(template.yaml)
        .map_err(|e| format!("Failed to parse template: {e}"))?;

    // Step 2a-review: Show template details
    clear_screen(stdout);
    print_line(stdout, &format!("\n  Pipeline: {}\n", template.label));
    print_line(stdout, "\n  Nodes:");
    for (name, node) in &config.nodes {
        print_line(stdout, &format!("    {:<12} {}", name, node.use_));
    }
    print_line(stdout, "");

    // Continue to env var setup and save
    finish_pipeline(stdout, config, template.id)
}

fn build_flow(stdout: &mut io::Stdout) -> Result<Option<OnboardResult>, String> {
    clear_screen(stdout);
    print_line(stdout, "\n  Pipeline builder\n");
    print_line(stdout, "  Add nodes to your pipeline step by step.\n");

    let available = templates::available_nodes();
    let mut nodes: indexmap::IndexMap<String, crate::config::NodeConfig> = indexmap::IndexMap::new();
    let mut connections: Vec<(String, String)> = Vec::new();

    loop {
        clear_screen(stdout);
        print_line(stdout, "\n  Pipeline builder\n");

        if !nodes.is_empty() {
            print_line(stdout, "  Current nodes:");
            for (name, node) in &nodes {
                print_line(stdout, &format!("    {:<12} {}", name, node.use_));
            }
            if !connections.is_empty() {
                print_line(stdout, "\n  Connections:");
                for (from, to) in &connections {
                    print_line(stdout, &format!("    {} -> {}", from, to));
                }
            }
            print_line(stdout, "");
        }

        let mut menu = vec!["Add a node", "Connect two nodes"];
        if !nodes.is_empty() {
            menu.push("Done - finalize pipeline");
        }
        menu.push("Cancel");

        let choice = select_menu(stdout, &menu)?;

        match choice {
            Some(0) => {
                // Add a node
                print_line(stdout, "\n  Choose a package:");
                let labels: Vec<String> = available
                    .iter()
                    .map(|n| format!("{} - {}", n.package, n.manifest.description.as_deref().unwrap_or("")))
                    .collect();
                let label_refs: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
                let pkg_choice = select_menu(stdout, &label_refs)?;

                if let Some(pkg_idx) = pkg_choice {
                    let entry = &available[pkg_idx];
                    let default_name = entry.manifest.name.clone();
                    print_line(stdout, "");
                    let name = read_line_prompt(stdout, &format!("  Name this node [{}]: ", default_name))?;
                    let name = if name.is_empty() { default_name } else { name };

                    nodes.insert(
                        name,
                        crate::config::NodeConfig {
                            use_: entry.package.to_string(),
                            settings: None,
                            outputs: Vec::new(),
                        },
                    );
                }
            }
            Some(1) => {
                // Connect two nodes
                if nodes.len() < 2 {
                    print_line(stdout, "\n  Need at least 2 nodes to connect.");
                    wait_for_key()?;
                    continue;
                }

                let node_names: Vec<&str> = nodes.keys().map(|s| s.as_str()).collect();
                print_line(stdout, "\n  Connect from:");
                let from = select_menu(stdout, &node_names)?;
                if from.is_none() {
                    continue;
                }

                print_line(stdout, "  Connect to:");
                let to = select_menu(stdout, &node_names)?;
                if to.is_none() {
                    continue;
                }

                let from_name = node_names[from.unwrap()].to_string();
                let to_name = node_names[to.unwrap()].to_string();

                // Add output
                if let Some(node) = nodes.get_mut(&from_name) {
                    if !node.outputs.contains(&to_name) {
                        node.outputs.push(to_name.clone());
                    }
                }
                connections.push((from_name, to_name));
            }
            Some(idx) if menu[idx] == "Done - finalize pipeline" => {
                let config = PipelineConfig {
                    nodes,
                    env: BTreeMap::new(),
                };
                return finish_pipeline(stdout, config, "custom");
            }
            _ => return Ok(None),
        }
    }
}

fn finish_pipeline(
    stdout: &mut io::Stdout,
    config: PipelineConfig,
    default_name: &str,
) -> Result<Option<OnboardResult>, String> {
    // Collect manifests for env var extraction
    let available = templates::available_nodes();
    let node_manifests: Vec<&acpfx_schema::NodeManifest> = config
        .nodes
        .values()
        .filter_map(|node| {
            available
                .iter()
                .find(|n| n.package == node.use_)
                .map(|n| &n.manifest)
        })
        .collect();

    let env_vars = templates::extract_env_vars(&node_manifests);

    // Step 4: Environment variables
    if !env_vars.is_empty() {
        clear_screen(stdout);
        print_line(stdout, "\n  Your pipeline needs these environment variables:\n");

        let merged = user_config::load_merged_config();
        let merged_env = merged.merged_env();

        for (name, required, desc, used_by) in &env_vars {
            let req_label = if *required { " (required)" } else { " (optional)" };
            let status = if std::env::var(name).is_ok() || merged_env.contains_key(name) {
                "set"
            } else {
                "not set"
            };
            print_line(stdout, &format!("  {}{}", name, req_label));
            if !desc.is_empty() {
                print_line(stdout, &format!("    {}", desc));
            }
            print_line(stdout, &format!("    Used by: {}", used_by.join(", ")));
            print_line(stdout, &format!("    Status: {}\n", status));
        }

        print_line(stdout, "  (Set env vars via 'acpfx config set env.KEY value')\n");
        print_line(stdout, "  Press Enter to continue...");
        wait_for_key()?;
    }

    // Step 5: Save pipeline
    clear_screen(stdout);
    print_line(stdout, "\n  Save your pipeline\n");

    let pipeline_name = read_line_prompt(stdout, &format!("  Name [{}]: ", default_name))?;
    let pipeline_name = if pipeline_name.is_empty() {
        default_name.to_string()
    } else {
        pipeline_name
    };

    print_line(stdout, "\n  Where to save?");
    let save_options = &["Global (~/.acpfx/pipelines/)", "Project (.acpfx/pipelines/)"];
    let save_choice = select_menu(stdout, save_options)?;

    let save_dir = match save_choice {
        Some(0) => user_config::global_config_dir().join("pipelines"),
        Some(1) => user_config::project_config_dir().join("pipelines"),
        _ => return Ok(None),
    };

    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create {}: {e}", save_dir.display()))?;

    let yaml = serde_yaml::to_string(&config)
        .map_err(|e| format!("Failed to serialize pipeline: {e}"))?;
    let pipeline_path = save_dir.join(format!("{}.yaml", pipeline_name));
    std::fs::write(&pipeline_path, &yaml)
        .map_err(|e| format!("Failed to write {}: {e}", pipeline_path.display()))?;

    // Ask to set as default
    print_line(stdout, "\n  Set as default pipeline?");
    let default_choices = &["Yes", "No"];
    let set_default = select_menu(stdout, default_choices)?;

    if set_default == Some(0) {
        let is_global = save_choice == Some(0);
        let config_dir = if is_global {
            user_config::global_config_dir()
        } else {
            user_config::project_config_dir()
        };
        let mut user_cfg = user_config::load_config_from_dir(&config_dir);
        user_cfg.default_pipeline = Some(pipeline_name.clone());
        user_config::save_config_to_dir(&config_dir, &user_cfg)
            .map_err(|e| format!("Failed to save config: {e}"))?;
    }

    // Step 6: Done
    clear_screen(stdout);
    print_line(stdout, &format!("\n  Pipeline saved to {}", pipeline_path.display()));
    if set_default == Some(0) {
        print_line(stdout, "  Set as default pipeline");
    }

    print_line(stdout, "\n  Run your pipeline now?");
    let run_choices = &["Yes", "No"];
    let run_now = select_menu(stdout, run_choices)?;

    Ok(Some(OnboardResult {
        pipeline_name,
        pipeline_path,
        run_now: run_now == Some(0),
    }))
}

// ---- Terminal helpers ----

fn clear_screen(stdout: &mut io::Stdout) {
    execute!(
        stdout,
        terminal::Clear(ClearType::All),
        cursor::MoveTo(0, 0)
    )
    .ok();
}

fn print_header(stdout: &mut io::Stdout) {
    print_line(stdout, "");
    print_line(stdout, "  Welcome to acpfx!");
    print_line(stdout, "");
    print_line(stdout, "  acpfx is a pluggable audio pipeline framework");
    print_line(stdout, "  for voice agents. Let's set up your first");
    print_line(stdout, "  pipeline.");
    print_line(stdout, "");
}

fn print_line(stdout: &mut io::Stdout, text: &str) {
    // In raw mode, \n alone doesn't move to column 0
    execute!(stdout, style::Print(text), style::Print("\r\n")).ok();
}

/// Arrow-key selection menu. Returns Some(index) or None if cancelled.
fn select_menu(stdout: &mut io::Stdout, items: &[&str]) -> Result<Option<usize>, String> {
    let mut selected = 0;

    loop {
        // Render menu
        for (i, item) in items.iter().enumerate() {
            if i == selected {
                execute!(
                    stdout,
                    style::Print(format!("  > {}\r\n", item.bold()))
                )
                .ok();
            } else {
                execute!(stdout, style::Print(format!("    {}\r\n", item))).ok();
            }
        }

        // Read key
        let key = read_key()?;
        match key {
            KeyCode::Up => {
                selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                if selected < items.len() - 1 {
                    selected += 1;
                }
            }
            KeyCode::Enter => return Ok(Some(selected)),
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c') => return Ok(None), // ctrl+c handled by modifier check
            _ => {}
        }

        // Move cursor back up to re-render
        execute!(stdout, cursor::MoveUp(items.len() as u16)).ok();
    }
}

fn read_key() -> Result<KeyCode, String> {
    loop {
        if let Event::Key(key_event) = event::read().map_err(|e| format!("Input error: {e}"))? {
            if key_event.modifiers.contains(KeyModifiers::CONTROL)
                && key_event.code == KeyCode::Char('c')
            {
                return Ok(KeyCode::Esc);
            }
            return Ok(key_event.code);
        }
    }
}

fn wait_for_key() -> Result<(), String> {
    loop {
        if let Event::Key(_) = event::read().map_err(|e| format!("Input error: {e}"))? {
            return Ok(());
        }
    }
}

fn read_line_prompt(stdout: &mut io::Stdout, prompt: &str) -> Result<String, String> {
    // Temporarily disable raw mode for line input
    terminal::disable_raw_mode().ok();
    execute!(stdout, style::Print(prompt)).ok();
    stdout.flush().ok();

    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|e| format!("Input error: {e}"))?;

    terminal::enable_raw_mode().ok();
    Ok(input.trim().to_string())
}
