use serde::{Deserialize, Serialize};

use crate::services::detect::AgentState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentity {
    pub agent_type: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    pub state: AgentState,
    pub visible_blocker: bool,
    pub visible_working: bool,
    pub visible_idle: bool,
    pub skip_state_update: bool,
    pub review_in_progress: bool,
}

impl AgentDetection {
    pub fn from_state(state: AgentState) -> Self {
        Self {
            visible_blocker: state == AgentState::Blocked,
            visible_working: state == AgentState::Working,
            visible_idle: false,
            skip_state_update: state == AgentState::Unknown,
            review_in_progress: false,
            state,
        }
    }
}

impl Default for AgentDetection {
    fn default() -> Self {
        Self::from_state(AgentState::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_state_never_sets_visible_idle() {
        // visible_idle is opt-in via an explicit manifest rule only; deriving it
        // from state would make every fallback-idle screen bypass the engine's
        // idle confirmation debounce.
        assert!(!AgentDetection::from_state(AgentState::Idle).visible_idle);
        assert!(!AgentDetection::from_state(AgentState::Working).visible_idle);
        assert!(!AgentDetection::default().visible_idle);
    }

    #[test]
    fn from_state_never_sets_review_in_progress() {
        assert!(!AgentDetection::from_state(AgentState::Blocked).review_in_progress);
        assert!(!AgentDetection::from_state(AgentState::Working).review_in_progress);
        assert!(!AgentDetection::default().review_in_progress);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStatusSource {
    None,
    Hook,
    Process,
    Pty,
    Screen,
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookAuthority {
    IdentityOnly,
    FullLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAgentStatus {
    pub agent_type: Option<String>,
    pub agent_state: AgentState,
    pub revision: u64,
    pub source: AgentStatusSource,
    pub confidence: u8,
    pub hook_sequence: u64,
    pub session_id: Option<String>,
    pub changed_at: i64,
    pub visible_blocker: bool,
    pub visible_working: bool,
}

impl Default for EffectiveAgentStatus {
    fn default() -> Self {
        Self {
            agent_type: None,
            agent_state: AgentState::Unknown,
            revision: 0,
            source: AgentStatusSource::None,
            confidence: 0,
            hook_sequence: 0,
            session_id: None,
            changed_at: 0,
            visible_blocker: false,
            visible_working: false,
        }
    }
}
