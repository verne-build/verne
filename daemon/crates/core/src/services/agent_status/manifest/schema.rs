use serde::Deserialize;

use crate::services::detect::AgentState;

/// One agent's detection manifest, parsed from bundled TOML.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentManifest {
    #[serde(rename = "id")]
    pub _id: String,
    #[serde(default, rename = "version")]
    pub _version: Option<String>,
    #[serde(default, rename = "updated_at")]
    pub _updated_at: Option<String>,
    #[serde(default)]
    pub title: TitleConfig,
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TitleConfig {
    #[serde(default)]
    pub strategy: TitleStrategy,
    #[serde(default)]
    pub prompt_events: Vec<String>,
    #[serde(default)]
    pub prompt_fields: Vec<String>,
    #[serde(default = "default_title_max_length")]
    pub max_length: usize,
}

impl Default for TitleConfig {
    fn default() -> Self {
        Self {
            strategy: TitleStrategy::Osc,
            prompt_events: Vec::new(),
            prompt_fields: Vec::new(),
            max_length: default_title_max_length(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleStrategy {
    Osc,
    HookPrompt,
    OscThenHookPrompt,
    HookPromptThenOsc,
}

impl Default for TitleStrategy {
    fn default() -> Self {
        Self::Osc
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub id: String,
    pub state: RuleState,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default)]
    pub visible_idle: bool,
    #[serde(default)]
    pub visible_blocker: bool,
    #[serde(default)]
    pub visible_working: bool,
    #[serde(default)]
    pub skip_state_update: bool,
    #[serde(default)]
    pub review_marker: bool,
    #[serde(default)]
    pub contains: Vec<String>,
    #[serde(default)]
    pub regex: Vec<String>,
    #[serde(default)]
    pub line_regex: Vec<String>,
    #[serde(default)]
    pub all: Vec<Gate>,
    #[serde(default)]
    pub any: Vec<Gate>,
    #[serde(default, rename = "not")]
    pub not: Vec<Gate>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Gate {
    #[serde(default)]
    pub contains: Vec<String>,
    #[serde(default)]
    pub regex: Vec<String>,
    #[serde(default)]
    pub line_regex: Vec<String>,
    #[serde(default)]
    pub all: Vec<Gate>,
    #[serde(default)]
    pub any: Vec<Gate>,
    #[serde(default, rename = "not")]
    pub not: Vec<Gate>,
}

impl Rule {
    /// View the rule's own matchers as a Gate for compilation/evaluation.
    pub fn gate(&self) -> Gate {
        Gate {
            contains: self.contains.clone(),
            regex: self.regex.clone(),
            line_regex: self.line_regex.clone(),
            all: self.all.clone(),
            any: self.any.clone(),
            not: self.not.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleState {
    Idle,
    Working,
    Blocked,
    Unknown,
}

impl From<RuleState> for AgentState {
    fn from(value: RuleState) -> Self {
        match value {
            RuleState::Idle => AgentState::Idle,
            RuleState::Working => AgentState::Working,
            RuleState::Blocked => AgentState::Blocked,
            RuleState::Unknown => AgentState::Unknown,
        }
    }
}

fn default_region() -> String {
    "whole_recent".to_string()
}

fn default_title_max_length() -> usize {
    120
}

pub fn parse(content: &str) -> Result<AgentManifest, String> {
    toml::from_str::<AgentManifest>(content).map_err(|err| err.to_string())
}
