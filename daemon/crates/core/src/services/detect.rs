//! Core agent-state type and the prompt-box cut-line helper reused by the
//! manifest detection engine's region extraction.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Blocked,
    Idle,
    Unknown,
}

impl Default for AgentState {
    fn default() -> Self {
        AgentState::Unknown
    }
}

/// Content above Claude's prompt box. Modern claude-code uses rounded-corner
/// box drawing (╭─...─╮, │...│, ╰─...─╯). Find the topmost ╭ scanning
/// bottom-up and return content above it; that gives a stable cut-line that
/// includes the spinner / "esc to interrupt" line. Falls back to the legacy
/// two-pure-─-borders search if the rounded box isn't present (older claude
/// or different terminal rendering).
pub fn content_above_prompt_box(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();

    // Modern box: scan bottom-up for the FIRST line containing ╭ (top-left
    // corner of the prompt box). Anything above that includes the spinner.
    let mut top_corner: Option<usize> = None;
    for i in (0..lines.len()).rev() {
        let line = lines[i];
        if line.contains('╭') || line.contains('┌') {
            top_corner = Some(i);
        } else if top_corner.is_some()
            && !line.contains('│')
            && !line.contains('╮')
            && !line.contains('┐')
        {
            // Walked off the top of the box.
            break;
        }
    }
    if let Some(i) = top_corner {
        let byte_offset: usize = lines[..i].iter().map(|l| l.len() + 1).sum();
        return &content[..byte_offset.min(content.len())];
    }

    // Legacy fallback: two pure-─ borders sandwiching the prompt.
    let mut border_count = 0;
    for i in (0..lines.len()).rev() {
        let trimmed = lines[i].trim();
        if !trimmed.is_empty() && trimmed.chars().all(|c| c == '─') {
            border_count += 1;
            if border_count == 2 {
                let byte_offset: usize = lines[..i].iter().map(|l| l.len() + 1).sum();
                return &content[..byte_offset.min(content.len())];
            }
        }
    }
    content
}
