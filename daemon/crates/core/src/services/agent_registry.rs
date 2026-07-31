use serde::Serialize;

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
    pub display_name: &'static str,
    pub process_binary_names: &'static [&'static str],
    pub discovery_binary_names: &'static [&'static str],
    /// Lowercase substrings that identify this agent from terminal output.
    pub screen_markers: &'static [&'static str],
    pub hooks: HookIntegration,
    pub version_probe: VersionProbe,
    pub latest_source: LatestVersionSource,
    pub update: UpdateGuidance,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum VersionProbe {
    Semver {
        args: &'static [&'static str],
        fallback_args: Option<&'static [&'static str]>,
    },
    Codex {
        args: &'static [&'static str],
    },
    CursorBuild {
        args: &'static [&'static str],
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LatestVersionSource {
    NpmJson { url: &'static str },
    AntigravityInstaller { url: &'static str },
    CursorInstaller { url: &'static str },
    GrokCli,
    PiJson { url: &'static str },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdateGuidance {
    Command { command: &'static str },
    CodexInstallPath { docs_url: &'static str },
    ResolvedAlias { args: &'static [&'static str] },
}

const fn agent(
    key: &'static str,
    display_name: &'static str,
    process_binary_names: &'static [&'static str],
    discovery_binary_names: &'static [&'static str],
    screen_markers: &'static [&'static str],
    hooks: HookIntegration,
    version_probe: VersionProbe,
    latest_source: LatestVersionSource,
    update: UpdateGuidance,
) -> AgentDefinition {
    AgentDefinition {
        key,
        display_name,
        process_binary_names,
        discovery_binary_names,
        screen_markers,
        hooks,
        version_probe,
        latest_source,
        update,
    }
}

pub const AGENTS: &[AgentDefinition] = &[
    agent(
        "claude",
        "Claude",
        &["claude", "claude-code"],
        &["claude", "claude-code"],
        &["claude code", "claude max"],
        HookIntegration::FullLifecycle,
        VersionProbe::Semver {
            args: &["--version"],
            fallback_args: None,
        },
        LatestVersionSource::NpmJson {
            url: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest",
        },
        UpdateGuidance::Command {
            command: "claude update",
        },
    ),
    agent(
        "codex",
        "Codex",
        &["codex", "codex-rs", "codex-tui", "codex-cli"],
        &["codex", "codex-rs", "codex-tui", "codex-cli"],
        &["openai codex", "codex cli", ">_ codex", "openai/codex"],
        HookIntegration::FullLifecycle,
        VersionProbe::Codex {
            args: &["--version"],
        },
        LatestVersionSource::NpmJson {
            url: "https://registry.npmjs.org/%40openai%2Fcodex/latest",
        },
        UpdateGuidance::CodexInstallPath {
            docs_url: "https://github.com/openai/codex",
        },
    ),
    agent(
        "antigravity",
        "Antigravity",
        &["agy", "antigravity", "antigravity-cli"],
        &["agy", "antigravity", "antigravity-cli"],
        &["antigravity"],
        HookIntegration::FullLifecycle,
        VersionProbe::Semver {
            args: &["--version"],
            fallback_args: None,
        },
        LatestVersionSource::AntigravityInstaller {
            url: "https://antigravity.google/cli/install.sh",
        },
        UpdateGuidance::Command {
            command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        },
    ),
    agent(
        "cursor",
        "Cursor",
        &["cursor", "cursor-agent", "agent"],
        &["agent", "cursor-agent"],
        &["cursor agent", "cursor-agent"],
        HookIntegration::Identity,
        VersionProbe::CursorBuild {
            args: &["--version"],
        },
        LatestVersionSource::CursorInstaller {
            url: "https://cursor.com/install",
        },
        UpdateGuidance::ResolvedAlias { args: &["update"] },
    ),
    agent(
        "grok",
        "Grok",
        &["grok", "grok-build"],
        &["grok", "grok-build"],
        &["grok build", "grok cli"],
        HookIntegration::None,
        VersionProbe::Semver {
            args: &["version"],
            fallback_args: Some(&["--version"]),
        },
        LatestVersionSource::GrokCli,
        UpdateGuidance::Command {
            command: "grok update",
        },
    ),
    agent(
        "opencode",
        "OpenCode",
        &["opencode", "open-code"],
        &["opencode", "open-code"],
        &["opencode"],
        HookIntegration::FullLifecycle,
        VersionProbe::Semver {
            args: &["--version"],
            fallback_args: None,
        },
        LatestVersionSource::NpmJson {
            url: "https://registry.npmjs.org/opencode-ai/latest",
        },
        UpdateGuidance::Command {
            command: "opencode upgrade",
        },
    ),
    agent(
        "pi",
        "Pi",
        &["pi"],
        &["pi"],
        &[],
        HookIntegration::FullLifecycle,
        VersionProbe::Semver {
            args: &["--version"],
            fallback_args: Some(&["-v"]),
        },
        LatestVersionSource::PiJson {
            url: "https://pi.dev/api/latest-version",
        },
        UpdateGuidance::Command {
            command: "pi update --self",
        },
    ),
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
            .process_binary_names
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
    fn cursor_discovery_excludes_desktop_ide_alias() {
        let cursor = get("cursor").unwrap();
        assert!(cursor.process_binary_names.contains(&"cursor"));
        assert_eq!(cursor.discovery_binary_names, &["agent", "cursor-agent"]);
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
            for binary in agent.process_binary_names {
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
