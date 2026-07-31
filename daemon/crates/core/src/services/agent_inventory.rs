use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::services::agent_registry::{
    AgentDefinition, LatestVersionSource, UpdateGuidance, VersionProbe, AGENTS,
};

const SENTINEL: &str = "__VERNE_AGENT_INVENTORY__:";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryStatus {
    Available,
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInventoryProbeItem {
    pub key: String,
    pub display_name: String,
    pub discovery_status: DiscoveryStatus,
    pub resolved_binary: Option<String>,
    pub resolved_alias: Option<String>,
    pub version_probe: VersionProbe,
    pub latest_source: LatestVersionSource,
    pub update: UpdateGuidance,
}

pub fn probe(shell: &str, timeout: Duration) -> Result<Vec<AgentInventoryProbeItem>, String> {
    let script = probe_script()?;
    let output = run_shell_timed(shell, &script, timeout)?;
    Ok(parse_probe_output(&String::from_utf8_lossy(&output.stdout)))
}

pub fn parse_probe_output(stdout: &str) -> Vec<AgentInventoryProbeItem> {
    let mut records: HashMap<(&str, &str), &str> = HashMap::new();

    for line in stdout.lines() {
        let Some(record) = line.strip_prefix(SENTINEL) else {
            continue;
        };
        let mut fields = record.split('\t');
        let (Some(key), Some(alias), Some(path), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Some(agent) = AGENTS.iter().find(|agent| agent.key == key) else {
            continue;
        };
        let Some(&known_alias) = agent
            .discovery_binary_names
            .iter()
            .find(|known_alias| **known_alias == alias)
        else {
            continue;
        };
        if !Path::new(path).is_absolute() {
            continue;
        }
        records.entry((agent.key, known_alias)).or_insert(path);
    }

    AGENTS
        .iter()
        .map(|agent| probe_item(agent, &records))
        .collect()
}

fn probe_item(
    agent: &AgentDefinition,
    records: &HashMap<(&str, &str), &str>,
) -> AgentInventoryProbeItem {
    let resolved = agent.discovery_binary_names.iter().find_map(|alias| {
        records
            .get(&(agent.key, *alias))
            .map(|path| (*alias, *path))
    });
    let (discovery_status, resolved_alias, resolved_binary) = match resolved {
        Some((alias, path)) => (
            DiscoveryStatus::Available,
            Some(alias.to_string()),
            Some(path.to_string()),
        ),
        None => (DiscoveryStatus::Missing, None, None),
    };
    AgentInventoryProbeItem {
        key: agent.key.to_string(),
        display_name: agent.display_name.to_string(),
        discovery_status,
        resolved_binary,
        resolved_alias,
        version_probe: agent.version_probe,
        latest_source: agent.latest_source,
        update: agent.update,
    }
}

fn probe_script() -> Result<String, String> {
    AGENTS
        .iter()
        .flat_map(|agent| {
            agent
                .discovery_binary_names
                .iter()
                .map(move |alias| (agent.key, *alias))
        })
        .map(|(key, alias)| {
            if !valid_shell_token(alias) {
                return Err(format!("invalid discovery alias: {alias}"));
            }
            Ok(format!(
                "if resolved=$(command -v {alias} 2>/dev/null); then printf '{SENTINEL}%s\\t%s\\t%s\\n' '{key}' '{alias}' \"$resolved\"; fi"
            ))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|commands| commands.join("; "))
}

fn valid_shell_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn run_shell_timed(
    shell: &str,
    script: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = Command::new(shell)
        .args(["-ilc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn agent inventory shell: {error}"))?;
    let deadline = Instant::now() + timeout;

    loop {
        if child
            .try_wait()
            .map_err(|error| format!("wait for agent inventory shell: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("read agent inventory shell output: {error}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "agent inventory probe timed out after {}ms",
                timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    use super::{parse_probe_output, probe, DiscoveryStatus};

    #[test]
    fn parser_returns_registry_order_and_absolute_paths() {
        let stdout = concat!(
            "__VERNE_AGENT_INVENTORY__:opencode\topencode\t/opt/bin/opencode\n",
            "__VERNE_AGENT_INVENTORY__:claude\tclaude\t/usr/local/bin/claude\n",
        );
        let rows = parse_probe_output(stdout);
        assert_eq!(rows[0].key, "claude");
        assert_eq!(rows[0].resolved_alias.as_deref(), Some("claude"));
        assert_eq!(rows[1].key, "codex");
        assert_eq!(rows[1].discovery_status, DiscoveryStatus::Missing);
        assert_eq!(rows[5].key, "opencode");
    }

    #[test]
    fn parser_serializes_all_registry_metadata() {
        let rows = parse_probe_output("");
        assert_eq!(
            serde_json::to_value(rows).unwrap(),
            serde_json::json!([
                {
                    "key": "claude", "displayName": "Claude", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "semver", "args": ["--version"], "fallback_args": null},
                    "latestSource": {"kind": "npm-json", "url": "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"},
                    "update": {"kind": "command", "command": "claude update"}
                },
                {
                    "key": "codex", "displayName": "Codex", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "codex", "args": ["--version"]},
                    "latestSource": {"kind": "npm-json", "url": "https://registry.npmjs.org/%40openai%2Fcodex/latest"},
                    "update": {"kind": "codex-install-path", "docs_url": "https://github.com/openai/codex"}
                },
                {
                    "key": "antigravity", "displayName": "Antigravity", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "semver", "args": ["--version"], "fallback_args": null},
                    "latestSource": {"kind": "antigravity-installer", "url": "https://antigravity.google/cli/install.sh"},
                    "update": {"kind": "command", "command": "curl -fsSL https://antigravity.google/cli/install.sh | bash"}
                },
                {
                    "key": "cursor", "displayName": "Cursor", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "cursor-build", "args": ["--version"]},
                    "latestSource": {"kind": "cursor-installer", "url": "https://cursor.com/install"},
                    "update": {"kind": "resolved-alias", "args": ["update"]}
                },
                {
                    "key": "grok", "displayName": "Grok", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "semver", "args": ["version"], "fallback_args": ["--version"]},
                    "latestSource": {"kind": "grok-cli"},
                    "update": {"kind": "command", "command": "grok update"}
                },
                {
                    "key": "opencode", "displayName": "OpenCode", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "semver", "args": ["--version"], "fallback_args": null},
                    "latestSource": {"kind": "npm-json", "url": "https://registry.npmjs.org/opencode-ai/latest"},
                    "update": {"kind": "command", "command": "opencode upgrade"}
                },
                {
                    "key": "pi", "displayName": "Pi", "discoveryStatus": "missing",
                    "resolvedBinary": null, "resolvedAlias": null,
                    "versionProbe": {"kind": "semver", "args": ["--version"], "fallback_args": ["-v"]},
                    "latestSource": {"kind": "pi-json", "url": "https://pi.dev/api/latest-version"},
                    "update": {"kind": "command", "command": "pi update --self"}
                }
            ])
        );
    }

    #[test]
    fn parser_rejects_malformed_sentinels_and_relative_paths() {
        let stdout = concat!(
            "claude\tclaude\t/usr/local/bin/claude\n",
            "__VERNE_AGENT_INVENTORY__:claude\tclaude\n",
            "__VERNE_AGENT_INVENTORY__:claude\tclaude\tbin/claude\n",
            "__VERNE_AGENT_INVENTORY__:claude\tcodex\t/usr/local/bin/claude\n",
            "__VERNE_AGENT_INVENTORY__:unknown\tunknown\t/usr/local/bin/unknown\n",
        );
        let claude = &parse_probe_output(stdout)[0];
        assert_eq!(claude.discovery_status, DiscoveryStatus::Missing);
        assert_eq!(claude.resolved_binary, None);
    }

    #[test]
    fn parser_keeps_the_first_duplicate_record() {
        let stdout = concat!(
            "__VERNE_AGENT_INVENTORY__:claude\tclaude\t/opt/bin/claude\n",
            "__VERNE_AGENT_INVENTORY__:claude\tclaude\t/usr/local/bin/claude\n",
        );
        let claude = &parse_probe_output(stdout)[0];
        assert_eq!(claude.resolved_binary.as_deref(), Some("/opt/bin/claude"));
    }

    #[test]
    fn parser_prefers_the_first_configured_discovery_alias() {
        let stdout = concat!(
            "__VERNE_AGENT_INVENTORY__:cursor\tcursor-agent\t/opt/bin/cursor-agent\n",
            "__VERNE_AGENT_INVENTORY__:cursor\tagent\t/opt/bin/agent\n",
        );
        let cursor = &parse_probe_output(stdout)[3];
        assert_eq!(cursor.resolved_alias.as_deref(), Some("agent"));
        assert_eq!(cursor.resolved_binary.as_deref(), Some("/opt/bin/agent"));
    }

    #[test]
    fn probe_times_out_and_kills_a_slow_login_shell() {
        let temp = tempfile::tempdir().unwrap();
        let shell = temp.path().join("slow-shell");
        fs::write(&shell, "#!/bin/sh\nexec sleep 5\n").unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();

        let started = Instant::now();
        let error = probe(shell.to_str().unwrap(), Duration::from_millis(20)).unwrap_err();

        assert!(error.contains("timed out after"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
