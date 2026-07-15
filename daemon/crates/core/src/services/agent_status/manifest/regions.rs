use crate::services::detect::content_above_prompt_box;

/// Extract the named region of the screen. Unknown names yield "".
pub fn region<'a>(content: &'a str, spec: &str) -> &'a str {
    let spec = spec.trim();
    match spec {
        "whole_recent" => content,
        "above_prompt_box" => content_above_prompt_box(content),
        "last_non_empty_above_prompt_box" => last_non_empty_line(content_above_prompt_box(content)),
        "after_last_horizontal_rule" => after_last_horizontal_rule(content),
        "prompt_box_body" => prompt_box_body(content),
        "after_last_prompt_marker" => after_last_prompt_marker(content),
        "before_current_prompt_marker" => before_current_prompt_marker(content),
        "whole_recent_without_current_prompt_marker" => {
            if current_prompt_index(&content.lines().collect::<Vec<_>>()).is_some() {
                ""
            } else {
                content
            }
        }
        _ => {
            if let Some(n) = count_arg(spec, "bottom_lines") {
                return bottom_lines(content, n);
            }
            if let Some(n) = count_arg(spec, "bottom_non_empty_lines") {
                return bottom_non_empty_lines(content, n);
            }
            ""
        }
    }
}

fn count_arg(spec: &str, name: &str) -> Option<usize> {
    spec.strip_prefix(name)?
        .strip_prefix('(')?
        .strip_suffix(')')?
        .parse::<usize>()
        .ok()
}

fn line_start_offset(content: &str, lines: &[&str], index: usize) -> usize {
    lines[..index.min(lines.len())]
        .iter()
        .map(|l| l.len() + 1)
        .sum::<usize>()
        .min(content.len())
}

fn slice_from_line_index<'a>(content: &'a str, lines: &[&str], index: usize) -> &'a str {
    &content[line_start_offset(content, lines, index)..]
}

fn bottom_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(count);
    slice_from_line_index(content, &lines, start)
}

fn bottom_non_empty_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, l)| !l.trim().is_empty())
        .take(count)
        .last()
        .map(|(i, _)| i);
    match start {
        Some(i) => slice_from_line_index(content, &lines, i),
        None => "",
    }
}

fn last_non_empty_line(content: &str) -> &str {
    content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
}

fn is_horizontal_rule(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.chars().all(|c| c == '─' || c == '-') && t.chars().count() >= 3
}

fn after_last_horizontal_rule(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match lines.iter().rposition(|l| is_horizontal_rule(l)) {
        Some(i) => slice_from_line_index(content, &lines, i + 1),
        None => content,
    }
}

fn prompt_marker(line: &str) -> bool {
    let t = line.trim_start();
    t == "❯" || t.starts_with("❯ ") || t == "›" || t.starts_with("› ")
}

fn current_prompt_index(lines: &[&str]) -> Option<usize> {
    lines.iter().rposition(|l| prompt_marker(l))
}

fn after_last_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match current_prompt_index(&lines) {
        Some(i) => slice_from_line_index(content, &lines, i + 1),
        None => content,
    }
}

fn before_current_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match current_prompt_index(&lines) {
        Some(i) => &content[..line_start_offset(content, &lines, i)],
        None => content,
    }
}

/// Body of the prompt box: from just below the box top to the next rule/EOF.
fn prompt_box_body(content: &str) -> &str {
    let above = content_above_prompt_box(content);
    if above.len() >= content.len() {
        return "";
    }
    &content[above.len()..]
}
