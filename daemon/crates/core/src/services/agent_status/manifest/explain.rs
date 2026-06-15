use serde::Serialize;

use crate::services::detect::AgentState;

fn state_label(state: AgentState) -> &'static str {
    match state {
        AgentState::Idle => "idle",
        AgentState::Working => "working",
        AgentState::Blocked => "blocked",
        AgentState::Unknown => "unknown",
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EvaluatedRule {
    pub id: String,
    pub priority: i32,
    pub region: String,
    pub state: String,
    pub matched: bool,
    pub region_bytes: usize,
    pub region_preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectionExplain {
    pub agent: String,
    pub state: String,
    pub source: String,
    pub matched_rule: Option<String>,
    pub fallback: bool,
    pub evaluated_rules: Vec<EvaluatedRule>,
}

impl DetectionExplain {
    pub fn evaluated(id: &str, priority: i32, region: &str, state: AgentState, matched: bool, region_text: &str) -> EvaluatedRule {
        EvaluatedRule {
            id: id.to_string(),
            priority,
            region: region.to_string(),
            state: state_label(state).to_string(),
            matched,
            region_bytes: region_text.len(),
            region_preview: preview(region_text),
        }
    }
}

pub fn state_label_pub(state: AgentState) -> &'static str {
    state_label(state)
}

fn preview(text: &str) -> String {
    const MAX: usize = 240;
    let mut s: String = text.chars().take(MAX).collect();
    if text.chars().count() > MAX {
        s.push_str("...");
    }
    s
}
