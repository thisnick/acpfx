//! acpfx CLI — Rust orchestrator for DAG-based audio pipelines.

mod config;
mod dag;
mod node_runner;
mod orchestrator;
mod ui;

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
    /// Run a pipeline from a YAML config file
    Run {
        /// Path to acpfx YAML config file
        #[arg(long, default_value = "examples/pipeline/elevenlabs.yaml")]
        config: String,

        /// Path to local dist directory for node resolution (debug builds only)
        #[cfg(debug_assertions)]
        #[arg(long, default_value = "dist")]
        dist: String,

        /// Timeout (ms) for each node to emit lifecycle.ready
        #[arg(long, default_value_t = 10000)]
        ready_timeout: u64,

        /// Enable terminal dashboard UI
        #[arg(long)]
        ui: bool,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            config,
            #[cfg(debug_assertions)]
            dist,
            ready_timeout,
            ui: use_ui,
        } => {
            let config_path = PathBuf::from(&config).canonicalize().unwrap_or_else(|e| {
                eprintln!("[acpfx] Cannot find config file '{config}': {e}");
                std::process::exit(1);
            });

            // Debug: resolve from local dist/. Release: always npx.
            #[cfg(debug_assertions)]
            let dist_path = Some(PathBuf::from(&dist).canonicalize().unwrap_or_else(|_| {
                PathBuf::from(&dist)
            }));
            #[cfg(not(debug_assertions))]
            let dist_path: Option<PathBuf> = None;

            if !use_ui {
                eprintln!("[acpfx] Loading config: {}", config_path.display());
            }

            let mut orch =
                orchestrator::Orchestrator::from_file(&config_path, dist_path.as_deref())
                    .unwrap_or_else(|e| {
                        eprintln!("[acpfx] Fatal: {e}");
                        std::process::exit(1);
                    });

            orch.set_ready_timeout(ready_timeout);

            // Handle SIGINT for clean shutdown
            let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
            let shutdown_tx_ui = shutdown_tx.clone();
            tokio::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                let _ = shutdown_tx.send(()).await;
            });

            if !use_ui {
                eprintln!("[acpfx] Starting pipeline...");
            }
            if let Err(e) = orch.start().await {
                eprintln!("[acpfx] Fatal: {e}");
                orch.stop().await;
                std::process::exit(1);
            }

            if !use_ui {
                eprintln!("[acpfx] All nodes ready");
            }

            if use_ui {
                // UI mode: create shared state, spawn UI thread, feed events
                let manifests = orch.get_manifests();
                let ui_state = ui::create_ui_state(&manifests);
                let ui_state_render = ui_state.clone();

                // Spawn the ratatui rendering loop on a dedicated thread
                let ui_thread = std::thread::spawn(move || {
                    if let Err(e) = ui::run_ui(ui_state_render) {
                        ui::restore_terminal();
                        eprintln!("[acpfx] UI error: {e}");
                    }
                    // UI exited (user pressed q or ctrl+c in UI) — signal shutdown
                    let _ = shutdown_tx_ui.blocking_send(());
                });

                // Run routing loop, pushing events to shared UI state
                let ui_state_events = ui_state.clone();
                tokio::select! {
                    _ = orch.run(move |event| {
                        if let Ok(mut s) = ui_state_events.lock() {
                            s.handle_event(event);
                        }
                    }) => {}
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
    }
}
