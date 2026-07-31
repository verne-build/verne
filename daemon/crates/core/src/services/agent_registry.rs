/// Whether Verne installs a lifecycle integration for this agent, and how much
/// of the lifecycle it reliably reports. Drives hook authority AND the install
/// set — both read this one field so they cannot drift.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookIntegration {
    /// No hook/plugin integration installed.
    None,
    /// Hooks installed but lifecycle is partial — correlate session id only.
    Identity,
    /// Reliable start+stop — the hook owns state until process exit.
    FullLifecycle,
}

#[derive(Clone, Copy, Debug)]
pub struct AgentDefinition {
    pub key: &'static str,
    pub binary_names: &'static [&'static str],
    /// Lowercase substrings that identify this agent from terminal output.
    pub screen_markers: &'static [&'static str],
    pub hooks: HookIntegration,
}

const fn agent(
    key: &'static str,
    binary_names: &'static [&'static str],
    screen_markers: &'static [&'static str],
    hooks: HookIntegration,
) -> AgentDefinition {
    AgentDefinition { key, binary_names, screen_markers, hooks }
}

pub const AGENTS: &[AgentDefinition] = &[
    agent("claude", &["claude", "claude-code"], &["claude code", "claude max"], HookIntegration::FullLifecycle),
    agent("codex", &["codex", "codex-rs", "codex-tui", "codex-cli"], &["openai codex", "codex cli", ">_ codex", "openai/codex"], HookIntegration::FullLifecycle),
    agent("antigravity", &["agy", "antigravity", "antigravity-cli"], &["antigravity"], HookIntegration::FullLifecycle),
    agent("cursor", &["cursor", "cursor-agent", "agent"], &["cursor agent", "cursor-agent"], HookIntegration::Identity),
    agent("grok", &["grok", "grok-build"], &["grok build", "grok cli"], HookIntegration::None),
    agent("opencode", &["opencode", "open-code"], &["opencode"], HookIntegration::FullLifecycle),
    agent("pi", &["pi"], &[], HookIntegration::FullLifecycle),
];

pub fn get(key: &str) -> Option<&'static AgentDefinition> {
    AGENTS.iter().find(|agent| agent.key == key)
}

pub fn identify_token(token: &str) -> Option<&'static AgentDefinition> {
    let base = token
        .trim_matches(['"', '\''])
        .rsplit('/')
        .next()
        .unwrap_or(token)
        .trim_end_matches(".js")
        .trim_end_matches(".mjs")
        .trim_end_matches(".cjs");
    AGENTS.iter().find(|agent| {
        agent
            .binary_names
            .iter()
            .any(|binary| base.eq_ignore_ascii_case(binary))
    })
}

/// Identify an agent from terminal output by matching `screen_markers`. Scans
/// the full screen lowercased; identity is sticky and confirmation-gated by the
/// status engine, so a marker lingering in scrollback is acceptable. Process
/// identity (`identify_token`) is the primary source — this is the fallback.
pub fn identify_screen(screen: &str) -> Option<&'static AgentDefinition> {
    let haystack = screen.to_ascii_lowercase();
    AGENTS.iter().find(|agent| {
        agent
            .screen_markers
            .iter()
            .any(|marker| haystack.contains(marker))
    })
}

/// Single dispatch for screen-derived state detection — uniform across all
/// agents via the manifest engine.
pub fn detect(key: &str, screen: &str) -> crate::services::agent_status::AgentDetection {
    crate::services::agent_status::manifest::detect(key, screen)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn active_registry_is_the_approved_seven_in_order() {
        assert_eq!(
            AGENTS.iter().map(|agent| agent.key).collect::<Vec<_>>(),
            ["claude", "codex", "antigravity", "cursor", "grok", "opencode", "pi"]
        );
    }

    #[test]
    fn removed_agents_do_not_resolve() {
        for key in [
            "amp", "cline", "copilot", "droid", "gemini", "hermes", "kilo", "kimi", "kiro",
            "qodercli",
        ] {
            assert!(get(key).is_none(), "{key}");
            assert!(identify_token(key).is_none(), "{key}");
        }
    }

    #[test]
    fn keys_and_binary_aliases_are_unique() {
        let mut keys = HashSet::new();
        let mut binaries = HashSet::new();
        for agent in AGENTS {
            assert!(keys.insert(agent.key), "duplicate key: {}", agent.key);
            for binary in agent.binary_names {
                assert!(
                    binaries.insert(binary.to_ascii_lowercase()),
                    "duplicate binary alias: {binary}"
                );
                assert_eq!(identify_token(binary).map(|item| item.key), Some(agent.key));
            }
        }
    }

    #[test]
    fn hook_integration_matches_install_set() {
        use HookIntegration::*;
        let expect = |key, want: HookIntegration| {
            assert_eq!(get(key).map(|a| a.hooks), Some(want), "{key}");
        };
        // FullLifecycle: reliable start+stop lifecycle hooks/plugins installed.
        for k in ["claude", "codex", "antigravity", "opencode", "pi"] {
            expect(k, FullLifecycle);
        }
        // Identity: hooks installed but partial lifecycle (cursor: shell-exec only).
        expect("cursor", Identity);
        expect("grok", None);
    }

    #[test]
    fn integration_set_is_exactly_the_installable_agents() {
        let mut installed: Vec<&str> = AGENTS
            .iter()
            .filter(|a| a.hooks != HookIntegration::None)
            .map(|a| a.key)
            .collect();
        installed.sort_unstable();
        assert_eq!(
            installed,
            ["antigravity", "claude", "codex", "cursor", "opencode", "pi"]
        );
    }

    #[test]
    fn detect_is_uniform_via_manifest() {
        use crate::services::detect::AgentState;
        assert_eq!(
            detect("antigravity", "Requesting permission for: read file\nDo you want to proceed?\n> Yes\n> No").state,
            AgentState::Blocked
        );
        assert_eq!(detect("totally-unknown", "$ ").state, AgentState::Idle);
    }

    #[test]
    fn detection_does_not_depend_on_provider() {
        // Independent agent manifests detect their own blocked prompts.
        use crate::services::detect::AgentState;
        let blocked = "─────\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nesc to cancel";
        assert_eq!(detect("claude", blocked).state, AgentState::Blocked);
        assert_eq!(detect("opencode", "△ Permission required\nfor bash").state, AgentState::Blocked);
    }

    #[test]
    fn identifies_agents_from_screen() {
        let id = |s| identify_screen(s).map(|a| a.key);
        assert_eq!(id("welcome to Claude Code v2"), Some("claude"));
        assert_eq!(id(">_ codex resume"), Some("codex"));
        assert_eq!(id("cursor-agent v0.1"), Some("cursor"));
        assert_eq!(id("grok build ready"), Some("grok"));
        assert_eq!(id("just a plain shell prompt $"), None);
    }

    #[test]
    fn screen_markers_are_lowercase() {
        for agent in AGENTS {
            for marker in agent.screen_markers {
                assert_eq!(
                    *marker,
                    marker.to_ascii_lowercase(),
                    "marker not lowercase: {marker}"
                );
            }
        }
    }
}
