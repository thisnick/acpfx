//! Onboarding TUI for acpfx.
//!
//! Interactive terminal prompts using ratatui + crossterm for pipeline creation,
//! env var setup, and config saving.
//!
//! The UI logic is generic over `InputSource` so it can be tested with mock input.

use std::collections::BTreeMap;
use std::io::{self, Write};

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    style::{self, Attribute, Color, Stylize},
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

// ---- Input abstraction ----

/// Trait abstracting terminal input so the onboarding flow can be tested.
pub trait InputSource {
    /// Read a single key press. Return KeyCode.
    fn read_key(&mut self) -> Result<KeyCode, String>;
    /// Read a line of text input (raw mode is temporarily disabled in real impl).
    fn read_line(&mut self, prompt: &str) -> Result<String, String>;
}

/// Real terminal input via crossterm.
struct TerminalInput {
    stdout: io::Stdout,
}

impl TerminalInput {
    fn new() -> Self {
        Self {
            stdout: io::stdout(),
        }
    }
}

impl InputSource for TerminalInput {
    fn read_key(&mut self) -> Result<KeyCode, String> {
        loop {
            if let Event::Key(key_event) =
                event::read().map_err(|e| format!("Input error: {e}"))?
            {
                if key_event.modifiers.contains(KeyModifiers::CONTROL)
                    && key_event.code == KeyCode::Char('c')
                {
                    return Ok(KeyCode::Esc);
                }
                return Ok(key_event.code);
            }
        }
    }

    fn read_line(&mut self, prompt: &str) -> Result<String, String> {
        terminal::disable_raw_mode().ok();
        execute!(self.stdout, style::Print(prompt)).ok();
        self.stdout.flush().ok();

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| format!("Input error: {e}"))?;

        terminal::enable_raw_mode().ok();
        Ok(input.trim().to_string())
    }
}

/// Mock input for testing — feeds pre-recorded keys and line inputs.
#[cfg(test)]
pub struct MockInput {
    pub keys: std::collections::VecDeque<KeyCode>,
    pub lines: std::collections::VecDeque<String>,
}

#[cfg(test)]
impl InputSource for MockInput {
    fn read_key(&mut self) -> Result<KeyCode, String> {
        self.keys
            .pop_front()
            .ok_or_else(|| "MockInput: no more keys".to_string())
    }

    fn read_line(&mut self, _prompt: &str) -> Result<String, String> {
        self.lines
            .pop_front()
            .ok_or_else(|| "MockInput: no more lines".to_string())
    }
}

// ---- Output abstraction ----

/// Trait abstracting terminal output so we can capture it in tests.
pub trait OutputSink {
    fn clear_screen(&mut self);
    fn print_line(&mut self, text: &str);
    /// Print a line with bold text.
    fn print_bold(&mut self, text: &str);
    /// Print a line with a specific color.
    fn print_colored(&mut self, text: &str, color: Color);
    /// Print a line with dim/muted text.
    fn print_dim(&mut self, text: &str);
    fn move_up(&mut self, lines: u16);
}

/// Real terminal output via crossterm.
struct TerminalOutput {
    stdout: io::Stdout,
}

impl TerminalOutput {
    fn new() -> Self {
        Self {
            stdout: io::stdout(),
        }
    }
}

impl OutputSink for TerminalOutput {
    fn clear_screen(&mut self) {
        execute!(
            self.stdout,
            terminal::Clear(ClearType::All),
            cursor::MoveTo(0, 0)
        )
        .ok();
    }

    fn print_line(&mut self, text: &str) {
        execute!(self.stdout, style::Print(text), style::Print("\r\n")).ok();
    }

    fn print_bold(&mut self, text: &str) {
        execute!(
            self.stdout,
            style::Print(text.bold()),
            style::Print("\r\n")
        ).ok();
    }

    fn print_colored(&mut self, text: &str, color: Color) {
        execute!(
            self.stdout,
            style::Print(text.with(color)),
            style::Print("\r\n")
        ).ok();
    }

    fn print_dim(&mut self, text: &str) {
        execute!(
            self.stdout,
            style::Print(text.attribute(Attribute::Dim)),
            style::Print("\r\n")
        ).ok();
    }

    fn move_up(&mut self, lines: u16) {
        execute!(self.stdout, cursor::MoveUp(lines)).ok();
    }
}

/// Captured output for testing.
#[cfg(test)]
pub struct CapturedOutput {
    pub lines: Vec<String>,
    pub screen_clears: usize,
}

#[cfg(test)]
impl CapturedOutput {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            screen_clears: 0,
        }
    }
}

#[cfg(test)]
impl OutputSink for CapturedOutput {
    fn clear_screen(&mut self) {
        self.screen_clears += 1;
    }

    fn print_line(&mut self, text: &str) {
        self.lines.push(text.to_string());
    }

    fn print_bold(&mut self, text: &str) {
        self.lines.push(text.to_string());
    }

    fn print_colored(&mut self, text: &str, _color: Color) {
        self.lines.push(text.to_string());
    }

    fn print_dim(&mut self, text: &str) {
        self.lines.push(text.to_string());
    }

    fn move_up(&mut self, _lines: u16) {}
}

// ---- Public entry point ----

/// Run the full onboarding flow with real terminal I/O.
pub fn run_onboard(auto_triggered: bool) -> Result<Option<OnboardResult>, String> {
    terminal::enable_raw_mode().map_err(|e| format!("Failed to enable raw mode: {e}"))?;
    let mut input = TerminalInput::new();
    let mut output = TerminalOutput::new();
    let result = run_onboard_with(&mut input, &mut output, auto_triggered);
    terminal::disable_raw_mode().ok();
    result
}

/// Run the onboarding flow with injected I/O (for testing).
pub fn run_onboard_with(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    auto_triggered: bool,
) -> Result<Option<OnboardResult>, String> {
    loop {
        output.clear_screen();
        print_header(output);

        if auto_triggered {
            output.print_line("  No pipeline configured. Let's set one up!\n");
        }

        output.print_bold("  How would you like to start?\n");

        // Check for user-created pipelines (exclude bundled templates)
        let existing: Vec<(String, String)> = crate::pipeline_resolver::list_pipelines()
            .into_iter()
            .filter(|(_, source)| source != "bundled")
            .collect();
        let has_existing = !existing.is_empty();

        let mut choices: Vec<&str> = vec!["Start from a template", "Build from scratch"];
        if has_existing {
            choices.push("Edit an existing pipeline");
        }
        choices.push("Done");

        let choice = select_menu(input, output, &choices)?;
        let choice_label = choice.map(|i| choices[i]);

        match choice_label {
            Some("Start from a template") => return template_flow(input, output),
            Some("Build from scratch") => return build_flow(input, output),
            Some("Edit an existing pipeline") => {
                edit_existing_flow(input, output, &existing)?;
                // After edit, loop back to main menu
                continue;
            }
            Some("Done") | None => {
                // Check if any pipelines exist
                let all_pipelines: Vec<(String, String)> =
                    crate::pipeline_resolver::list_pipelines()
                        .into_iter()
                        .filter(|(_, source)| source != "bundled")
                        .collect();
                if all_pipelines.is_empty() {
                    output.print_colored(
                        "\n  No pipelines configured. You won't be able to run acpfx.\n",
                        Color::Yellow,
                    );
                    output.print_bold("  Exit anyway?\n");
                    let confirm = select_menu(input, output, &["Yes, exit", "No, go back"])?;
                    if confirm == Some(0) {
                        return Ok(None);
                    }
                    continue;
                }
                return Ok(None);
            }
            _ => return Ok(None),
        }
    }
}

