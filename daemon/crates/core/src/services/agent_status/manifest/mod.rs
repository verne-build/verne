mod compile;
mod explain;
mod regions;
mod schema;
mod source;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod parity;

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::services::agent_status::AgentDetection;
use crate::services::detect::AgentState;

use compile::CompiledGate;
use explain::{state_label_pub, DetectionExplain};
pub use schema::{TitleConfig, TitleStrategy};
use schema::{parse, AgentManifest, Rule};

pub(super) const DEFAULT_MANIFEST: &str = include_str!("manifests/default.toml");

/// (registry key, bundled TOML). One entry per AGENTS key (enforced by test).
pub(super) const BUNDLED: &[(&str, &str)] = &[
    ("claude", include_str!("manifests/claude.toml")),
    ("codex", include_str!("manifests/codex.toml")),
    ("copilot", include_str!("manifests/copilot.toml")),
    ("antigravity", include_str!("manifests/antigravity.toml")),
    ("amp", include_str!("manifests/amp.toml")),
    ("cline", include_str!("manifests/cline.toml")),
    ("cursor", include_str!("manifests/cursor.toml")),
    ("droid", include_str!("manifests/droid.toml")),
    ("gemini", include_str!("manifests/gemini.toml")),
    ("grok", include_str!("manifests/grok.toml")),
    ("hermes", include_str!("manifests/hermes.toml")),
    ("kilo", include_str!("manifests/kilo.toml")),
    ("kimi", include_str!("manifests/kimi.toml")),
    ("kiro", include_str!("manifests/kiro.toml")),
    ("opencode", include_str!("manifests/opencode.toml")),
    ("pi", include_str!("manifests/pi.toml")),
    ("qodercli", include_str!("manifests/qodercli.toml")),
];

struct Loaded {
    manifest: AgentManifest,
    compiled: Vec<CompiledGate>, // index-aligned with manifest.rules
}

fn cache() -> &'static HashMap<String, Loaded> {
    static CACHE: OnceLock<HashMap<String, Loaded>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut map = HashMap::new();
        // Every bundled manifest MUST compile; a bad bundled manifest is a bug.
        map.insert("default".to_string(), load("default", DEFAULT_MANIFEST));
        for &(key, toml) in BUNDLED {
            map.insert(key.to_string(), load(key, toml));
        }
        map
    })
}

fn load(key: &str, toml: &str) -> Loaded {
    let manifest = parse(toml).unwrap_or_else(|e| panic!("bundled manifest {key} invalid: {e}"));
    let compiled = manifest
        .rules
        .iter()
        .map(|r| CompiledGate::compile(&r.gate()).unwrap_or_else(|e| panic!("manifest {key} rule {} invalid: {e}", r.id)))
        .collect();
    Loaded { manifest, compiled }
}

fn loaded_for(key: &str) -> &'static Loaded {
    let c = cache();
    if let Some(l) = c.get(key) {
        return l;
    }
    c.get("default").expect("default manifest present")
}

/// Title metadata is intentionally resolved dynamically so hook prompt policy can
/// be updated without restarting the persistent daemon. Detection rules remain
/// bundled/compiled because they are evaluated every poll tick.
pub fn title_config(key: &str) -> TitleConfig {
    if let Some(config) = source::runtime_title_config(key) {
        return config;
    }
    loaded_for(key).manifest.title.clone()
}

/// Highest-priority matching rule wins. No match (known key) → Idle.
/// `review_in_progress` is computed independently: it is set whenever ANY
/// `review_marker` rule matches, regardless of which state rule wins.
pub fn detect(key: &str, screen: &str) -> AgentDetection {
    let loaded = loaded_for(key);
    let review_in_progress = loaded
        .manifest
        .rules
        .iter()
        .zip(&loaded.compiled)
        .any(|(rule, compiled)| {
            rule.review_marker && compiled.matches(regions::region(screen, &rule.region))
        });
    let mut detection = match best_match(loaded, screen) {
        Some(rule) => detection_from_rule(rule),
        None => AgentDetection::from_state(AgentState::Idle),
    };
    detection.review_in_progress = review_in_progress;
    detection
}

fn best_match<'a>(loaded: &'a Loaded, screen: &str) -> Option<&'a Rule> {
    let mut best: Option<&Rule> = None;
    for (rule, compiled) in loaded.manifest.rules.iter().zip(&loaded.compiled) {
        if !compiled.matches(regions::region(screen, &rule.region)) {
            continue;
        }
        if best.map_or(true, |b| rule.priority > b.priority) {
            best = Some(rule);
        }
    }
    best
}

fn detection_from_rule(rule: &Rule) -> AgentDetection {
    let state: AgentState = rule.state.into();
    AgentDetection {
        state,
        visible_blocker: rule.visible_blocker && state == AgentState::Blocked,
        visible_working: rule.visible_working && state == AgentState::Working,
        visible_idle: rule.visible_idle && state == AgentState::Idle,
        skip_state_update: rule.skip_state_update,
        review_in_progress: false,
    }
}

pub fn explain(key: &str, screen: &str) -> DetectionExplain {
    let loaded = loaded_for(key);
    let (_, src) = source::resolve(key);
    let evaluated: Vec<_> = loaded
        .manifest
        .rules
        .iter()
        .zip(&loaded.compiled)
        .map(|(rule, compiled)| {
            let region_text = regions::region(screen, &rule.region);
            DetectionExplain::evaluated(
                &rule.id,
                rule.priority,
                &rule.region,
                rule.state.into(),
                compiled.matches(region_text),
                region_text,
            )
        })
        .collect();
    let matched = best_match(loaded, screen);
    let state = matched.map(|r| r.state.into()).unwrap_or(AgentState::Idle);
    DetectionExplain {
        agent: key.to_string(),
        state: state_label_pub(state).to_string(),
        source: src.label().to_string(),
        matched_rule: matched.map(|r| r.id.clone()),
        fallback: matched.is_none(),
        evaluated_rules: evaluated,
    }
}

pub fn explain_to_json(explain: &DetectionExplain) -> serde_json::Value {
    serde_json::to_value(explain).unwrap_or(serde_json::Value::Null)
}
