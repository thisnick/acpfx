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

use crate::ui_widgets::{FocusRing, HoldState, InteractiveWidget, ScrollableText, StatusBar, UiAction};

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
    /// Scrollable widget for the agent conversation panel.
    agent_scroll: ScrollableText,
    /// Focus ring for panel navigation (Tab cycling, mouse click focus).
    focus: FocusRing,
    /// Status bar showing node statuses and control indicators.
    status_bar: StatusBar,
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
        // Build focus ring panel list: "agent" if any node emits agent, "logs" if verbose
        let mut panels: Vec<String> = Vec::new();
        if manifests.iter().any(|m| m.emits_category("agent")) {
            panels.push("agent".into());
        }
        panels.push("logs".into());

        Self {
            manifests,
            nodes,
            logs: Vec::new(),
            conversation: Vec::new(),
            agent_scroll: ScrollableText::new("Agent Conversation"),
            focus: FocusRing::new(panels),
            status_bar: StatusBar::new(),
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

            "node.status" => {
                let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
                self.status_bar.set_node_status(from, text);
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
    state: &mut UiState,
    verbose: bool,
) -> io::Result<()> {
    // Build agent conversation lines before entering the draw closure
    // (we need &mut state to update agent_scroll, but the draw closure borrows state)
    let agent_lines = build_agent_lines(state);
    state.agent_scroll.set_lines(agent_lines);

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
        // Status bar (1 line at bottom — always reserve space)
        constraints.push(Constraint::Length(1));

        let areas = Layout::vertical(constraints).split(frame.area());

        // Render each node box
        for (i, manifest) in state.manifests.iter().enumerate() {
            let node_state = state.nodes.get(&manifest.name).cloned().unwrap_or_default();

            // Agent panel is rendered via ScrollableText widget
            if manifest.emits_category("agent") {
                // Update focus area for hit-testing
                state.focus.set_area("agent", areas[i]);
                state.agent_scroll.focused = state.focus.is_focused("agent");
                state.agent_scroll.border_color = if node_state.ready { Color::Green } else { Color::DarkGray };
                state.agent_scroll.title = format!(
                    "{} ({}) {}",
                    manifest.name,
                    manifest.use_,
                    if node_state.done || node_state.ready { "\u{2713}" } else { "?" }
                );
                state.agent_scroll.render(frame, areas[i]);
                continue;
            }

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

            // Non-agent panels auto-scroll to bottom
            let content_height = lines.len() as u16;
            let box_height = areas[i].height.saturating_sub(2); // minus borders
            let scroll = content_height.saturating_sub(box_height);
            let paragraph = Paragraph::new(lines).block(block).scroll((scroll, 0));
            frame.render_widget(paragraph, areas[i]);
        }

        // Log panel (only when verbose)
        if verbose {
            let log_area = areas[num_nodes];
            state.focus.set_area("logs", log_area);
            let log_focused = state.focus.is_focused("logs");
            let log_border_color = if log_focused { Color::Cyan } else { Color::DarkGray };

            let log_block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(log_border_color))
                .title(Line::from(Span::styled(" Logs ", Style::default().add_modifier(Modifier::BOLD))));

            let log_area_height = log_area.height.saturating_sub(2) as usize; // subtract borders
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
            frame.render_widget(log_list, log_area);
        }

        // Status bar via StatusBar widget
        let status_area_idx = if verbose { num_nodes + 1 } else { num_nodes };
        state.status_bar.render(frame, areas[status_area_idx]);
    })?;

    Ok(())
}

/// Build the agent conversation lines from UiState (extracted for reuse with ScrollableText).
fn build_agent_lines(state: &UiState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();

    // Find the agent node state (first node that emits agent events)
    let agent_manifest = state.manifests.iter().find(|m| m.emits_category("agent"));
    let agent_node_state = agent_manifest
        .and_then(|m| state.nodes.get(&m.name))
        .cloned()
        .unwrap_or_default();

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
    if agent_node_state.agent.status != "idle" && agent_node_state.agent.status != "complete" {
        // Status line
        let icon = match agent_node_state.agent.status.as_str() {
            "waiting" => "\u{23F3}",
            "thinking" => "\u{1F4AD}",
            "tool" => "\u{1F527}",
            _ => "\u{25B6}",
        };
        let ttft_str = agent_node_state.agent.ttft.map(|t| format!(" \u{00B7} TTFT: {}ms", t)).unwrap_or_default();
        lines.push(Line::from(format!(
            "{} {} \u{00B7} {} tok{}",
            icon, agent_node_state.agent.status, agent_node_state.agent.tokens, ttft_str
        )));

        // Current prompt
        if !agent_node_state.agent.prompt.is_empty() {
            lines.push(Line::from(Span::styled(
                format!("> \"{}\"", agent_node_state.agent.prompt),
                Style::default().fg(Color::Cyan),
            )));
        }

        // Thinking indicator
        if agent_node_state.agent.thinking {
            lines.push(Line::from(Span::styled(
                "  thinking...".to_string(),
                Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
            )));
        }

        // Tool call indicator
        if agent_node_state.agent.tool_active {
            lines.push(Line::from(Span::styled(
                "  \u{1F527} tool call...".to_string(),
                Style::default().fg(Color::Yellow),
            )));
        }

        // Streamed response text
        if !agent_node_state.agent.text.is_empty() {
            let max_width = 100usize;
            for raw_line in agent_node_state.agent.text.lines() {
                push_wrapped_lines(&mut lines, raw_line, max_width, "  ");
            }
        }
    } else if state.conversation.is_empty() {
        lines.push(Line::from(Span::styled(
            "Waiting for first prompt...".to_string(),
            Style::default().fg(Color::DarkGray),
        )));
    }

    lines
}

