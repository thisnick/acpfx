//! Terminal UI — ratatui-based dashboard for the acpfx pipeline.
//!
//! Manifest-driven: each node gets its own bordered block with category-based widgets.
//! No hardcoded node names — layout is determined entirely by manifests.

use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, Mutex};

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::execute;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph};
use ratatui::Terminal;

// ---- Per-node state ----

#[derive(Debug, Clone)]
struct NodeAudioState {
    // Real-time level (from audio.level events)
    rms: f64,
    dbfs: f64,
    has_level: bool, // true if we've received audio.level
    // Accumulated chunk stats (from audio.chunk events)
    chunks: u64,
    duration_ms: f64,
}

#[derive(Debug, Clone)]
struct NodeSpeechState {
    text: String,
    state: String, // "partial", "final", "idle"
}

#[derive(Debug, Clone)]
struct NodeAgentState {
    status: String, // "idle", "waiting", "thinking", "tool", "streaming", "complete"
    tokens: u64,
    ttft: Option<u64>,
    submit_ts: Option<u64>,
    first_delta_ts: Option<u64>,
    prompt: String,           // submitted prompt text
    text: String,             // accumulated response text (streamed deltas)
    thinking: bool,           // currently in thinking state
    tool_name: Option<String>,  // active tool call name
    tool_status: Option<String>, // last tool call result
}

#[derive(Debug, Clone)]
struct NodePlayerState {
    playing: Option<String>,
    agent_state: String,
    sfx_active: bool,
}

#[derive(Debug, Clone)]
struct PerNodeState {
    ready: bool,
    done: bool,
    audio: NodeAudioState,
    speech: NodeSpeechState,
    agent: NodeAgentState,
    player: Option<NodePlayerState>,
    interrupted: bool,
    error: Option<String>,
}

