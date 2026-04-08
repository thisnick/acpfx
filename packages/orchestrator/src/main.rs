//! acpfx CLI — Rust orchestrator for DAG-based audio pipelines.

mod config;
mod dag;
mod node_runner;
mod onboard;
mod orchestrator;
mod pipeline_resolver;
mod templates;
mod ui;
mod ui_widgets;
mod user_config;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "acpfx", bin_name = "acpfx", version, about = "Observable audio pipeline framework")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a pipeline
    Run {
        /// Pipeline name or path (resolved via .acpfx/pipelines/, ~/.acpfx/pipelines/, etc.)
        #[arg(index = 1)]
        pipeline: Option<String>,

        /// Explicit path to YAML config file (overrides positional name)
        #[arg(long)]
        config: Option<String>,

        /// Path to dist directory (for node resolution)
        #[arg(long, default_value = "dist")]
        dist: String,

        /// Timeout (ms) for each node to emit lifecycle.ready
        #[arg(long, default_value_t = 10000)]
        ready_timeout: u64,

        /// Disable terminal dashboard UI (UI is on by default)
        #[arg(long)]
        headless: bool,

        /// Timeout (ms) for node setup phase (model downloads, etc.)
        #[arg(long, default_value_t = 600000)]
        setup_timeout: u64,

        /// Skip the setup check phase
        #[arg(long)]
        skip_setup: bool,

        /// Show verbose log panel in the dashboard UI
        #[arg(long)]
        verbose: bool,
    },

    /// Show or modify configuration
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
    },

    /// List available pipelines
    Pipelines {
        #[command(subcommand)]
        action: Option<PipelinesAction>,
    },

    /// Interactive setup for first-time users
    Onboard,
}

#[derive(Subcommand)]
enum PipelinesAction {
    /// Interactive pipeline builder
    Create,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Set a config value
    Set {
        /// Key (e.g., "defaultPipeline" or "env.DEEPGRAM_API_KEY")
        key: String,
        /// Value
        value: String,
        /// Set in global config (~/.acpfx/) instead of project (.acpfx/)
        #[arg(long)]
        global: bool,
    },
    /// Get a config value
    Get {
        /// Key (e.g., "defaultPipeline" or "env.DEEPGRAM_API_KEY")
        key: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            pipeline,
            config,
            dist,
            ready_timeout,
            headless,
            setup_timeout,
            skip_setup,
            verbose,
        } => {
            // Resolve pipeline path
            let config_path = if let Some(name) = config.or(pipeline) {
                // Positional arg: resolve via pipeline_resolver
                pipeline_resolver::resolve_pipeline(&name).unwrap_or_else(|e| {
                    eprintln!("[acpfx] {e}");
                    std::process::exit(1);
                })
            } else {
                // No args: check defaultPipeline in config
                let merged = user_config::load_merged_config();
                if let Some(default) = merged.default_pipeline() {
                    pipeline_resolver::resolve_pipeline(default).unwrap_or_else(|e| {
                        eprintln!("[acpfx] {e}");
                        std::process::exit(1);
                    })
                } else {
                    // No default pipeline — auto-trigger onboarding
                    match onboard::run_onboard(true) {
                        Ok(Some(result)) if result.run_now => result.pipeline_path,
                        Ok(Some(_)) => {
                            eprintln!("[acpfx] Pipeline saved. Run it with: acpfx run");
                            std::process::exit(0);
                        }
                        Ok(None) => {
                            eprintln!("[acpfx] Onboarding finished.");
                            std::process::exit(0);
                        }
                        Err(e) => {
                            eprintln!("[acpfx] Onboarding error: {e}");
                            std::process::exit(1);
                        }
                    }
                }
            };

            let dist_path = PathBuf::from(&dist)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(&dist));

            if headless {
                eprintln!("[acpfx] Loading config: {}", config_path.display());
            }

            let mut orch =
                orchestrator::Orchestrator::from_file(&config_path, &dist_path)
                    .unwrap_or_else(|e| {
                        eprintln!("[acpfx] Fatal: {e}");
                        std::process::exit(1);
                    });

            // Merge env vars from user config (global + project) into the pipeline
            let merged_config = user_config::load_merged_config();
            let user_env = user_config::build_node_env(&merged_config, &Default::default());
            orch.merge_env(user_env);

            orch.set_ready_timeout(ready_timeout);
            orch.set_setup_timeout(setup_timeout);
            orch.set_skip_setup(skip_setup);

