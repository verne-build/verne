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

pub const AGENTS: &[AgentDefinition] = &[
    AgentDefinition {
        key: "claude",
        binary_names: &["claude", "claude-code"],
        screen_markers: &["claude code", "claude max"],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "codex",
        binary_names: &["codex", "codex-rs", "codex-tui", "codex-cli"],
        screen_markers: &["openai codex", "codex cli", ">_ codex", "openai/codex"],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "copilot",
        binary_names: &["copilot", "github-copilot"],
        screen_markers: &["github copilot"],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "antigravity",
        binary_names: &["agy", "antigravity", "antigravity-cli"],
        screen_markers: &["antigravity"],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "amp",
        binary_names: &["amp", "amp-local"],
        screen_markers: &[],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "cline",
        binary_names: &["cline"],
        screen_markers: &["[act mode]", "[plan mode]"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "cursor",
        binary_names: &["cursor", "cursor-agent", "agent"],
        screen_markers: &["cursor agent", "cursor-agent"],
        hooks: HookIntegration::Identity,
    },
    AgentDefinition {
        key: "droid",
        binary_names: &["droid"],
        screen_markers: &[],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "gemini",
        binary_names: &["gemini"],
        screen_markers: &["gemini cli"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "grok",
        binary_names: &["grok", "grok-build"],
        screen_markers: &["grok build", "grok cli"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "hermes",
        binary_names: &["hermes", "hermes-agent"],
        screen_markers: &["hermes agent"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "kilo",
        binary_names: &["kilo", "kilo-code"],
        screen_markers: &["kilo code"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "kimi",
        binary_names: &["kimi", "kimi-code"],
        screen_markers: &["kimi code"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "kiro",
        binary_names: &["kiro", "kiro-cli"],
        screen_markers: &["kiro cli", "kiro is working"],
        hooks: HookIntegration::None,
    },
    AgentDefinition {
        key: "opencode",
        binary_names: &["opencode", "open-code"],
        screen_markers: &["opencode"],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "pi",
        binary_names: &["pi"],
        screen_markers: &[],
        hooks: HookIntegration::FullLifecycle,
    },
    AgentDefinition {
        key: "qodercli",
        binary_names: &["qodercli", "qoderclicn", "qoder", "qodercn"],
        screen_markers: &["qoder cli", "qodercli"],
        hooks: HookIntegration::None,
    },
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
        for k in ["claude", "codex", "copilot", "antigravity", "opencode", "pi"] {
            expect(k, FullLifecycle);
        }
        // Identity: hooks installed but partial lifecycle (cursor: shell-exec only).
        expect("cursor", Identity);
        // None: no hook/plugin integration.
        for k in [
            "amp", "cline", "droid", "gemini", "grok", "hermes", "kilo", "kimi", "kiro", "qodercli",
        ] {
            expect(k, None);
        }
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
            ["antigravity", "claude", "codex", "copilot", "cursor", "opencode", "pi"]
        );
    }

    #[test]
    fn detect_is_uniform_via_manifest() {
        use crate::services::detect::AgentState;
        assert_eq!(
            detect("droid", "EXECUTE\n> Yes, allow\nEnter to select").state,
            AgentState::Blocked
        );
        assert_eq!(detect("totally-unknown", "$ ").state, AgentState::Idle);
    }

    #[test]
    fn detection_does_not_depend_on_provider() {
        // claude and gemini both detect a blocked generic prompt purely from
        // their manifests, proving the detection path is uniform across agents.
        use crate::services::detect::AgentState;
        let blocked = "─────\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nesc to cancel";
        assert_eq!(detect("claude", blocked).state, AgentState::Blocked);
        assert_eq!(detect("gemini", "│ Apply this change\n❯ Yes\nEsc to cancel").state, AgentState::Blocked);
    }

    #[test]
    fn identifies_agents_from_screen() {
        let id = |s| identify_screen(s).map(|a| a.key);
        assert_eq!(id("welcome to Claude Code v2"), Some("claude"));
        assert_eq!(id(">_ codex resume"), Some("codex"));
        assert_eq!(id("GitHub Copilot CLI"), Some("copilot"));
        assert_eq!(id("Gemini CLI ready"), Some("gemini"));
        assert_eq!(id("[ACT MODE] cline"), Some("cline"));
        assert_eq!(id("cursor-agent v0.1"), Some("cursor"));
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
