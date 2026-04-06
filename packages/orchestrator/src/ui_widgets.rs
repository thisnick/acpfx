//! Interactive widget components for the acpfx TUI dashboard.
//!
//! Provides ScrollableText, StatusBar, and FocusRing for keyboard/mouse-driven
//! interaction in the terminal UI.

use crossterm::event::{KeyCode, KeyEvent, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

// ---- UiAction ----

/// Actions sent from the UI thread to the orchestrator.
#[derive(Debug, Clone)]
pub enum UiAction {
    /// Quit the application.
    Quit,
    /// Toggle a manifest-driven control on a specific node.
    ControlToggle {
        /// The node name that declared the control.
        node: String,
        /// The control ID (e.g., "mute").
        control_id: String,
        /// The new value for the toggle.
        value: bool,
    },
}

// ---- InteractiveWidget trait ----

/// Trait for widgets that can handle keyboard and mouse input.
pub trait InteractiveWidget {
    /// Handle a key event while this widget is focused.
    /// Returns an optional UiAction to propagate.
    fn handle_key(&mut self, key: KeyEvent) -> Option<UiAction>;

    /// Handle mouse scroll over this widget.
    fn handle_mouse_scroll(&mut self, delta: i32);

    /// Render the widget into the given area.
    fn render(&self, f: &mut Frame, area: Rect);
}

// ---- ScrollableText ----

/// A scrollable text panel with auto-scroll behavior.
///
/// Auto-scrolls to the bottom when new content is added, unless the user
/// has manually scrolled up.
#[derive(Debug)]
pub struct ScrollableText {
    /// All lines of content.
    pub lines: Vec<Line<'static>>,
    /// Current scroll offset (0 = top).
    pub scroll_offset: usize,
    /// Whether to auto-scroll to bottom on new content.
    pub auto_scroll: bool,
    /// Title for the block border.
    pub title: String,
    /// Border color.
    pub border_color: Color,
    /// Whether this panel is currently focused.
    pub focused: bool,
}

impl ScrollableText {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            lines: Vec::new(),
            scroll_offset: 0,
            auto_scroll: true,
            title: title.into(),
            border_color: Color::DarkGray,
            focused: false,
        }
    }

    /// Replace all lines and optionally auto-scroll.
    pub fn set_lines(&mut self, lines: Vec<Line<'static>>) {
        self.lines = lines;
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    /// Append lines and auto-scroll if enabled.
    pub fn push_lines(&mut self, new_lines: Vec<Line<'static>>) {
        self.lines.extend(new_lines);
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    /// Scroll to the bottom.
    pub fn scroll_to_bottom(&mut self) {
        // scroll_offset is applied during render based on visible height
        self.scroll_offset = usize::MAX;
        self.auto_scroll = true;
    }

    /// Visible height for a given area (minus borders).
    fn visible_height(&self, area: Rect) -> usize {
        area.height.saturating_sub(2) as usize
    }

    /// Clamp scroll offset for a given visible height.
    fn clamped_offset(&self, visible_height: usize) -> usize {
        let max_offset = self.lines.len().saturating_sub(visible_height);
        self.scroll_offset.min(max_offset)
    }
}

impl InteractiveWidget for ScrollableText {
    fn handle_key(&mut self, key: KeyEvent) -> Option<UiAction> {
        match key.code {
            KeyCode::Up => {
                self.auto_scroll = false;
                self.scroll_offset = self.scroll_offset.saturating_sub(1);
                None
            }
            KeyCode::Down => {
                self.auto_scroll = false;
                self.scroll_offset = self.scroll_offset.saturating_add(1);
                None
            }
            KeyCode::PageUp => {
                self.auto_scroll = false;
                self.scroll_offset = self.scroll_offset.saturating_sub(10);
                None
            }
            KeyCode::PageDown => {
                self.auto_scroll = false;
                self.scroll_offset = self.scroll_offset.saturating_add(10);
                None
            }
            KeyCode::Home => {
                self.auto_scroll = false;
                self.scroll_offset = 0;
                None
            }
            KeyCode::End => {
                self.scroll_to_bottom();
                None
            }
            _ => None,
        }
    }

    fn handle_mouse_scroll(&mut self, delta: i32) {
        self.auto_scroll = false;
        if delta < 0 {
            // Scroll up
            self.scroll_offset = self.scroll_offset.saturating_sub((-delta) as usize);
        } else {
            // Scroll down
            self.scroll_offset = self.scroll_offset.saturating_add(delta as usize);
        }
    }

    fn render(&self, f: &mut Frame, area: Rect) {
        let border_color = if self.focused {
            Color::Cyan
        } else {
            self.border_color
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color))
            .title(Line::from(Span::styled(
                format!(" {} ", self.title),
                Style::default().add_modifier(Modifier::BOLD),
            )));

        let visible_height = self.visible_height(area);
        let offset = self.clamped_offset(visible_height);

        let paragraph = Paragraph::new(self.lines.clone())
            .block(block)
            .scroll((offset as u16, 0));
        f.render_widget(paragraph, area);
    }
}

