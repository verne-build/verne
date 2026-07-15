use super::compile::CompiledGate;
use super::regions::region;
use super::schema::{parse, Gate, RuleState};

fn gate_from(toml_body: &str) -> Gate {
    // Parse a one-rule manifest and lift its gate.
    let m = parse(&format!(
        "id=\"t\"\n[[rules]]\nid=\"r\"\nstate=\"idle\"\n{toml_body}"
    ))
    .unwrap();
    m.rules[0].gate()
}

#[test]
fn contains_is_case_insensitive_and_all_must_match() {
    let g = CompiledGate::compile(&gate_from("contains = [\"Do You Want\", \"esc\"]")).unwrap();
    assert!(g.matches("... do you want to proceed? esc to cancel"));
    assert!(!g.matches("do you want to proceed?")); // missing "esc"
}

#[test]
fn any_requires_one_branch() {
    let g = CompiledGate::compile(&gate_from(
        "any = [ { contains=[\"yes\"] }, { contains=[\"allow\"] } ]",
    ))
    .unwrap();
    assert!(g.matches("> allow command"));
    assert!(!g.matches("> deny"));
}

#[test]
fn not_negates() {
    let g = CompiledGate::compile(&gate_from(
        "contains=[\"proceed\"]\nnot = [ { contains=[\"select model\"] } ]",
    ))
    .unwrap();
    assert!(g.matches("do you want to proceed?"));
    assert!(!g.matches("do you want to proceed? select model"));
}

#[test]
fn line_regex_matches_per_line() {
    let g = CompiledGate::compile(&gate_from("line_regex = ['(?i)^\\s*❯?\\s*1\\.\\s*yes\\b']"))
        .unwrap();
    assert!(g.matches("intro\n  ❯ 1. Yes, proceed\nmore"));
    assert!(!g.matches("1 yes"));
}

#[test]
fn invalid_regex_is_a_compile_error() {
    let err = CompiledGate::compile(&gate_from("regex = [\"[unclosed\"]")).unwrap_err();
    assert!(
        err.contains("invalid regex"),
        "error should mention 'invalid regex': {err}"
    );
}

#[test]
fn invalid_line_regex_is_a_compile_error() {
    let err = CompiledGate::compile(&gate_from("line_regex = [\"(?P<bad\"]")).unwrap_err();
    assert!(
        err.contains("invalid regex"),
        "error should mention 'invalid regex': {err}"
    );
}

#[test]
fn valid_complex_gate_compiles() {
    // Counter-test: a real complex gate must compile to Ok.
    CompiledGate::compile(&gate_from("regex = [\"^\\\\d+$\"]")).unwrap();
}

#[test]
fn parses_a_basic_manifest() {
    let m = parse(
        r#"
id = "demo"
version = "1"

[[rules]]
id = "blocked_prompt"
state = "blocked"
priority = 900
region = "bottom_lines(20)"
visible_blocker = true
contains = ["do you want to proceed?"]
any = [ { contains = ["esc to cancel"] } ]
"#,
    )
    .expect("manifest should parse");
    assert_eq!(m._id, "demo");
    assert_eq!(m.rules.len(), 1);
    assert_eq!(m.rules[0].state, RuleState::Blocked);
    assert_eq!(m.rules[0].priority, 900);
    assert_eq!(m.rules[0].region, "bottom_lines(20)");
    assert!(m.rules[0].visible_blocker);
}

#[test]
fn whole_recent_returns_everything() {
    assert_eq!(region("a\nb\nc", "whole_recent"), "a\nb\nc");
}

#[test]
fn bottom_lines_n_returns_last_n_lines() {
    assert_eq!(region("a\nb\nc\nd", "bottom_lines(2)"), "c\nd");
}

#[test]
fn bottom_non_empty_lines_skips_trailing_blanks() {
    assert_eq!(
        region("a\nb\n\n\n", "bottom_non_empty_lines(2)"),
        "a\nb\n\n\n"
    );
}

#[test]
fn unknown_region_is_empty() {
    assert_eq!(region("a\nb", "nonsense"), "");
}

use super::{detect, explain};
use crate::services::detect::AgentState;

#[test]
fn codex_review_marker_sets_review_in_progress() {
    let screen = "• Working (5s)\nReviewing approval request";
    assert!(super::detect("codex", screen).review_in_progress);
}

#[test]
fn codex_review_marker_matches_outside_bottom_lines() {
    let mut screen = String::from("Reviewing approval request\n");
    for i in 0..24 {
        screen.push_str(&format!("approval detail line {i}\n"));
    }
    screen.push_str("Press Enter to confirm or Esc to cancel");
    assert!(super::detect("codex", &screen).review_in_progress);
}

#[test]
fn codex_no_review_marker_leaves_flag_false() {
    let screen = "• Working (5s)";
    assert!(!super::detect("codex", screen).review_in_progress);
}

#[test]
fn explain_reports_matched_rule_for_blocked_claude() {
    let e = explain(
        "claude",
        "─────\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nesc to cancel",
    );
    assert_eq!(e.state, "blocked");
    assert_eq!(e.matched_rule.as_deref(), Some("permission_prompt"));
    assert!(!e.fallback);
}

#[test]
fn explain_reports_session_limit_for_claude_and_codex() {
    let claude = explain(
        "claude",
        "❯ /rate-limit-options\nWhat do you want to do?\n1. Stop and wait for limit to reset\n2. Upgrade your plan",
    );
    assert_eq!(claude.state, "blocked");
    assert_eq!(claude.matched_rule.as_deref(), Some("session_limit"));

    let codex = explain(
        "codex",
        "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again later.",
    );
    assert_eq!(codex.state, "blocked");
    assert_eq!(codex.matched_rule.as_deref(), Some("session_limit"));
}

#[test]
fn all_bundled_manifests_compile() {
    // Touching detect() forces the OnceLock cache to build; a bad bundled
    // manifest panics here rather than at runtime.
    let _ = detect("claude", "");
    let _ = detect("default", "");
}

#[test]
fn every_bundled_manifest_compiles_and_detects() {
    // Exercises every entry in BUNDLED plus "default"; loader panics on bad manifest.
    for &(key, _toml) in super::BUNDLED {
        let d = super::detect(key, "");
        let _ = d; // state is engine-defined for empty input; just assert no panic
    }
    let _ = super::detect("default", "");
}

#[test]
fn unknown_key_falls_back_to_default() {
    // default.toml has no matching rule for a plain prompt → Idle fallback.
    assert_eq!(detect("totally-unknown", "$ ").state, AgentState::Idle);
}

#[test]
fn explain_serializes() {
    let e = explain("claude", "");
    let v = super::explain_to_json(&e);
    assert_eq!(v["agent"], "claude");
    assert!(v["evaluated_rules"].is_array());
}

#[test]
fn every_registry_agent_has_a_manifest() {
    for agent in crate::services::agent_registry::AGENTS {
        assert!(
            super::BUNDLED.iter().any(|(k, _)| *k == agent.key),
            "missing manifest for {}",
            agent.key
        );
    }
}

#[test]
fn every_manifest_id_maps_to_a_registry_key_except_default() {
    for (key, _) in super::BUNDLED {
        assert!(
            crate::services::agent_registry::get(key).is_some(),
            "manifest {key} has no registry agent"
        );
    }
}