// ---- Public API ----

/// Shared handle to push events into the UI.
pub type UiHandle = Arc<Mutex<UiState>>;

/// Initialize the UI state from manifest data.
pub fn create_ui_state(manifest_data: &[(String, String, Vec<String>)]) -> UiHandle {
    Arc::new(Mutex::new(UiState::new(manifest_data)))
}

/// Keybind registration from manifest controls.
struct RegisteredKeybind {
    /// The key code to match.
    key: KeyCode,
    /// The node name that declared this control.
    node: String,
    /// The control ID.
    control_id: String,
    /// Whether this is a hold-to-activate control.
    hold: bool,
}

/// Parse a keybind string (e.g., "space", "m") into a KeyCode.
fn parse_keybind(s: &str) -> Option<KeyCode> {
    match s.to_lowercase().as_str() {
        "space" => Some(KeyCode::Char(' ')),
        s if s.len() == 1 => Some(KeyCode::Char(s.chars().next().unwrap())),
        _ => None,
    }
}

/// Run the terminal UI. Blocks until Ctrl+C or 'q' is pressed.
/// Call from a dedicated thread. Returns when the UI should exit.
/// When `verbose` is false, the log panel is hidden.
pub fn run_ui(
    state: UiHandle,
    verbose: bool,
    ui_controls: &BTreeMap<String, Vec<acpfx_schema::manifest::ManifestControl>>,
    cmd_tx: tokio::sync::mpsc::UnboundedSender<UiAction>,
) -> io::Result<()> {
    enable_raw_mode()?;
    let mut stderr = io::stderr();
    execute!(stderr, EnterAlternateScreen, EnableMouseCapture)?;

    let backend = CrosstermBackend::new(io::stderr());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    // Register keybinds from manifest controls
    let mut keybinds: Vec<RegisteredKeybind> = Vec::new();
    for (node_name, controls) in ui_controls {
        for ctrl in controls {
            if let Some(ref kb_str) = ctrl.keybind {
                if let Some(key) = parse_keybind(kb_str) {
                    keybinds.push(RegisteredKeybind {
                        key,
                        node: node_name.clone(),
                        control_id: ctrl.id.clone(),
                        hold: ctrl.hold.unwrap_or(false),
                    });
                }
            }
        }
    }

    // Hold state for hold-to-activate controls
    let mut hold_states: BTreeMap<String, HoldState> = BTreeMap::new();
    for kb in &keybinds {
        if kb.hold {
            let key = format!("{}:{}", kb.node, kb.control_id);
            hold_states.insert(key, HoldState::new(600)); // >500ms to cover macOS initial key repeat delay
        }
    }

    // Populate status bar control indicators from manifest controls
    {
        let mut indicators: Vec<String> = Vec::new();
        for (node_name, controls) in ui_controls {
            for ctrl in controls {
                if let Some(ref kb_str) = ctrl.keybind {
                    let label = ctrl.label.as_deref().unwrap_or(&ctrl.id);
                    let hold_tag = if ctrl.hold.unwrap_or(false) { " (hold)" } else { "" };
                    indicators.push(format!("{}: {}{}", kb_str, label, hold_tag));
                    let _ = node_name; // used for context, indicator is keybind-focused
                }
            }
        }
        let mut s = state.lock().unwrap();
        s.status_bar.set_controls(indicators);
    }

    loop {
        // Render current state
        {
            let mut s = state.lock().unwrap();
            render_frame(&mut terminal, &mut s, verbose)?;
        }

        // Check hold timeouts (deactivate if key was released)
        for (key, hold) in &mut hold_states {
            if hold.check_timeout() {
                // Key released — deactivate (mute)
                let parts: Vec<&str> = key.splitn(2, ':').collect();
                if parts.len() == 2 {
                    let _ = cmd_tx.send(UiAction::ControlToggle {
                        node: parts[0].to_string(),
                        control_id: parts[1].to_string(),
                        value: true, // hold released = muted=true (re-mute)
                    });
                }
            }
        }

        // Poll for terminal events (with timeout for refresh)
        if event::poll(std::time::Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) => {
                    if key.code == KeyCode::Char('q')
                        || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
                    {
                        let _ = cmd_tx.send(UiAction::Quit);
                        break;
                    }

                    // Check manifest keybinds
                    let mut handled = false;
                    for kb in &keybinds {
                        if key.code == kb.key {
                            if kb.hold {
                                let hold_key = format!("{}:{}", kb.node, kb.control_id);
                                if let Some(hold) = hold_states.get_mut(&hold_key) {
                                    if hold.on_press() {
                                        // Push-to-talk: hold to unmute, release to mute
                                        let _ = cmd_tx.send(UiAction::ControlToggle {
                                            node: kb.node.clone(),
                                            control_id: kb.control_id.clone(),
                                            value: false, // muted=false (unmute while held)
                                        });
                                    }
                                }
                            } else {
                                // Simple toggle — alternate value
                                let _ = cmd_tx.send(UiAction::ControlToggle {
                                    node: kb.node.clone(),
                                    control_id: kb.control_id.clone(),
                                    value: true,
                                });
                            }
                            handled = true;
                            break;
                        }
                    }

                    if !handled {
                        match key.code {
                            KeyCode::Tab => {
                                let mut s = state.lock().unwrap();
                                s.focus.next();
                            }
                            KeyCode::BackTab => {
                                let mut s = state.lock().unwrap();
                                s.focus.prev();
                            }
                            KeyCode::Up | KeyCode::Down | KeyCode::PageUp | KeyCode::PageDown
                            | KeyCode::Home | KeyCode::End => {
                                let mut s = state.lock().unwrap();
                                if s.focus.is_focused("agent") {
                                    s.agent_scroll.handle_key(key);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Event::Mouse(mouse) => {
                    let mut s = state.lock().unwrap();
                    match mouse.kind {
                        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                            if let Some(delta) = FocusRing::scroll_delta(&mouse) {
                                if let Some(panel) = s.focus.panel_at(&mouse) {
                                    if panel == "agent" {
                                        s.agent_scroll.handle_mouse_scroll(delta);
                                    }
                                }
                            }
                        }
                        MouseEventKind::Down(_) => {
                            s.focus.focus_at(&mouse);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_keybind_space() {
        assert_eq!(parse_keybind("space"), Some(KeyCode::Char(' ')));
        assert_eq!(parse_keybind("Space"), Some(KeyCode::Char(' ')));
        assert_eq!(parse_keybind("SPACE"), Some(KeyCode::Char(' ')));
    }

    #[test]
    fn parse_keybind_single_char() {
        assert_eq!(parse_keybind("m"), Some(KeyCode::Char('m')));
        assert_eq!(parse_keybind("M"), Some(KeyCode::Char('m'))); // lowercased
    }

    #[test]
    fn keybind_matches_crossterm_space() {
        // Crossterm sends KeyCode::Char(' ') for space in raw mode.
        // Verify our parsed keybind matches it.
        let parsed = parse_keybind("space").unwrap();
        let crossterm_space = KeyCode::Char(' ');
        assert_eq!(parsed, crossterm_space, "parsed keybind should match crossterm Space");
    }

    #[test]
    fn keybind_registration_from_manifest() {
        // Simulate what run_ui does: parse ui_controls into RegisteredKeybind
        let mut controls = std::collections::BTreeMap::new();
        controls.insert("mic".to_string(), vec![
            acpfx_schema::manifest::ManifestControl {
                id: "mute".to_string(),
                type_: acpfx_schema::manifest::ControlType::Toggle,
                label: Some("Mute".to_string()),
                hold: Some(true),
                keybind: Some("space".to_string()),
                event: acpfx_schema::manifest::ControlEventSpec {
                    type_: "custom.mute".to_string(),
                    field: "muted".to_string(),
                },
            },
        ]);

        let mut keybinds: Vec<RegisteredKeybind> = Vec::new();
        for (node_name, ctrls) in &controls {
            for ctrl in ctrls {
                if let Some(ref kb_str) = ctrl.keybind {
                    if let Some(key) = parse_keybind(kb_str) {
                        keybinds.push(RegisteredKeybind {
                            key,
                            node: node_name.clone(),
                            control_id: ctrl.id.clone(),
                            hold: ctrl.hold.unwrap_or(false),
                        });
                    }
                }
            }
        }

        assert_eq!(keybinds.len(), 1);
        assert_eq!(keybinds[0].key, KeyCode::Char(' '));
        assert_eq!(keybinds[0].node, "mic");
        assert_eq!(keybinds[0].control_id, "mute");
        assert!(keybinds[0].hold);

        // Simulate space press matching
        let simulated_key = KeyCode::Char(' ');
        let matched = keybinds.iter().find(|kb| kb.key == simulated_key);
        assert!(matched.is_some(), "Space should match the registered keybind");
    }
}
