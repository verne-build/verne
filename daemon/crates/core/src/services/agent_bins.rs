use std::collections::HashSet;
use std::process::Command;

pub fn valid_bin(bin: &str) -> bool {
    !bin.is_empty()
        && bin
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub fn parse_available(stdout: &str, requested: &[String]) -> Vec<String> {
    let found: HashSet<&str> = stdout.lines().collect();
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
        .map(|bin| format!("command -v {bin} >/dev/null 2>&1 && printf '%s\\n' {bin}"))
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
    fn parses_available_bins_without_duplicates() {
        let requested = vec!["codex".into(), "claude".into(), "codex".into()];
        assert_eq!(
            parse_available("claude\ncodex\n", &requested),
            vec!["codex", "claude"]
        );
    }
}
