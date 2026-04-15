---
"@acpfx/cli": patch
---

TUI: add scrollable agent transcript, text wrapping, and focus improvements

- Agent transcript panel now scrolls with mouse wheel and arrow keys (Up/Down/PgUp/PgDn/Home/End)
- Auto-scroll follows new content, disables on manual scroll up, re-enables on End key
- Text wrapping uses actual terminal width instead of hardcoded 100 chars
- Prompt text now wraps for long spoken input
- Per-node speech panels use ratatui Wrap for overflow handling
- Speech panel height grows dynamically based on content
- Mouse click and scroll wheel auto-focus the target panel
- Focus indicated by cyan border color