            // Handle SIGINT for clean shutdown
            let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
            let shutdown_tx_ui = shutdown_tx.clone();
            tokio::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                let _ = shutdown_tx.send(()).await;
            });

            if headless {
                eprintln!("[acpfx] Starting pipeline...");
            }
            if let Err(e) = orch.start().await {
                eprintln!("[acpfx] Fatal: {e}");
                orch.stop().await;
                std::process::exit(1);
            }

            if headless {
                eprintln!("[acpfx] All nodes ready");
            }

            if !headless {
                // UI mode: create shared state, spawn UI thread, feed events
                let manifests = orch.get_manifests();
                let ui_controls = orch.get_ui_controls().clone();
                let ui_state = ui::create_ui_state(&manifests);
                let ui_state_render = ui_state.clone();

                // Create UI action channel for UI -> orchestrator communication
                let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<ui_widgets::UiAction>();

                // Spawn the ratatui rendering loop on a dedicated thread
                let ui_thread = std::thread::spawn(move || {
                    if let Err(e) = ui::run_ui(ui_state_render, verbose, &ui_controls, cmd_tx) {
                        ui::restore_terminal();
                        eprintln!("[acpfx] UI error: {e}");
                    }
                    // UI exited (user pressed q or ctrl+c in UI) — signal shutdown
                    let _ = shutdown_tx_ui.blocking_send(());
                });

                // Run routing loop, pushing events to shared UI state
                let ui_state_events = ui_state.clone();
                tokio::select! {
                    _ = orch.run_with_ui(move |event| {
                        if let Ok(mut s) = ui_state_events.lock() {
                            s.handle_event(event);
                        }
                    }, Some(cmd_rx)) => {}
                    _ = shutdown_rx.recv() => {}
                }

                orch.stop().await;
                ui::restore_terminal();
                // Wait for UI thread to finish
                let _ = ui_thread.join();
            } else {
                // Headless mode: log events to stderr
                let start_time = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                tokio::select! {
                    _ = orch.run(|event| {
                        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                        let from = event.get("_from").and_then(|f| f.as_str()).unwrap_or("?");
                        let ts = event.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);

                        // Skip noisy events
                        if event_type == "audio.chunk" || event_type == "audio.level" {
                            return;
                        }

                        if event_type == "log" {
                            let component = event.get("component").and_then(|c| c.as_str()).unwrap_or(from);
                            let level = event.get("level").and_then(|l| l.as_str()).unwrap_or("info");
                            let message = event.get("message").and_then(|m| m.as_str()).unwrap_or("");
                            let level_tag = if level == "error" { "ERROR " } else { "" };
                            eprintln!("[{component}] {level_tag}{message}");
                            return;
                        }

                        let elapsed = if ts > start_time {
                            format!("+{}ms", ts - start_time)
                        } else {
                            String::new()
                        };
                        eprintln!("[{from}] {elapsed} {event_type}");
                    }) => {}
                    _ = shutdown_rx.recv() => {
                        eprintln!("[acpfx] Shutting down...");
                    }
                }

                orch.stop().await;
            }

            std::process::exit(0);
        }

        Commands::Config { action } => {
            match action {
                None => {
                    // Show merged config
                    let merged = user_config::load_merged_config();
                    println!("# Global (~/.acpfx/config.json)");
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&merged.global).unwrap_or_default()
                    );
                    println!("\n# Project (.acpfx/config.json)");
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&merged.project).unwrap_or_default()
                    );
                }
                Some(ConfigAction::Set { key, value, global }) => {
                    let dir = if global {
                        user_config::global_config_dir()
                    } else {
                        user_config::project_config_dir()
                    };
                    let mut config = user_config::load_config_from_dir(&dir);
                    if let Err(e) = user_config::set_config_value(&mut config, &key, &value) {
                        eprintln!("[acpfx] {e}");
                        std::process::exit(1);
                    }
                    if let Err(e) = user_config::save_config_to_dir(&dir, &config) {
                        eprintln!("[acpfx] {e}");
                        std::process::exit(1);
                    }
                    let scope = if global { "global" } else { "project" };
                    println!("Set {key} = {value} ({scope})");
                }
                Some(ConfigAction::Get { key }) => {
                    let merged = user_config::load_merged_config();
                    match merged.get(&key) {
                        Some(val) => println!("{val}"),
                        None => {
                            eprintln!("(not set)");
                            std::process::exit(1);
                        }
                    }
                }
            }
        }

        Commands::Pipelines { action } => match action {
            None => {
                let pipelines = pipeline_resolver::list_pipelines();
                if pipelines.is_empty() {
                    println!("No pipelines found.");
                    println!("Run 'acpfx onboard' to create your first pipeline.");
                } else {
                    let merged = user_config::load_merged_config();
                    let default = merged.default_pipeline().map(String::from);
                    for (name, source) in &pipelines {
                        let marker = if default.as_deref() == Some(name.as_str()) {
                            " (default)"
                        } else {
                            ""
                        };
                        println!("  {name:<30} [{source}]{marker}");
                    }
                }
            }
            Some(PipelinesAction::Create) => {
                match onboard::run_onboard(false) {
                    Ok(Some(result)) => {
                        println!("Pipeline '{}' saved to {}", result.pipeline_name, result.pipeline_path.display());
                    }
                    Ok(None) => {
                        eprintln!("Cancelled.");
                    }
                    Err(e) => {
                        eprintln!("[acpfx] Error: {e}");
                        std::process::exit(1);
                    }
                }
            }
        },

        Commands::Onboard => {
            match onboard::run_onboard(false) {
                Ok(Some(result)) => {
                    println!("Pipeline '{}' saved to {}", result.pipeline_name, result.pipeline_path.display());
                    if result.run_now {
                        println!("Run: acpfx run {}", result.pipeline_name);
                    }
                }
                Ok(None) => {
                    eprintln!("Onboarding finished.");
                }
                Err(e) => {
                    eprintln!("[acpfx] Onboarding error: {e}");
                    std::process::exit(1);
                }
            }
        }
    }
}