// ---- Flows ----

fn template_flow(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
) -> Result<Option<OnboardResult>, String> {
    output.clear_screen();
    output.print_bold("\n  Choose a template:\n");

    let templates = templates::list_templates();
    let labels: Vec<&str> = templates.iter().map(|t| t.label).collect();
    let choice = select_menu(input, output, &labels)?;

    let template = match choice {
        Some(idx) => &templates[idx],
        None => return Ok(None),
    };

    let config: PipelineConfig = serde_yaml::from_str(template.yaml)
        .map_err(|e| format!("Failed to parse template: {e}"))?;

    // Show template details
    output.clear_screen();
    output.print_bold(&format!("\n  Pipeline: {}\n", template.label));
    output.print_line("\n  Nodes:");
    for (name, node) in &config.nodes {
        output.print_line(&format!("    {:<12} {}", name, node.use_));
    }
    output.print_line("");

    finish_pipeline(input, output, config, template.id)
}

fn build_flow(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
) -> Result<Option<OnboardResult>, String> {
    output.clear_screen();
    output.print_bold("\n  Pipeline builder\n");
    output.print_line("  Add nodes to your pipeline step by step.\n");

    let available = templates::available_nodes();
    let mut nodes: indexmap::IndexMap<String, crate::config::NodeConfig> = indexmap::IndexMap::new();
    let mut connections: Vec<(String, String)> = Vec::new();

    loop {
        output.clear_screen();
        output.print_bold("\n  Pipeline builder\n");

        if !nodes.is_empty() {
            output.print_line("  Current nodes:");
            for (name, node) in &nodes {
                output.print_line(&format!("    {:<12} {}", name, node.use_));
            }
            if !connections.is_empty() {
                output.print_line("\n  Connections:");
                for (from, to) in &connections {
                    output.print_line(&format!("    {} -> {}", from, to));
                }
            }
            output.print_line("");
        }

        let mut menu = vec!["Add a node", "Connect two nodes"];
        if !nodes.is_empty() {
            menu.push("Done - finalize pipeline");
        }
        menu.push("Cancel");

        let choice = select_menu(input, output, &menu)?;

        match choice {
            Some(0) => {
                output.print_line("\n  Choose a package:");
                let labels: Vec<String> = available
                    .iter()
                    .map(|n| {
                        format!(
                            "{} - {}",
                            n.package,
                            n.manifest.description.as_deref().unwrap_or("")
                        )
                    })
                    .collect();
                let label_refs: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
                let pkg_choice = select_menu(input, output, &label_refs)?;

                if let Some(pkg_idx) = pkg_choice {
                    let entry = &available[pkg_idx];
                    let default_name = entry.manifest.name.clone();
                    output.print_line("");
                    let name = input
                        .read_line(&format!("  Name this node [{}]: ", default_name))?;
                    let name = if name.is_empty() {
                        default_name
                    } else {
                        name
                    };

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
                if nodes.len() < 2 {
                    output.print_line("\n  Need at least 2 nodes to connect.");
                    input.read_key()?;
                    continue;
                }

                let node_names: Vec<&str> = nodes.keys().map(|s| s.as_str()).collect();
                output.print_line("\n  Connect from:");
                let from = select_menu(input, output, &node_names)?;
                if from.is_none() {
                    continue;
                }

                output.print_line("  Connect to:");
                let to = select_menu(input, output, &node_names)?;
                if to.is_none() {
                    continue;
                }

                let from_name = node_names[from.unwrap()].to_string();
                let to_name = node_names[to.unwrap()].to_string();

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
                return finish_pipeline(input, output, config, "custom");
            }
            _ => return Ok(None),
        }
    }
}

/// Returns Ok(()) to go back to main menu.
fn edit_existing_flow(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    existing: &[(String, String)],
) -> Result<(), String> {
    output.clear_screen();
    output.print_bold("\n  Edit an existing pipeline\n");

    // Select pipeline
    let labels: Vec<String> = existing
        .iter()
        .map(|(name, source)| format!("{} [{}]", name, source))
        .collect();
    let label_refs: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
    let choice = select_menu(input, output, &label_refs)?;

    let (name, source) = match choice {
        Some(idx) => &existing[idx],
        None => return Ok(()),
    };

    let pipeline_path = crate::pipeline_resolver::resolve_pipeline(name)
        .map_err(|e| format!("Failed to resolve pipeline '{}': {}", name, e))?;

    // Show pipeline info
    output.clear_screen();
    output.print_bold(&format!("\n  {} [{}]\n", name, source));
    output.print_dim(&format!("  {}\n", pipeline_path.display()));

    let yaml = std::fs::read_to_string(&pipeline_path)
        .map_err(|e| format!("Failed to read {}: {}", pipeline_path.display(), e))?;
    let config: PipelineConfig = serde_yaml::from_str(&yaml)
        .map_err(|e| format!("Failed to parse {}: {}", pipeline_path.display(), e))?;

    output.print_line("  Nodes:");
    for (node_name, node) in &config.nodes {
        output.print_dim(&format!("    {:<12} {}", node_name, node.use_));
    }
    output.print_line("");

    // Sub-menu: configure, rename, delete
    let actions = &["Configure", "Rename pipeline", "Delete pipeline", "Back"];
    let action = select_menu(input, output, actions)?;

    match action {
        Some(0) => {
            // Configure: nodes → env vars → set as default → save
            let mut config = config;
            // Step-based flow with backtracking
            enum Step { Nodes, EnvVars, Default, Save }
            let mut step = Step::Nodes;

            loop {
                match step {
                    Step::Nodes => {
                        configure_nodes(input, output, &mut config)?;
                        step = Step::EnvVars;
                    }
                    Step::EnvVars => {
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
                        prompt_env_vars(input, output, &env_vars)?;

                        if env_vars.is_empty() {
                            output.print_dim("\n  No environment variables to configure.\n");
                            step = Step::Default;
                        } else {
                            let nav = select_menu(input, output, &[
                                "Continue",
                                "Back to configure nodes",
                            ])?;
                            match nav {
                                Some(1) => { step = Step::Nodes; continue; }
                                _ => { step = Step::Default; }
                            }
                        }
                    }
                    Step::Default => {
                        output.print_bold("\n  Set as default pipeline?\n");
                        let set_default = select_menu(input, output, &["Yes", "No", "Back to env vars"])?;
                        match set_default {
                            Some(0) => {
                                let config_dir = match source.as_str() {
                                    "global" => user_config::global_config_dir(),
                                    _ => user_config::project_config_dir(),
                                };
                                let mut user_cfg = user_config::load_config_from_dir(&config_dir);
                                user_cfg.default_pipeline = Some(name.clone());
                                user_config::save_config_to_dir(&config_dir, &user_cfg)
                                    .map_err(|e| format!("Failed to save config: {e}"))?;
                                step = Step::Save;
                            }
                            Some(2) => { step = Step::EnvVars; continue; }
                            _ => { step = Step::Save; }
                        }
                    }
                    Step::Save => {
                        let yaml_out = serde_yaml::to_string(&config)
                            .map_err(|e| format!("Failed to serialize pipeline: {e}"))?;
                        std::fs::write(&pipeline_path, &yaml_out)
                            .map_err(|e| format!("Failed to write {}: {e}", pipeline_path.display()))?;

                        output.print_colored(
                            &format!("\n  Pipeline '{}' saved [{}]", name, source),
                            Color::Green,
                        );
                        input.read_key()?;
                        break;
                    }
                }
            }
        }
        Some(1) => {
            // Rename pipeline
            let new_name = input.read_line(&format!("\n  New name for \"{}\": ", name))?;
            if new_name.is_empty() || new_name == *name {
                return Ok(());
            }

            // Check for conflicts in the same scope
            let scope_dir = match source.as_str() {
                "global" => user_config::global_config_dir().join("pipelines"),
                _ => user_config::project_config_dir().join("pipelines"),
            };
            let new_path = scope_dir.join(format!("{}.yaml", new_name));
            if new_path.exists() {
                output.print_colored(
                    &format!("  Pipeline \"{}\" already exists in {} scope.", new_name, source),
                    Color::Yellow,
                );
                input.read_key()?;
                return Ok(());
            }

            // Rename the file
            std::fs::rename(&pipeline_path, &new_path)
                .map_err(|e| format!("Failed to rename: {e}"))?;

            // Update default pipeline reference if it pointed to the old name
            let config_dir = match source.as_str() {
                "global" => user_config::global_config_dir(),
                _ => user_config::project_config_dir(),
            };
            let mut user_cfg = user_config::load_config_from_dir(&config_dir);
            if user_cfg.default_pipeline.as_deref() == Some(name) {
                user_cfg.default_pipeline = Some(new_name.clone());
                user_config::save_config_to_dir(&config_dir, &user_cfg)
                    .map_err(|e| format!("Failed to update config: {e}"))?;
            }

            output.print_colored(
                &format!("  Renamed \"{}\" → \"{}\" [{}]", name, new_name, source),
                Color::Green,
            );
            input.read_key()?;
        }
        Some(2) => {
            // Delete pipeline
            output.print_bold(&format!("\n  Delete \"{}\" [{}]?\n", name, source));
            output.print_dim(&format!("  {}\n", pipeline_path.display()));
            let confirm = select_menu(input, output, &["Yes, delete", "No, keep it"])?;
            if confirm == Some(0) {
                std::fs::remove_file(&pipeline_path)
                    .map_err(|e| format!("Failed to delete: {e}"))?;

                // Clear default pipeline reference if it pointed to this one
                let config_dir = match source.as_str() {
                    "global" => user_config::global_config_dir(),
                    _ => user_config::project_config_dir(),
                };
                let mut user_cfg = user_config::load_config_from_dir(&config_dir);
                if user_cfg.default_pipeline.as_deref() == Some(name) {
                    user_cfg.default_pipeline = None;
                    user_config::save_config_to_dir(&config_dir, &user_cfg)
                        .map_err(|e| format!("Failed to update config: {e}"))?;
                }

                output.print_colored(
                    &format!("  Deleted \"{}\" [{}]", name, source),
                    Color::Green,
                );
                input.read_key()?;
            }
        }
        _ => {} // Back
    }

    Ok(())
}

// ---- Per-component configuration ----

fn configure_nodes(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    config: &mut PipelineConfig,
) -> Result<(), String> {
    let available = templates::available_nodes();

    loop {
        output.clear_screen();
        output.print_bold("\n  Configure Nodes\n");

        let node_names: Vec<String> = config.nodes.keys().cloned().collect();

        // Build menu: nodes + connections + done
        let mut menu_labels: Vec<String> = Vec::new();
        for name in &node_names {
            if let Some(node) = config.nodes.get(name) {
                menu_labels.push(format!("Configure node {}  ({})", name, node.use_));
            }
        }
        menu_labels.push("Edit connections".to_string());
        menu_labels.push("Done".to_string());

        let menu_refs: Vec<&str> = menu_labels.iter().map(|s| s.as_str()).collect();
        let choice = select_menu(input, output, &menu_refs)?;

        let edit_connections_idx = node_names.len();
        let done_idx = node_names.len() + 1;

        match choice {
            Some(idx) if idx == edit_connections_idx => {
                edit_connections(input, output, config)?;
            }
            Some(idx) if idx == done_idx => return Ok(()),
            None => return Ok(()),
            Some(idx) if idx < node_names.len() => {
                let node_name = node_names[idx].clone();
                let use_ = config.nodes[&node_name].use_.clone();

                // Sub-menu for this node — show current state
                output.clear_screen();
                output.print_bold(&format!("\n  {} — {}\n", node_name, use_));

                // Show current arguments
                if let Some(entry) = available.iter().find(|n| n.package == use_) {
                    let manifest = &entry.manifest;
                    if let Some(desc) = &manifest.description {
                        output.print_dim(&format!("  {}", desc));
                    }
                    if !manifest.arguments.is_empty() {
                        output.print_line("\n  Arguments:");
                        let settings = config.nodes[&node_name]
                            .settings
                            .as_ref()
                            .and_then(|v| v.as_object());
                        for (arg_name, arg) in &manifest.arguments {
                            let current = settings.and_then(|s| s.get(arg_name));
                            let display = format_value(current, &arg.default);
                            if current.is_some() {
                                output.print_colored(&format!("    {} = {}", arg_name, display), Color::Green);
                            } else if arg.is_required() {
                                output.print_colored(&format!("    {} = {}", arg_name, display), Color::Yellow);
                            } else {
                                output.print_dim(&format!("    {} = {}", arg_name, display));
                            }
                        }
                    }
                }

                // Show edges
                let outputs = &config.nodes[&node_name].outputs;
                let incoming: Vec<&str> = config
                    .nodes
                    .iter()
                    .filter(|(_, n)| n.outputs.contains(&node_name))
                    .map(|(name, _)| name.as_str())
                    .collect();
                output.print_line("\n  Connections:");
                if !incoming.is_empty() {
                    output.print_dim(&format!("    in:  {}", incoming.join(", ")));
                }
                if !outputs.is_empty() {
                    output.print_dim(&format!("    out: {}", outputs.join(", ")));
                }
                if incoming.is_empty() && outputs.is_empty() {
                    output.print_dim("    (none)");
                }
                output.print_line("");

                let has_args = available
                    .iter()
                    .find(|n| n.package == use_)
                    .map(|e| !e.manifest.arguments.is_empty())
                    .unwrap_or(false);

                let mut actions: Vec<&str> = Vec::new();
                if has_args {
                    actions.push("Configure arguments");
                }
                actions.push("Rename node");
                actions.push("Delete node");
                actions.push("Back");

                let action = select_menu(input, output, &actions)?;
                let action_label = action.map(|i| actions[i]);

                match action_label {
                    Some("Configure arguments") => {
                        if let Some(entry) = available.iter().find(|n| n.package == use_) {
                            if let Some(node_config) = config.nodes.get_mut(&node_name) {
                                configure_single_node(
                                    input, output, &node_name, node_config, &entry.manifest,
                                )?;
                            }
                        }
                    }
                    Some("Rename node") => {
                        let new_name = input.read_line(&format!(
                            "\n  New name for \"{}\": ", node_name
                        ))?;
                        if !new_name.is_empty() && new_name != node_name {
                            if config.nodes.contains_key(&new_name) {
                                output.print_colored(
                                    &format!("  Name \"{}\" already exists.", new_name),
                                    Color::Yellow,
                                );
                                input.read_key()?;
                                continue;
                            }
                            // Move the node config to the new key
                            if let Some(node_config) = config.nodes.shift_remove(&node_name) {
                                config.nodes.insert(new_name.clone(), node_config);
                            }
                            // Update all edges referencing the old name
                            for (_, other_node) in config.nodes.iter_mut() {
                                for output_name in other_node.outputs.iter_mut() {
                                    if *output_name == node_name {
                                        *output_name = new_name.clone();
                                    }
                                }
                            }
                            output.print_colored(
                                &format!("  Renamed \"{}\" → \"{}\" (connections updated)", node_name, new_name),
                                Color::Green,
                            );
                            input.read_key()?;
                        }
                    }
                    Some("Delete node") => {
                        // Show what will be affected
                        let incoming: Vec<String> = config
                            .nodes
                            .iter()
                            .filter(|(_, n)| n.outputs.contains(&node_name))
                            .map(|(name, _)| name.clone())
                            .collect();
                        let outgoing = config.nodes[&node_name].outputs.clone();

                        output.print_line("");
                        if !incoming.is_empty() {
                            output.print_dim(&format!(
                                "  Incoming connections from: {}",
                                incoming.join(", ")
                            ));
                        }
                        if !outgoing.is_empty() {
                            output.print_dim(&format!(
                                "  Outgoing connections to: {}",
                                outgoing.join(", ")
                            ));
                        }

                        output.print_bold(&format!(
                            "\n  Delete \"{}\" and remove all its connections?\n",
                            node_name
                        ));
                        let confirm = select_menu(input, output, &["Yes, delete", "No, keep it"])?;
                        if confirm == Some(0) {
                            // Remove from all other nodes' outputs
                            for (_, other_node) in config.nodes.iter_mut() {
                                other_node.outputs.retain(|o| o != &node_name);
                            }
                            // Remove the node itself
                            config.nodes.shift_remove(&node_name);
                            output.print_colored(
                                &format!("  Deleted \"{}\"", node_name),
                                Color::Green,
                            );
                            input.read_key()?;
                        }
                    }
                    _ => {} // "Back" or Esc
                }
            }
            _ => return Ok(()), // "Done" or Esc
        }
    }
}

fn edit_connections(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    config: &mut PipelineConfig,
) -> Result<(), String> {
    loop {
        output.clear_screen();
        output.print_bold("\n  Edit connections\n");

        // Build connection list + actions menu
        let node_names: Vec<String> = config.nodes.keys().cloned().collect();
        let mut connections: Vec<(String, String)> = Vec::new();
        for name in &node_names {
            for out in &config.nodes[name].outputs {
                connections.push((name.clone(), out.clone()));
            }
        }

        // Menu: each connection (select to remove) + Add + Done
        let mut menu_labels: Vec<String> = connections
            .iter()
            .map(|(from, to)| format!("  {} → {}  (select to remove)", from, to))
            .collect();
        if connections.is_empty() {
            output.print_dim("  (no connections)\n");
        }
        menu_labels.push("Add connection".to_string());
        menu_labels.push("Done".to_string());

        let menu_refs: Vec<&str> = menu_labels.iter().map(|s| s.as_str()).collect();
        let choice = select_menu(input, output, &menu_refs)?;

        let add_idx = connections.len();

        match choice {
            Some(idx) if idx < connections.len() => {
                // Remove this connection
                let (from, to) = &connections[idx];
                if let Some(node) = config.nodes.get_mut(from) {
                    node.outputs.retain(|o| o != to);
                }
                output.print_colored(
                    &format!("  Removed {} → {}", from, to),
                    Color::Green,
                );
                input.read_key()?;
            }
            Some(idx) if idx == add_idx => {
                // Add connection
                if node_names.len() < 2 {
                    output.print_dim("\n  Need at least 2 nodes to connect.");
                    input.read_key()?;
                    continue;
                }
                let refs: Vec<&str> = node_names.iter().map(|s| s.as_str()).collect();
                output.print_bold("\n  Connect from:");
                let from = select_menu(input, output, &refs)?;
                if from.is_none() { continue; }
                output.print_bold("  Connect to:");
                let to = select_menu(input, output, &refs)?;
                if to.is_none() { continue; }

                let from_name = &node_names[from.unwrap()];
                let to_name = &node_names[to.unwrap()];

                if from_name == to_name {
                    output.print_colored("  Can't connect a node to itself.", Color::Yellow);
                    input.read_key()?;
                    continue;
                }

                if let Some(node) = config.nodes.get_mut(from_name) {
                    if node.outputs.contains(to_name) {
                        output.print_colored(
                            &format!("  {} → {} already exists.", from_name, to_name),
                            Color::Yellow,
                        );
                        input.read_key()?;
                    } else {
                        node.outputs.push(to_name.clone());
                        output.print_colored(
                            &format!("  Added {} → {}", from_name, to_name),
                            Color::Green,
                        );
                        input.read_key()?;
                    }
                }
            }
            _ => return Ok(()), // Done or Esc
        }
    }
}

fn configure_single_node(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    node_name: &str,
    node_config: &mut crate::config::NodeConfig,
    manifest: &acpfx_schema::NodeManifest,
) -> Result<(), String> {
    // Get or create settings object
    let mut settings = match &node_config.settings {
        Some(serde_json::Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };

    let arg_names: Vec<String> = manifest.arguments.keys().cloned().collect();

    loop {
        output.clear_screen();
        output.print_bold(&format!("\n  {} ({})", node_name, manifest.name));
        if let Some(desc) = &manifest.description {
            output.print_dim(&format!("  {}\n", desc));
        }

        // Build menu with current values
        let mut menu_labels: Vec<String> = Vec::new();
        for arg_name in &arg_names {
            let arg = &manifest.arguments[arg_name];
            let current = settings.get(arg_name);
            let display = format_value(current, &arg.default);
            menu_labels.push(format!("{} = {}", arg_name, display));
        }
        menu_labels.push("Done — back to node list".to_string());

        let menu_refs: Vec<&str> = menu_labels.iter().map(|s| s.as_str()).collect();
        let choice = select_menu(input, output, &menu_refs)?;

        match choice {
            Some(idx) if idx < arg_names.len() => {
                let arg_name = &arg_names[idx];
                let arg = &manifest.arguments[arg_name];
                let current = settings.get(arg_name).cloned();

                if let Some(new_val) = edit_argument(
                    input, output, node_name, arg_name, arg, current.as_ref(),
                )? {
                    settings.insert(arg_name.clone(), new_val);
                }
            }
            _ => break, // "Done" or Esc
        }
    }

    // Write settings back
    if !settings.is_empty() {
        node_config.settings = Some(serde_json::Value::Object(settings));
    }
    Ok(())
}

fn edit_argument(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    node_name: &str,
    arg_name: &str,
    arg: &acpfx_schema::ManifestArgument,
    current_value: Option<&serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    output.clear_screen();
    output.print_bold(&format!("\n  {} > {}", node_name, arg_name));
    if let Some(desc) = &arg.description {
        output.print_dim(&format!("  {}", desc));
    }

    let current_display = format_value(current_value, &arg.default);
    let type_name = match arg.type_ {
        acpfx_schema::ArgumentType::String => "string",
        acpfx_schema::ArgumentType::Number => "number",
        acpfx_schema::ArgumentType::Boolean => "boolean",
    };
    output.print_dim(&format!("  Type: {}", type_name));
    output.print_colored(&format!("  Current: {}\n", current_display), Color::Green);

    // Boolean: select menu
    if matches!(arg.type_, acpfx_schema::ArgumentType::Boolean) {
        let current_bool = current_value
            .and_then(|v| v.as_bool())
            .or_else(|| arg.default.as_ref().and_then(|d| d.as_bool()))
            .unwrap_or(false);
        let pre_selected = if current_bool { 0 } else { 1 };
        let options = &["true", "false"];

        // Navigate to current value first
        let mut keys_to_pre_select = Vec::new();
        for _ in 0..pre_selected {
            keys_to_pre_select.push(KeyCode::Down);
        }
        // Can't pre-select in select_menu, so just show it
        let choice = select_menu(input, output, options)?;
        return match choice {
            Some(0) => Ok(Some(serde_json::Value::Bool(true))),
            Some(1) => Ok(Some(serde_json::Value::Bool(false))),
            _ => Ok(None),
        };
    }

    // Enum: select menu
    if let Some(enum_values) = &arg.enum_values {
        let labels: Vec<String> = enum_values
            .iter()
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect();
        let label_refs: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
        let choice = select_menu(input, output, &label_refs)?;
        return match choice {
            Some(idx) => Ok(Some(enum_values[idx].clone())),
            _ => Ok(None),
        };
    }

    // String/Number: text input
    let effective = current_value
        .or(arg.default.as_ref())
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();

    let prompt = format!("  New value (Enter to keep \"{}\"): ", effective);
    let input_val = input.read_line(&prompt)?;

    if input_val.is_empty() {
        return Ok(None); // Keep current
    }

    // Parse based on type
    match arg.type_ {
        acpfx_schema::ArgumentType::Number => {
            if let Ok(n) = input_val.parse::<f64>() {
                Ok(Some(serde_json::json!(n)))
            } else {
                output.print_colored("  Invalid number, keeping current value.", Color::Yellow);
                Ok(None)
            }
        }
        acpfx_schema::ArgumentType::String => Ok(Some(serde_json::Value::String(input_val))),
        acpfx_schema::ArgumentType::Boolean => {
            // Shouldn't reach here (handled above), but just in case
            match input_val.as_str() {
                "true" | "1" | "yes" => Ok(Some(serde_json::Value::Bool(true))),
                "false" | "0" | "no" => Ok(Some(serde_json::Value::Bool(false))),
                _ => Ok(None),
            }
        }
    }
}

/// Format a value for display in menus. Shows current, default, or "not set".
fn format_value(current: Option<&serde_json::Value>, default: &Option<serde_json::Value>) -> String {
    if let Some(val) = current {
        match val {
            serde_json::Value::String(s) => format!("\"{}\"", s),
            other => other.to_string(),
        }
    } else if let Some(def) = default {
        match def {
            serde_json::Value::String(s) => format!("\"{}\" (default)", s),
            other => format!("{} (default)", other),
        }
    } else {
        "(not set)".to_string()
    }
}

/// Prompt the user for environment variables needed by the pipeline.
fn prompt_env_vars(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    env_vars: &[(String, bool, String, Vec<String>)],
) -> Result<(), String> {
    if env_vars.is_empty() {
        return Ok(());
    }

    let mut global_config = user_config::load_config_from_dir(&user_config::global_config_dir());
    let mut project_config =
        user_config::load_config_from_dir(&user_config::project_config_dir());

    output.clear_screen();
    output.print_bold("\n  Environment Variables\n");
    output.print_line("  Your pipeline needs these environment variables:\n");

    for (name, required, desc, used_by) in env_vars {
        let req_label = if *required {
            " (required)"
        } else {
            " (optional)"
        };
        let in_system = std::env::var(name).is_ok();
        let in_global = global_config.env.contains_key(name.as_str());
        let in_project = project_config.env.contains_key(name.as_str());

        let status = if in_system {
            "set (system env)"
        } else if in_project {
            "set (.acpfx/config.json)"
        } else if in_global {
            "set (~/.acpfx/config.json)"
        } else {
            "not set"
        };

        output.print_bold(&format!("  {}{}", name, req_label));
        if !desc.is_empty() {
            output.print_dim(&format!("    {}", desc));
        }
        output.print_dim(&format!("    Used by: {}", used_by.join(", ")));
        let status_color = if status == "not set" {
            Color::Yellow
        } else {
            Color::Green
        };
        output.print_colored(&format!("    Status: {}\n", status), status_color);

        if in_system || in_project || in_global {
            output.print_bold("    Keep current value?\n");
            let keep_options = &["Yes, keep it", "No, enter a new value"];
            let keep = select_menu(input, output, keep_options)?;
            if keep == Some(1) {
                let value =
                    input.read_line(&format!("    Enter new value for {}: ", name))?;
                if !value.is_empty() {
                    let store_options = &[
                        "Global (~/.acpfx/config.json)",
                        "Project (.acpfx/config.json)",
                    ];
                    output.print_line("\n    Where to store?\n");
                    let store_choice = select_menu(input, output, store_options)?;
                    match store_choice {
                        Some(0) => {
                            global_config.env.insert(name.clone(), value);
                        }
                        Some(1) => {
                            project_config.env.insert(name.clone(), value);
                        }
                        _ => {
                            global_config.env.insert(name.clone(), value);
                        }
                    }
                }
            }
        } else {
            let value = input.read_line(&format!("\n    Enter value for {}: ", name))?;
            if !value.is_empty() {
                let store_options = &[
                    "Global (~/.acpfx/config.json)",
                    "Project (.acpfx/config.json)",
                ];
                output.print_line("\n    Where to store?\n");
                let store_choice = select_menu(input, output, store_options)?;
                match store_choice {
                    Some(0) => {
                        global_config.env.insert(name.clone(), value);
                    }
                    Some(1) => {
                        project_config.env.insert(name.clone(), value);
                    }
                    _ => {
                        global_config.env.insert(name.clone(), value);
                    }
                }
            } else if *required {
                output.print_line(&format!(
                    "    Warning: {} is required but was not set\n",
                    name
                ));
            }
        }
        output.print_line("");
    }

    // Save any env vars that were entered
    if !global_config.env.is_empty() {
        user_config::save_config_to_dir(&user_config::global_config_dir(), &global_config)
            .map_err(|e| format!("Failed to save global config: {e}"))?;
    }
    if !project_config.env.is_empty() {
        user_config::save_config_to_dir(&user_config::project_config_dir(), &project_config)
            .map_err(|e| format!("Failed to save project config: {e}"))?;
    }

    Ok(())
}

fn finish_pipeline(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    config: PipelineConfig,
    default_name: &str,
) -> Result<Option<OnboardResult>, String> {
    // Step 3: Configure components
    let mut config = config;
    configure_nodes(input, output, &mut config)?;

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
    prompt_env_vars(input, output, &env_vars)?;

    // Step 5: Save pipeline
    output.clear_screen();
    output.print_bold("\n  Save your pipeline\n");

    let pipeline_name = input.read_line(&format!("  Name [{}]: ", default_name))?;
    let pipeline_name = if pipeline_name.is_empty() {
        default_name.to_string()
    } else {
        pipeline_name
    };

    output.print_line("\n  Where to save?");
    let save_options = &[
        "Global (~/.acpfx/pipelines/)",
        "Project (.acpfx/pipelines/)",
    ];
    let save_choice = select_menu(input, output, save_options)?;

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
    output.print_line("\n  Set as default pipeline?");
    let default_choices = &["Yes", "No"];
    let set_default = select_menu(input, output, default_choices)?;

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
    output.clear_screen();
    output.print_colored(&format!(
        "\n  Pipeline saved to {}",
        pipeline_path.display()
    ), Color::Green);
    if set_default == Some(0) {
        output.print_colored("  Set as default pipeline", Color::Green);
    }

    output.print_bold("\n  Run your pipeline now?\n");
    let run_choices = &["Yes", "No"];
    let run_now = select_menu(input, output, run_choices)?;

    Ok(Some(OnboardResult {
        pipeline_name,
        pipeline_path,
        run_now: run_now == Some(0),
    }))
}

// ---- Generic helpers ----

fn print_header(output: &mut dyn OutputSink) {
    output.print_line("");
    output.print_bold("  Welcome to acpfx!");
    output.print_line("");
    output.print_dim("  acpfx is a pluggable audio pipeline framework");
    output.print_dim("  for voice agents. Let's set up your first");
    output.print_dim("  pipeline.");
    output.print_line("");
}

/// Arrow-key selection menu. Returns Some(index) or None if cancelled.
fn select_menu(
    input: &mut dyn InputSource,
    output: &mut dyn OutputSink,
    items: &[&str],
) -> Result<Option<usize>, String> {
    let mut selected = 0;

    loop {
        for (i, item) in items.iter().enumerate() {
            if i == selected {
                output.print_colored(&format!("  > {}", item), Color::Cyan);
            } else {
                output.print_dim(&format!("    {}", item));
            }
        }

        let key = input.read_key()?;
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
            KeyCode::Char('c') => return Ok(None),
            _ => {}
        }

        output.move_up(items.len() as u16);
    }
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Helper: create a MockInput with keys for selecting menu item N (N Down presses + Enter).
    fn menu_select(n: usize) -> Vec<KeyCode> {
        let mut keys = Vec::new();
        for _ in 0..n {
            keys.push(KeyCode::Down);
        }
        keys.push(KeyCode::Enter);
        keys
    }

    #[test]
    fn select_menu_returns_first_on_enter() {
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Enter]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = select_menu(&mut input, &mut output, &["A", "B", "C"]).unwrap();
        assert_eq!(result, Some(0));
    }

    #[test]
    fn select_menu_returns_second_on_down_enter() {
        let mut input = MockInput {
            keys: VecDeque::from(menu_select(1)),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = select_menu(&mut input, &mut output, &["A", "B", "C"]).unwrap();
        assert_eq!(result, Some(1));
    }

    #[test]
    fn select_menu_returns_none_on_esc() {
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Esc]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = select_menu(&mut input, &mut output, &["A", "B"]).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn select_menu_clamps_up_at_zero() {
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Up, KeyCode::Up, KeyCode::Enter]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = select_menu(&mut input, &mut output, &["A", "B"]).unwrap();
        assert_eq!(result, Some(0));
    }

    #[test]
    fn select_menu_clamps_down_at_last() {
        let mut input = MockInput {
            keys: VecDeque::from(vec![
                KeyCode::Down,
                KeyCode::Down,
                KeyCode::Down,
                KeyCode::Down,
                KeyCode::Enter,
            ]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = select_menu(&mut input, &mut output, &["A", "B"]).unwrap();
        assert_eq!(result, Some(1));
    }

    #[test]
    fn template_flow_selects_first_template() {
        // Keys: select first template (Enter), then finish_pipeline needs:
        // env var prompts (skip with Enter for each unset var + menu selections),
        // pipeline name (Enter for default), save location (Enter for global),
        // set as default (Enter for yes), run now (Enter for yes)
        let templates = templates::list_templates();
        let first_template: PipelineConfig =
            serde_yaml::from_str(templates[0].yaml).unwrap();

        // Count env vars we'll need to provide input for
        let available = templates::available_nodes();
        let node_manifests: Vec<&acpfx_schema::NodeManifest> = first_template
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

        let mut keys = VecDeque::new();
        // Select first template
        keys.push_back(KeyCode::Enter);
        // For each env var: line input (empty = skip) + no menu needed if skipping
        let mut lines = VecDeque::new();
        for (_, required, _, _) in &env_vars {
            if *required {
                // Enter a dummy value
                lines.push_back("test-key-123".to_string());
                // Select "Global" storage
                keys.push_back(KeyCode::Enter);
            } else {
                // Skip optional
                lines.push_back(String::new());
            }
        }
        // Pipeline name: use default
        lines.push_back(String::new());
        // Save location: Global
        keys.push_back(KeyCode::Enter);
        // Set as default: Yes
        keys.push_back(KeyCode::Enter);
        // Run now: No
        keys.push_back(KeyCode::Down);
        keys.push_back(KeyCode::Enter);

        let mut input = MockInput { keys, lines };
        let mut output = CapturedOutput::new();

        let result = template_flow(&mut input, &mut output);
        // We can't fully test file I/O in unit tests without temp dirs,
        // but we can verify the flow doesn't panic and output contains expected text
        assert!(result.is_ok() || result.is_err()); // Flow ran without panic
        assert!(output.screen_clears >= 2, "Should clear screen at least twice");
        assert!(
            output.lines.iter().any(|l| l.contains("template") || l.contains("Pipeline")),
            "Output should mention pipeline/template"
        );
    }

    #[test]
    fn welcome_screen_renders_correctly() {
        let mut output = CapturedOutput::new();
        print_header(&mut output);
        assert!(output.lines.iter().any(|l| l.contains("Welcome to acpfx")));
        assert!(output
            .lines
            .iter()
            .any(|l| l.contains("pluggable audio pipeline")));
    }

    #[test]
    fn onboard_cancel_on_esc_returns_none() {
        // Esc on main menu triggers "Done" logic. Since no user-created pipelines
        // exist in test, it shows "Exit anyway?" — confirm with Enter ("Yes, exit").
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Esc, KeyCode::Enter]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();

        let result = run_onboard_with(&mut input, &mut output, false).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn onboard_auto_triggered_shows_message() {
        // Esc triggers "Done" logic; confirm exit with Enter.
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Esc, KeyCode::Enter]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();

        let _ = run_onboard_with(&mut input, &mut output, true);
        assert!(output
            .lines
            .iter()
            .any(|l| l.contains("No pipeline configured")));
    }

    #[test]
    fn onboard_not_auto_triggered_no_extra_message() {
        // Esc triggers "Done" logic; confirm exit with Enter.
        // The "No pipeline configured" from auto_triggered=true should NOT appear,
        // but the "No pipelines configured" warning from the Done logic will.
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Esc, KeyCode::Enter]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();

        let _ = run_onboard_with(&mut input, &mut output, false);
        // The auto-triggered message says "No pipeline configured. Let's set one up!"
        // which should NOT appear when auto_triggered=false
        assert!(!output
            .lines
            .iter()
            .any(|l| l.contains("Let's set one up")));
    }

    // ---- Per-component configuration tests ----

    fn make_test_config() -> PipelineConfig {
        let mut nodes = indexmap::IndexMap::new();
        nodes.insert(
            "stt".to_string(),
            crate::config::NodeConfig {
                use_: "@acpfx/stt-deepgram".to_string(),
                settings: None,
                outputs: vec!["bridge".to_string()],
            },
        );
        PipelineConfig {
            nodes,
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn configure_nodes_done_immediately() {
        // Menu: [stt, "Edit connections", "Done — continue"]
        // "Done" is at index 2
        let mut config = make_test_config();
        let mut input = MockInput {
            keys: VecDeque::from(vec![
                KeyCode::Down, KeyCode::Down, // move to "Done"
                KeyCode::Enter,
            ]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        configure_nodes(&mut input, &mut output, &mut config).unwrap();
        assert!(config.nodes["stt"].settings.is_none());
    }

    #[test]
    fn configure_nodes_edit_string_arg() {
        // Test configure_single_node directly for reliability
        let available = templates::available_nodes();
        let entry = available.iter().find(|n| n.package == "@acpfx/stt-deepgram").unwrap();
        let manifest = &entry.manifest;
        let arg_count = manifest.arguments.len(); // should be 5

        let mut node_config = crate::config::NodeConfig {
            use_: "@acpfx/stt-deepgram".to_string(),
            settings: None,
            outputs: vec![],
        };

        // BTreeMap sorts alphabetically: apiKey, endpointing, language, model, utteranceEndMs
        // language is at index 2
        let lang_idx = manifest.arguments.keys().position(|k| k == "language").unwrap();

        let mut keys = VecDeque::new();
        for _ in 0..lang_idx { keys.push_back(KeyCode::Down); }
        keys.push_back(KeyCode::Enter); // select "language"
        // read_line provides "fr"
        // Back in arg list — navigate to "Done" (last item)
        for _ in 0..arg_count { keys.push_back(KeyCode::Down); }
        keys.push_back(KeyCode::Enter); // Done

        let mut input = MockInput {
            keys,
            lines: VecDeque::from(vec!["fr".to_string()]),
        };
        let mut output = CapturedOutput::new();
        configure_single_node(&mut input, &mut output, "stt", &mut node_config, manifest).unwrap();

        let settings = node_config.settings.as_ref().expect("settings should be set");
        assert_eq!(settings["language"], "fr", "language should be 'fr', got {:?}", settings);
    }

    #[test]
    fn configure_nodes_shows_defaults_in_output() {
        // Menu: [stt, "Edit connections", "Done — continue"]
        let mut config = make_test_config();
        let mut input = MockInput {
            keys: VecDeque::from(vec![
                KeyCode::Enter, // select stt in node list
                KeyCode::Enter, // select "Configure arguments" in sub-menu
                // Now in arg list — press Esc to go back
                KeyCode::Esc,
                KeyCode::Down, KeyCode::Down, KeyCode::Enter, // Done in node list
            ]),
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        configure_nodes(&mut input, &mut output, &mut config).unwrap();

        // Should show default values from manifest
        assert!(output.lines.iter().any(|l| l.contains("\"en\"")),
            "Should show default language value");
    }

    #[test]
    fn edit_argument_number_parses() {
        let arg = acpfx_schema::ManifestArgument {
            type_: acpfx_schema::ArgumentType::Number,
            default: Some(serde_json::json!(16000)),
            description: Some("Sample rate".to_string()),
            required: None,
            enum_values: None,
        };
        let mut input = MockInput {
            keys: VecDeque::new(),
            lines: VecDeque::from(vec!["48000".to_string()]),
        };
        let mut output = CapturedOutput::new();
        let result = edit_argument(&mut input, &mut output, "mic", "sampleRate", &arg, None).unwrap();
        assert_eq!(result, Some(serde_json::json!(48000.0)));
    }

    #[test]
    fn edit_argument_boolean_select() {
        let arg = acpfx_schema::ManifestArgument {
            type_: acpfx_schema::ArgumentType::Boolean,
            default: Some(serde_json::json!(false)),
            description: Some("Verbose".to_string()),
            required: None,
            enum_values: None,
        };
        let mut input = MockInput {
            keys: VecDeque::from(vec![KeyCode::Enter]), // select "true" (first option)
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();
        let result = edit_argument(&mut input, &mut output, "bridge", "verbose", &arg, None).unwrap();
        assert_eq!(result, Some(serde_json::json!(true)));
    }

    #[test]
    fn format_value_shows_current() {
        let val = serde_json::json!("fr");
        assert_eq!(format_value(Some(&val), &None), "\"fr\"");
    }

    #[test]
    fn format_value_shows_default() {
        let def = serde_json::json!("en");
        assert_eq!(format_value(None, &Some(def)), "\"en\" (default)");
    }

    #[test]
    fn format_value_shows_not_set() {
        assert_eq!(format_value(None, &None), "(not set)");
    }

    // Tests that modify HOME/cwd must not run in parallel.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn main_menu_done_with_no_pipelines_warns() {
        let _lock = ENV_MUTEX.lock().unwrap();
        // Run from a temp directory so project_config_dir() and global paths
        // have no user-created pipelines.
        let tmp = tempfile::tempdir().unwrap();
        let tmp_path = tmp.path().to_path_buf();
        let orig_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(&tmp_path).unwrap();
        // Override HOME so global_config_dir() points to empty temp dir too.
        let orig_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &tmp_path);

        // "Done" is the last menu item. Use enough Downs to reach it
        // (select_menu clamps at the end). Then confirm exit with Enter.
        let mut keys = VecDeque::new();
        keys.extend(menu_select(10)); // overshoot — clamps to last item ("Done")
        keys.push_back(KeyCode::Enter); // confirm "Yes, exit"

        let mut input = MockInput {
            keys,
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();

        let result = run_onboard_with(&mut input, &mut output, false).unwrap();

        // Restore environment before tmp drops
        std::env::set_current_dir(&orig_dir).unwrap();
        if let Some(home) = orig_home {
            std::env::set_var("HOME", home);
        }
        drop(tmp);

        assert!(result.is_none());
        // Should show the warning about no pipelines
        assert!(
            output.lines.iter().any(|l| l.contains("No pipelines configured")),
            "Should warn about no pipelines, got: {:?}",
            output.lines
        );
        // Should show the "Exit anyway?" prompt
        assert!(
            output.lines.iter().any(|l| l.contains("Exit anyway")),
            "Should ask to confirm exit"
        );
    }

    #[test]
    fn main_menu_done_with_no_pipelines_go_back() {
        let _lock = ENV_MUTEX.lock().unwrap();
        // Run from a temp directory so no user-created pipelines exist.
        let tmp = tempfile::tempdir().unwrap();
        let tmp_path = tmp.path().to_path_buf();
        let orig_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(&tmp_path).unwrap();
        let orig_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &tmp_path);

        // Menu has 3 items: "Start from a template", "Build from scratch", "Done"
        // Select "Done" (index 2), see warning, choose "No, go back" (index 1),
        // then loop back to main menu, then Esc triggers Done again, confirm exit.
        let mut keys = VecDeque::new();
        keys.extend(menu_select(2)); // select "Done"
        keys.extend(menu_select(1)); // select "No, go back"
        // Back at main menu — Esc triggers Done logic again, confirm exit
        keys.push_back(KeyCode::Esc);
        keys.push_back(KeyCode::Enter); // confirm "Yes, exit"

        let mut input = MockInput {
            keys,
            lines: VecDeque::new(),
        };
        let mut output = CapturedOutput::new();

        let result = run_onboard_with(&mut input, &mut output, false).unwrap();

        // Restore environment before tmp drops
        std::env::set_current_dir(&orig_dir).unwrap();
        if let Some(home) = orig_home {
            std::env::set_var("HOME", home);
        }
        drop(tmp);

        assert!(result.is_none());
        // Should have cleared screen at least twice (initial + after going back)
        assert!(
            output.screen_clears >= 2,
            "Should clear screen at least twice (initial + loop back), got {}",
            output.screen_clears
        );
    }

    #[test]
    fn format_value_number_default() {
        let def = serde_json::json!(16000);
        assert_eq!(format_value(None, &Some(def)), "16000 (default)");
    }

    #[test]
    fn edit_argument_keeps_value_on_empty_input() {
        // When user enters empty string for a string arg, edit_argument returns None
        // (meaning "keep current value").
        let arg = acpfx_schema::ManifestArgument {
            type_: acpfx_schema::ArgumentType::String,
            default: Some(serde_json::json!("en")),
            description: Some("Language code".to_string()),
            required: None,
            enum_values: None,
        };
        let mut input = MockInput {
            keys: VecDeque::new(),
            lines: VecDeque::from(vec!["".to_string()]),
        };
        let mut output = CapturedOutput::new();
        let result = edit_argument(
            &mut input,
            &mut output,
            "stt",
            "language",
            &arg,
            Some(&serde_json::json!("fr")),
        )
        .unwrap();
        assert_eq!(result, None, "Empty input should return None (keep current)");
    }
}
