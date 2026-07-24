use std::collections::HashSet;
use std::process::Command;

const SENTINEL: &str = "__VERNE_AGENT_BIN__:";

pub fn valid_bin(bin: &str) -> bool {
    !bin.is_empty()
        && bin
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub fn parse_available(stdout: &str, requested: &[String]) -> Vec<String> {
    let found: HashSet<&str> = stdout
        .lines()
        .filter_map(|line| {
            line.find(SENTINEL)
                .map(|start| &line[start + SENTINEL.len()..])
        })
        .filter(|bin| valid_bin(bin))
        .collect();
    let mut seen = HashSet::new();
    requested
        .iter()
        .filter(|bin| found.contains(bin.as_str()) && seen.insert(bin.as_str()))
        .cloned()
        .collect()
}

pub fn probe_available(shell: &str, bins: &[String]) -> Result<Vec<String>, String> {
    if bins.iter().any(|bin| !valid_bin(bin)) {
        return Err("invalid agent binary name".into());
    }
    let script = bins
        .iter()
        .map(|bin| format!("command -v {bin} >/dev/null 2>&1 && printf '{SENTINEL}%s\\n' {bin}"))
        .collect::<Vec<_>>()
        .join("; ");
    let output = Command::new(shell)
        .args(["-ilc", &script])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(parse_available(
        &String::from_utf8_lossy(&output.stdout),
        bins,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_registry_binary_names_only() {
        assert!(valid_bin("cursor-agent"));
        assert!(valid_bin("opencode"));
        assert!(!valid_bin("codex; touch /tmp/no"));
        assert!(!valid_bin("../claude"));
        assert!(!valid_bin(""));
    }

    #[test]
    fn parses_only_sentinel_records_in_request_order() {
        let requested = vec!["claude".into(), "codex".into(), "agy".into()];
        let stdout =
            "\u{1b}c\u{1b}[3Jshell banner\n__VERNE_AGENT_BIN__:agy\n__VERNE_AGENT_BIN__:claude\n";
        assert_eq!(parse_available(stdout, &requested), vec!["claude", "agy"]);
    }

    #[test]
    fn ignores_spoofed_plain_binary_lines() {
        assert!(parse_available("claude\n", &["claude".into()]).is_empty());
    }
}
