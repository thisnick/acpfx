//! Terminal UI — ratatui-based dashboard for the acpfx pipeline.
//!
//! Manifest-driven: each node gets its own bordered block with category-based widgets.
//! No hardcoded node names — layout is determined entirely by manifests.

use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, Mutex};

use crossterm::event::{self, Event, KeyCode, KeyModifiers, MouseEventKind, EnableMouseCapture, DisableMouseCapture};
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
    tool_active: bool,          // tool call in progress
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
                tool_active: false, tool_status: None,
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
            e.split('.').next() == Some(category)
        })
    }
}

// ---- Conversation history ----

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum ConversationEntry {
    Turn {
        prompt: String,
        response: String,
        ttft: Option<u64>,
        had_thinking: bool,
        had_tool: bool,
    },
    Interrupt {
        reason: String,
    },
}

// ---- Shared UI state ----

#[derive(Debug)]
pub struct UiState {
    manifests: Vec<NodeManifest>,
    nodes: BTreeMap<String, PerNodeState>,
    logs: Vec<LogEntry>,
    /// Completed conversation turns and interrupts (agent history).
    conversation: Vec<ConversationEntry>,
    /// Scroll offset for the agent conversation panel.
    agent_scroll: usize,
    /// Whether to auto-scroll the agent panel.
    agent_auto_scroll: bool,
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
        Self {
            manifests,
            nodes,
            logs: Vec::new(),
            conversation: Vec::new(),
            agent_scroll: 0,
            agent_auto_scroll: true,
        }
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
                // Don't overwrite text — partial already has the full accumulation.
                // Final only confirms a segment; the partial text is the best display.
                node.speech.state = "final".into();
            }
            "speech.pause" => {
                node.speech.text = event.get("pendingText").and_then(|v| v.as_str()).unwrap_or("").to_string();
                node.speech.state = "pause".into();
            }

            "agent.submit" => {
                node.interrupted = false; // clear stale interrupt flag on new turn
                // Finalize previous turn into conversation history
                if !node.agent.prompt.is_empty() && node.agent.status != "idle" {
                    self.conversation.push(ConversationEntry::Turn {
                        prompt: node.agent.prompt.clone(),
                        response: node.agent.text.clone(),
                        ttft: node.agent.ttft,
                        had_thinking: node.agent.thinking,
                        had_tool: node.agent.tool_status.is_some(),
                    });
                }
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
                    tool_active: false,
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
                node.agent.tool_active = true;
                node.agent.tool_status = Some("running".into());
            }
            "agent.tool_done" => {
                node.agent.tool_active = false;
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
                // Finalize turn into conversation history
                if !node.agent.prompt.is_empty() {
                    self.conversation.push(ConversationEntry::Turn {
                        prompt: node.agent.prompt.clone(),
                        response: node.agent.text.clone(),
                        ttft: node.agent.ttft,
                        had_thinking: false, // thinking phase is over
                        had_tool: node.agent.tool_status.is_some(),
                    });
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
                let reason = event.get("reason").and_then(|v| v.as_str()).unwrap_or("interrupted").to_string();
                self.conversation.push(ConversationEntry::Interrupt { reason });
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

// ---- Rendering helpers ----

/// Push word-wrapped lines into a Vec, with an indent prefix.
fn push_wrapped_lines(lines: &mut Vec<Line<'static>>, raw_line: &str, max_width: usize, prefix: &str) {
    if raw_line.len() <= max_width {
        lines.push(Line::from(format!("{prefix}{raw_line}")));
    } else {
        let mut pos = 0;
        while pos < raw_line.len() {
            let end = (pos + max_width).min(raw_line.len());
            let break_at = if end < raw_line.len() {
                raw_line[pos..end].rfind(' ').map(|i| pos + i + 1).unwrap_or(end)
            } else {
                end
            };
            lines.push(Line::from(format!("{prefix}{}", &raw_line[pos..break_at])));
            pos = break_at;
        }
    }
}

// ---- Rendering ----

fn render_frame(
    terminal: &mut Terminal<CrosstermBackend<io::Stderr>>,
    state: &UiState,
    verbose: bool,
) -> io::Result<()> {
    terminal.draw(|frame| {
        let num_nodes = state.manifests.len();
        // Each node box gets 3 lines (border top + content + border bottom),
        // except nodes with speech/agent which need more. Use 4 per node + rest for logs.
        let mut constraints: Vec<Constraint> = Vec::new();
        for manifest in &state.manifests {
            if manifest.emits_category("agent") {
                // Agent box gets flexible height to show streamed text
                constraints.push(Constraint::Min(5));
            } else {
                let mut height = 3u16; // minimum: border + 1 line + border
                if manifest.emits_category("speech") { height += 1; }
                constraints.push(Constraint::Length(height));
            }
        }
        // Log panel gets remaining space when verbose, hidden otherwise
        if verbose {
            constraints.push(Constraint::Min(5));
        }

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

            // Agent widget — conversation history + current turn
            if manifest.emits_category("agent") {
                // Render past conversation entries
                for entry in &state.conversation {
                    match entry {
                        ConversationEntry::Turn { prompt, response, ttft, had_tool, .. } => {
                            lines.push(Line::from(Span::styled(
                                format!("> \"{prompt}\""),
                                Style::default().fg(Color::Cyan),
                            )));
                            let max_width = 100usize;
                            for raw_line in response.lines() {
                                push_wrapped_lines(&mut lines, raw_line, max_width, "  ");
                            }
                            let mut meta_parts = Vec::new();
                            if let Some(t) = ttft {
                                meta_parts.push(format!("TTFT: {}ms", t));
                            }
                            if *had_tool {
                                meta_parts.push("tool".into());
                            }
                            if !meta_parts.is_empty() {
                                lines.push(Line::from(Span::styled(
                                    format!("  ({})", meta_parts.join(" | ")),
                                    Style::default().fg(Color::DarkGray),
                                )));
                            }
                            lines.push(Line::from("")); // blank separator
                        }
                        ConversationEntry::Interrupt { reason } => {
                            lines.push(Line::from(Span::styled(
                                format!("--- interrupted: {reason} ---"),
                                Style::default().fg(Color::Yellow),
                            )));
                        }
                    }
                }

                // Render current turn (in-progress)
                if node_state.agent.status != "idle" && node_state.agent.status != "complete" {
                    // Status line
                    let icon = match node_state.agent.status.as_str() {
                        "waiting" => "\u{23F3}",
                        "thinking" => "\u{1F4AD}",
                        "tool" => "\u{1F527}",
                        _ => "\u{25B6}",
                    };
                    let ttft_str = node_state.agent.ttft.map(|t| format!(" \u{00B7} TTFT: {}ms", t)).unwrap_or_default();
                    lines.push(Line::from(format!(
                        "{} {} \u{00B7} {} tok{}",
                        icon, node_state.agent.status, node_state.agent.tokens, ttft_str
                    )));

                    // Current prompt
                    if !node_state.agent.prompt.is_empty() {
                        lines.push(Line::from(Span::styled(
                            format!("> \"{}\"", node_state.agent.prompt),
                            Style::default().fg(Color::Cyan),
                        )));
                    }

                    // Thinking indicator
                    if node_state.agent.thinking {
                        lines.push(Line::from(Span::styled(
                            "  thinking...",
                            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                        )));
                    }

                    // Tool call indicator
                    if node_state.agent.tool_active {
                        lines.push(Line::from(Span::styled(
                            "  \u{1F527} tool call...",
                            Style::default().fg(Color::Yellow),
                        )));
                    }

                    // Streamed response text
                    if !node_state.agent.text.is_empty() {
                        let max_width = 100usize;
                        for raw_line in node_state.agent.text.lines() {
                            push_wrapped_lines(&mut lines, raw_line, max_width, "  ");
                        }
                    }
                } else if state.conversation.is_empty() {
                    lines.push(Line::from(Span::styled(
                        "Waiting for first prompt...",
                        Style::default().fg(Color::DarkGray),
                    )));
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

            // Scroll handling: agent panel uses user-controlled scroll; others auto-scroll
            let content_height = lines.len() as u16;
            let box_height = areas[i].height.saturating_sub(2); // minus borders
            let scroll = if manifest.emits_category("agent") {
                let max_offset = content_height.saturating_sub(box_height) as usize;
                if state.agent_auto_scroll {
                    max_offset as u16
                } else {
                    (state.agent_scroll.min(max_offset)) as u16
                }
            } else {
                content_height.saturating_sub(box_height)
            };
            let paragraph = Paragraph::new(lines).block(block).scroll((scroll, 0));
            frame.render_widget(paragraph, areas[i]);
        }

        // Log panel (only when verbose)
        if verbose {
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
        }
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
/// When `verbose` is false, the log panel is hidden.
pub fn run_ui(state: UiHandle, verbose: bool) -> io::Result<()> {
    enable_raw_mode()?;
    let mut stderr = io::stderr();
    execute!(stderr, EnterAlternateScreen, EnableMouseCapture)?;

    let backend = CrosstermBackend::new(io::stderr());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    loop {
        // Render current state
        {
            let s = state.lock().unwrap();
            render_frame(&mut terminal, &s, verbose)?;
        }

        // Poll for terminal events (with timeout for refresh)
        if event::poll(std::time::Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) => {
                    if key.code == KeyCode::Char('q')
                        || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
                    {
                        break;
                    }
                    // Arrow keys scroll the agent conversation panel
                    match key.code {
                        KeyCode::Up => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_sub(1);
                        }
                        KeyCode::Down => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_add(1);
                        }
                        KeyCode::PageUp => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_sub(10);
                        }
                        KeyCode::PageDown => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_add(10);
                        }
                        KeyCode::End => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = true;
                        }
                        KeyCode::Home => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = 0;
                        }
                        _ => {}
                    }
                }
                Event::Mouse(mouse) => {
                    // Mouse scroll controls agent panel scroll
                    match mouse.kind {
                        MouseEventKind::ScrollUp => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_sub(3);
                        }
                        MouseEventKind::ScrollDown => {
                            let mut s = state.lock().unwrap();
                            s.agent_auto_scroll = false;
                            s.agent_scroll = s.agent_scroll.saturating_add(3);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(io::stderr(), LeaveAlternateScreen, DisableMouseCapture)?;
    Ok(())
}

/// Clean up terminal state (call on shutdown if UI thread panicked).
pub fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stderr(), LeaveAlternateScreen, DisableMouseCapture);
}