// ---- StatusBar ----

/// A status bar showing node statuses and control indicators.
#[derive(Debug)]
pub struct StatusBar {
    /// Map of node name -> status text (from node.status events).
    pub node_statuses: Vec<(String, String)>,
    /// Control indicators (e.g., "Space: Mute [OFF]").
    pub control_indicators: Vec<String>,
}

impl StatusBar {
    pub fn new() -> Self {
        Self {
            node_statuses: Vec::new(),
            control_indicators: Vec::new(),
        }
    }

    /// Update the status text for a node.
    pub fn set_node_status(&mut self, node: &str, text: &str) {
        if let Some(entry) = self.node_statuses.iter_mut().find(|(n, _)| n == node) {
            entry.1 = text.to_string();
        } else {
            self.node_statuses.push((node.to_string(), text.to_string()));
        }
    }

    /// Set control indicator strings.
    pub fn set_controls(&mut self, indicators: Vec<String>) {
        self.control_indicators = indicators;
    }

    /// Render the status bar as a single line.
    pub fn render(&self, f: &mut Frame, area: Rect) {
        let mut spans: Vec<Span> = Vec::new();

        // Control indicators first
        for (i, indicator) in self.control_indicators.iter().enumerate() {
            if i > 0 {
                spans.push(Span::styled(" | ", Style::default().fg(Color::DarkGray)));
            }
            spans.push(Span::styled(
                indicator.clone(),
                Style::default().fg(Color::Yellow),
            ));
        }

        if !self.control_indicators.is_empty() && !self.node_statuses.is_empty() {
            spans.push(Span::styled("  ", Style::default()));
        }

        // Node statuses
        for (i, (node, text)) in self.node_statuses.iter().enumerate() {
            if i > 0 {
                spans.push(Span::styled(" | ", Style::default().fg(Color::DarkGray)));
            }
            spans.push(Span::styled(
                format!("{node}: "),
                Style::default().fg(Color::DarkGray),
            ));
            spans.push(Span::raw(text.as_str()));
        }

        let line = Line::from(spans);
        let paragraph = Paragraph::new(line);
        f.render_widget(paragraph, area);
    }
}

// ---- FocusRing ----

/// Manages focus among multiple panels, supporting Tab cycling and mouse click focus.
#[derive(Debug)]
pub struct FocusRing {
    /// Panel identifiers.
    pub panels: Vec<String>,
    /// Currently focused panel index.
    pub focused: usize,
    /// Rects for each panel, updated each render frame for mouse hit-testing.
    pub panel_areas: Vec<Rect>,
}

impl FocusRing {
    pub fn new(panels: Vec<String>) -> Self {
        let len = panels.len();
        Self {
            panels,
            focused: 0,
            panel_areas: vec![Rect::default(); len],
        }
    }

    /// Cycle focus to the next panel.
    pub fn next(&mut self) {
        if !self.panels.is_empty() {
            self.focused = (self.focused + 1) % self.panels.len();
        }
    }

    /// Cycle focus to the previous panel.
    pub fn prev(&mut self) {
        if !self.panels.is_empty() {
            self.focused = (self.focused + self.panels.len() - 1) % self.panels.len();
        }
    }

    /// Get the currently focused panel name.
    pub fn focused_panel(&self) -> Option<&str> {
        self.panels.get(self.focused).map(|s| s.as_str())
    }

    /// Check if a given panel is focused.
    pub fn is_focused(&self, panel: &str) -> bool {
        self.focused_panel() == Some(panel)
    }

    /// Update the area for a panel (call during render).
    pub fn set_area(&mut self, panel: &str, area: Rect) {
        if let Some(idx) = self.panels.iter().position(|p| p == panel) {
            if idx < self.panel_areas.len() {
                self.panel_areas[idx] = area;
            }
        }
    }

    /// Find which panel a mouse event falls in, based on stored areas.
    pub fn panel_at(&self, mouse: &MouseEvent) -> Option<&str> {
        let col = mouse.column;
        let row = mouse.row;
        for (i, area) in self.panel_areas.iter().enumerate() {
            if col >= area.x
                && col < area.x + area.width
                && row >= area.y
                && row < area.y + area.height
            {
                return Some(&self.panels[i]);
            }
        }
        None
    }

    /// Focus the panel at the mouse position. Returns true if focus changed.
    pub fn focus_at(&mut self, mouse: &MouseEvent) -> bool {
        let col = mouse.column;
        let row = mouse.row;
        for (i, area) in self.panel_areas.iter().enumerate() {
            if col >= area.x
                && col < area.x + area.width
                && row >= area.y
                && row < area.y + area.height
            {
                if self.focused != i {
                    self.focused = i;
                    return true;
                }
                return false;
            }
        }
        false
    }