impl Default for PerNodeState {
    fn default() -> Self {
        Self {
            ready: false,
            done: false,
            audio: NodeAudioState { rms: 0.0, dbfs: f64::NEG_INFINITY, has_level: false, chunks: 0, duration_ms: 0.0 },
            speech: NodeSpeechState { text: String::new(), state: "idle".into() },
            agent: NodeAgentState {
                status: "idle".into(), tokens: 0, ttft: None,
                submit_ts: None, first_delta_ts: None,
                prompt: String::new(), text: String::new(), thinking: false,
                tool_name: None, tool_status: None,
            },
            player: None,
            interrupted: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
struct LogEntry {
    from: String,
    message: String,
}

// ---- Manifest info ----

#[derive(Debug, Clone)]
struct NodeManifest {
    name: String,
    use_: String,
    emits: Vec<String>,
}

impl NodeManifest {
    fn emits_category(&self, category: &str) -> bool {
        self.emits.iter().any(|e| {
            e.split('.').next().map_or(false, |cat| cat == category)
        })
    }
}

// ---- Shared UI state ----

#[derive(Debug)]
pub struct UiState {
    manifests: Vec<NodeManifest>,
    nodes: BTreeMap<String, PerNodeState>,
    logs: Vec<LogEntry>,
}

impl UiState {
    fn new(manifest_data: &[(String, String, Vec<String>)]) -> Self {
        let mut manifests = Vec::new();
        let mut nodes = BTreeMap::new();
        for (name, use_, emits) in manifest_data {
            manifests.push(NodeManifest {
                name: name.clone(),
                use_: use_.clone(),
                emits: emits.clone(),
            });
            nodes.insert(name.clone(), PerNodeState::default());
        }
        Self { manifests, nodes, logs: Vec::new() }
    }

    /// Process an event from the orchestrator.
    pub fn handle_event(&mut self, event: &serde_json::Value) {
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let from = event.get("_from").and_then(|f| f.as_str()).unwrap_or("?");
        let ts = event.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);

        let node = self.nodes.entry(from.to_string()).or_default();

        match event_type {
            "lifecycle.ready" => node.ready = true,
            "lifecycle.done" => node.done = true,

            "audio.chunk" => {
                node.audio.chunks += 1;
                node.audio.duration_ms += event.get("durationMs").and_then(|v| v.as_f64()).unwrap_or(0.0);
            }

            "audio.level" => {
                node.audio.rms = event.get("rms").and_then(|v| v.as_f64()).unwrap_or(0.0);
                node.audio.dbfs = event.get("dbfs").and_then(|v| v.as_f64()).unwrap_or(f64::NEG_INFINITY);
                node.audio.has_level = true;
            }

            "speech.partial" | "speech.delta" => {
                node.speech.text = event.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                node.speech.state = "partial".into();
                node.interrupted = false; // clear on new speech
            }
            "speech.final" => {
                node.speech.text = event.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                node.speech.state = "final".into();
            }

            "agent.submit" => {
                node.interrupted = false; // clear stale interrupt flag on new turn
                let prompt = event.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                node.agent = NodeAgentState {
                    status: "waiting".into(),
                    tokens: 0,
                    ttft: None,
                    submit_ts: Some(ts),
                    first_delta_ts: None,
                    prompt,
                    text: String::new(),
                    thinking: false,
                    tool_name: None,
                    tool_status: None,
                };
                // Reset audio chunk counters for downstream nodes on new turn
                // (TTS/player chunk counts are per-turn)
                for other in self.nodes.values_mut() {
                    other.audio.chunks = 0;
                    other.audio.duration_ms = 0.0;
                }
            }
            "agent.delta" => {
                node.agent.status = "streaming".into();
                node.agent.thinking = false;
                node.agent.tokens += 1;
                if let Some(delta) = event.get("delta").and_then(|v| v.as_str()) {
                    node.agent.text.push_str(delta);
                }
                if node.agent.first_delta_ts.is_none() {
                    node.agent.first_delta_ts = Some(ts);
                    if let Some(submit) = node.agent.submit_ts {
                        node.agent.ttft = Some(ts.saturating_sub(submit));
                    }
                }
            }
            "agent.thinking" => {
                node.agent.status = "thinking".into();
                node.agent.thinking = true;
            }
            "agent.tool_start" => {
                node.agent.status = "tool".into();
                node.agent.thinking = false;
                // Try title first, fall back to toolCallId (truncated if UUID-like)
                let title = event.get("title")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty() && *s != "undefined");
                let tool_id = event.get("toolCallId")
                    .and_then(|v| v.as_str())
                    .map(|id| if id.len() > 12 { &id[..12] } else { id });
                node.agent.tool_name = title.or(tool_id).map(String::from);
                node.agent.tool_status = Some("running".into());
            }
            "agent.tool_done" => {
                node.agent.tool_status = event.get("status")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or(Some("done".into()));
            }
            "agent.complete" => {
                node.agent.status = "complete".into();
                node.agent.thinking = false;
                if let Some(text) = event.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        node.agent.text = text.to_string();
                    }
                }
            }

            "player.status" => {
                node.player = Some(NodePlayerState {
                    playing: event.get("playing").and_then(|v| v.as_str()).map(String::from),
                    agent_state: event.get("agentState").and_then(|v| v.as_str()).unwrap_or("idle").to_string(),
                    sfx_active: event.get("sfxActive").and_then(|v| v.as_bool()).unwrap_or(false),
                });
            }

            "control.interrupt" => {
                node.interrupted = true;
            }
            "control.error" => {
                node.error = event.get("message").and_then(|v| v.as_str()).map(String::from);
            }

            "log" => {
                let msg = event.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                self.logs.push(LogEntry { from: from.to_string(), message: msg });
                if self.logs.len() > 100 {
                    self.logs.drain(..self.logs.len() - 100);
                }
            }

            _ => {}
        }
    }
}

// ---- Rendering ----

fn render_frame(
    terminal: &mut Terminal<CrosstermBackend<io::Stderr>>,
    state: &UiState,
) -> io::Result<()> {
    terminal.draw(|frame| {
        let num_nodes = state.manifests.len();
        // Each node box gets 3 lines (border top + content + border bottom),
        // except nodes with speech/agent which need more. Use 4 per node + rest for logs.
        let mut constraints: Vec<Constraint> = Vec::new();
        for manifest in &state.manifests {
            let mut height = 3u16; // minimum: border + 1 line + border
            if manifest.emits_category("speech") { height += 1; }
            if manifest.emits_category("agent") { height += 5; } // status + thinking/tool + 3 text lines
            constraints.push(Constraint::Length(height));
        }
        // Log panel gets remaining space, minimum 5 lines
        constraints.push(Constraint::Min(5));

        let areas = Layout::vertical(constraints).split(frame.area());

        // Render each node box
        for (i, manifest) in state.manifests.iter().enumerate() {
            let node_state = state.nodes.get(&manifest.name).cloned().unwrap_or_default();
            let ready_icon = if node_state.done || node_state.ready { "\u{2713}" } else { "?" };
            let border_color = if node_state.ready { Color::Green } else { Color::DarkGray };

            let title = format!(" {} ({}) {} ", manifest.name, manifest.use_, ready_icon);
            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border_color))
                .title(Line::from(Span::styled(title, Style::default().add_modifier(Modifier::BOLD))));

            let mut lines: Vec<Line> = Vec::new();

            // Audio widget — level meter for real-time sources, chunk stats for burst sources
            // Distinguished by manifest: emits audio.level = real-time, only audio.chunk = burst
            if manifest.emits_category("audio") {
                let is_realtime = manifest.emits.iter().any(|e| e == "audio.level");
                if is_realtime {
                    // Real-time audio (mic): show level meter
                    let level = ((node_state.audio.rms / 32768.0) * 20.0).min(20.0) as usize;
                    let filled = "\u{2588}".repeat(level);
                    let empty = "\u{2591}".repeat(20 - level);
                    let db_str = if node_state.audio.dbfs == f64::NEG_INFINITY {
                        "-inf".to_string()
                    } else {
                        format!("{:.0}", node_state.audio.dbfs)
                    };
                    lines.push(Line::from(format!("[{filled}{empty}] {db_str}dB")));
                } else if node_state.audio.chunks > 0 {
                    // Burst audio (TTS/player): show accumulated chunk stats
                    let secs = node_state.audio.duration_ms / 1000.0;
                    lines.push(Line::from(format!(
                        "\u{266B} {} chunks ({:.1}s audio)",
                        node_state.audio.chunks, secs
                    )));
                } else {
                    lines.push(Line::from(Span::styled("idle", Style::default().fg(Color::DarkGray))));
                }
            }

            // Speech widget
            if manifest.emits_category("speech") {
                let text = if node_state.speech.text.is_empty() { "..." } else { &node_state.speech.text };
                lines.push(Line::from(format!("\"{text}\"")));
                if node_state.speech.state != "idle" {
                    lines.push(Line::from(format!(" \u{2514} {}", node_state.speech.state)));
                }
            }

            // Agent widget — status line + thinking/tool/text output
            if manifest.emits_category("agent") {
                let icon = match node_state.agent.status.as_str() {
                    "idle" => "\u{23F9}",
                    "waiting" => "\u{23F3}",
                    "thinking" => "\u{1F4AD}",
                    "tool" => "\u{1F527}",
                    "complete" => "\u{2713}",
                    _ => "\u{25B6}",
                };
                let ttft_str = node_state.agent.ttft.map(|t| format!(" \u{00B7} TTFT: {}ms", t)).unwrap_or_default();
                lines.push(Line::from(format!(
                    "{} {} \u{00B7} {} tok{}",
                    icon, node_state.agent.status, node_state.agent.tokens, ttft_str
                )));

                // Submitted prompt
                if !node_state.agent.prompt.is_empty() {
                    let prompt = if node_state.agent.prompt.len() > 80 {
                        format!("{}...", &node_state.agent.prompt[..80])
                    } else {
                        node_state.agent.prompt.clone()
                    };
                    lines.push(Line::from(vec![
                        Span::styled("  prompt: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(format!("\"{prompt}\""), Style::default().fg(Color::Cyan)),
                    ]));
                }

                // Thinking indicator
                if node_state.agent.thinking {
                    lines.push(Line::from(Span::styled(
                        "  thinking...",
                        Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                    )));
                }

                // Active tool call
                if let Some(ref tool) = node_state.agent.tool_name {
                    let status = node_state.agent.tool_status.as_deref().unwrap_or("running");
                    let color = if status == "completed" { Color::Green }
                        else if status == "failed" { Color::Red }
                        else { Color::Yellow };
                    lines.push(Line::from(vec![
                        Span::styled("  \u{1F527} ", Style::default().fg(Color::DarkGray)),
                        Span::raw(tool.as_str()),
                        Span::styled(format!(" ({status})"), Style::default().fg(color)),
                    ]));
                }

                // Streamed response text — wrap long lines, show last 5 wrapped lines
                if !node_state.agent.text.is_empty() {
                    let max_width = 100usize;
                    let mut wrapped: Vec<String> = Vec::new();
                    for raw_line in node_state.agent.text.lines() {
                        if raw_line.len() <= max_width {
                            wrapped.push(raw_line.to_string());
                        } else {
                            // Word-wrap at max_width
                            let mut pos = 0;
                            while pos < raw_line.len() {
                                let end = (pos + max_width).min(raw_line.len());
                                // Try to break at a space
                                let break_at = if end < raw_line.len() {
                                    raw_line[pos..end].rfind(' ').map(|i| pos + i + 1).unwrap_or(end)
                                } else {
                                    end
                                };
                                wrapped.push(raw_line[pos..break_at].to_string());
                                pos = break_at;
                            }
                        }
                    }
                    let show = 5usize;
                    let total = wrapped.len();
                    let display = if total > show { &wrapped[total - show..] } else { &wrapped[..] };
                    if total > show {
                        lines.push(Line::from(Span::styled("  ...", Style::default().fg(Color::DarkGray))));
                    }
                    for tl in display {
                        lines.push(Line::from(format!("  > {tl}")));
                    }
                }
            }

            // Player widget
            if manifest.emits_category("player") {
                if let Some(ref ps) = node_state.player {
                    let icon = if ps.playing.is_some() { "\u{25B6}" } else { "\u{23F9}" };
                    let playing = ps.playing.as_deref().unwrap_or("idle");
                    let sfx = if ps.sfx_active { format!(" \u{00B7} sfx: {}", ps.agent_state) } else { String::new() };
                    lines.push(Line::from(format!("{icon} {playing}{sfx}")));
                } else {
                    lines.push(Line::from("\u{25B6} idle"));
                }
            }

            // Control widget (alert)
            if node_state.interrupted {
                lines.push(Line::from(Span::styled("Interrupted", Style::default().fg(Color::Yellow))));
            }
            if let Some(ref err) = node_state.error {
                lines.push(Line::from(Span::styled(format!("Error: {err}"), Style::default().fg(Color::Red))));
            }

            // If no category widgets, show a minimal status line
            if lines.is_empty() {
                lines.push(Line::from(if node_state.ready { "ready" } else { "starting..." }));
            }

            let paragraph = Paragraph::new(lines).block(block);
            frame.render_widget(paragraph, areas[i]);
        }

        // Log panel
        let log_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(Line::from(Span::styled(" Logs ", Style::default().add_modifier(Modifier::BOLD))));

        let log_area_height = areas[num_nodes].height.saturating_sub(2) as usize; // subtract borders
        let visible_logs = if state.logs.len() > log_area_height {
            &state.logs[state.logs.len() - log_area_height..]
        } else {
            &state.logs
        };

        let log_items: Vec<ListItem> = visible_logs
            .iter()
            .map(|entry| {
                ListItem::new(Line::from(vec![
                    Span::styled(format!("[{}] ", entry.from), Style::default().fg(Color::DarkGray)),
                    Span::raw(&entry.message),
                ]))
            })
            .collect();

        let log_list = List::new(log_items).block(log_block);
        frame.render_widget(log_list, areas[num_nodes]);
    })?;

    Ok(())
}

// ---- Public API ----

/// Shared handle to push events into the UI.
pub type UiHandle = Arc<Mutex<UiState>>;

/// Initialize the UI state from manifest data.
pub fn create_ui_state(manifest_data: &[(String, String, Vec<String>)]) -> UiHandle {
    Arc::new(Mutex::new(UiState::new(manifest_data)))
}

/// Run the terminal UI. Blocks until Ctrl+C or 'q' is pressed.
/// Call from a dedicated thread. Returns when the UI should exit.
pub fn run_ui(state: UiHandle) -> io::Result<()> {
    enable_raw_mode()?;
    let mut stderr = io::stderr();
    execute!(stderr, EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(io::stderr());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    loop {
        // Render current state
        {
            let s = state.lock().unwrap();
            render_frame(&mut terminal, &s)?;
        }

        // Poll for terminal events (with timeout for refresh)
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.code == KeyCode::Char('q')
                    || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
                {
                    break;
                }
            }
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(io::stderr(), LeaveAlternateScreen)?;
    Ok(())
}

/// Clean up terminal state (call on shutdown if UI thread panicked).
pub fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stderr(), LeaveAlternateScreen);
}