    /// Get the scroll delta for a mouse event (positive = down, negative = up).
    pub fn scroll_delta(mouse: &MouseEvent) -> Option<i32> {
        match mouse.kind {
            MouseEventKind::ScrollUp => Some(-3),
            MouseEventKind::ScrollDown => Some(3),
            _ => None,
        }
    }
}

// ---- HoldState ----

/// Tracks hold-to-activate state for a keybind.
///
/// When keyboard enhancement is unavailable, detect hold via key repeat timing:
/// - On press: activate, record timestamp
/// - On repeat press: update timestamp (key still held)
/// - On tick: if elapsed > timeout, deactivate (key released)
#[derive(Debug)]
pub struct HoldState {
    /// Whether the hold is currently active.
    pub active: bool,
    /// Timestamp of the last key press event.
    pub last_press: std::time::Instant,
    /// Duration after which we consider the key released.
    pub release_timeout: std::time::Duration,
}

impl HoldState {
    pub fn new(release_timeout_ms: u64) -> Self {
        Self {
            active: false,
            last_press: std::time::Instant::now(),
            release_timeout: std::time::Duration::from_millis(release_timeout_ms),
        }
    }

    /// Called on key press. Returns true if this is a new activation.
    pub fn on_press(&mut self) -> bool {
        let was_active = self.active;
        self.active = true;
        self.last_press = std::time::Instant::now();
        !was_active
    }

    /// Called on key release (native). Returns true if this is a deactivation.
    pub fn on_release(&mut self) -> bool {
        if self.active {
            self.active = false;
            return true;
        }
        false
    }

    /// Called on each tick. Returns true if the hold timed out (deactivation).
    pub fn check_timeout(&mut self) -> bool {
        if self.active && self.last_press.elapsed() > self.release_timeout {
            self.active = false;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_ring_cycles() {
        let mut ring = FocusRing::new(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(ring.focused_panel(), Some("a"));
        ring.next();
        assert_eq!(ring.focused_panel(), Some("b"));
        ring.next();
        assert_eq!(ring.focused_panel(), Some("c"));
        ring.next();
        assert_eq!(ring.focused_panel(), Some("a"));
        ring.prev();
        assert_eq!(ring.focused_panel(), Some("c"));
    }

    #[test]
    fn focus_ring_is_focused() {
        let ring = FocusRing::new(vec!["agent".into(), "logs".into()]);
        assert!(ring.is_focused("agent"));
        assert!(!ring.is_focused("logs"));
    }

    #[test]
    fn scrollable_text_scroll_keys() {
        let mut widget = ScrollableText::new("Test");
        widget.lines = (0..50).map(|i| Line::from(format!("line {i}"))).collect();
        widget.auto_scroll = false;
        widget.scroll_offset = 10;

        widget.handle_key(KeyEvent::new(KeyCode::Up, crossterm::event::KeyModifiers::NONE));
        assert_eq!(widget.scroll_offset, 9);

        widget.handle_key(KeyEvent::new(KeyCode::Down, crossterm::event::KeyModifiers::NONE));
        assert_eq!(widget.scroll_offset, 10);

        widget.handle_key(KeyEvent::new(KeyCode::Home, crossterm::event::KeyModifiers::NONE));
        assert_eq!(widget.scroll_offset, 0);

        widget.handle_key(KeyEvent::new(KeyCode::End, crossterm::event::KeyModifiers::NONE));
        assert!(widget.auto_scroll);
    }

    #[test]
    fn scrollable_text_mouse_scroll() {
        let mut widget = ScrollableText::new("Test");
        widget.lines = (0..50).map(|i| Line::from(format!("line {i}"))).collect();
        widget.scroll_offset = 10;
        widget.auto_scroll = false;

        widget.handle_mouse_scroll(-3);
        assert_eq!(widget.scroll_offset, 7);

        widget.handle_mouse_scroll(5);
        assert_eq!(widget.scroll_offset, 12);
    }

    #[test]
    fn status_bar_set_and_update() {
        let mut bar = StatusBar::new();
        bar.set_node_status("mic", "Listening");
        bar.set_node_status("stt", "Connected");
        assert_eq!(bar.node_statuses.len(), 2);

        bar.set_node_status("mic", "Muted");
        assert_eq!(bar.node_statuses.len(), 2);
        assert_eq!(bar.node_statuses[0].1, "Muted");
    }

    #[test]
    fn hold_state_activate_deactivate() {
        let mut hold = HoldState::new(300);
        assert!(!hold.active);

        // First press activates
        assert!(hold.on_press());
        assert!(hold.active);

        // Repeat press does not re-activate
        assert!(!hold.on_press());
        assert!(hold.active);

        // Release deactivates
        assert!(hold.on_release());
        assert!(!hold.active);

        // Release when not active is no-op
        assert!(!hold.on_release());
    }
}
