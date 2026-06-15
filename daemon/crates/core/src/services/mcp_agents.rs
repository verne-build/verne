//! Per-agent registration of the Verne notes MCP server (`verne mcp`).
//!
//! Kept SEPARATE from agent detection on purpose: detection is
//! manifest/hook-driven and orthogonal to MCP registration, and two of these
//! agents (Cursor, OpenCode) aren't detected yet. Keyed by stable agent
//! identifiers.
//!
//! Registration is GLOBAL (user scope) and USER-TRIGGERED from Settings — nothing
//! here runs at startup. The server scopes itself per-workspace at runtime via
//! `VERNE_WORKSPACE_DIR` (Verne injects it into the PTY); see `mcp::resolve_workspace`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;

/// Per-agent status for the Settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub key: String,
    pub display_name: String,
    /// "notDetected" | "detected" | "registered" | "needsApproval" | "error"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Per-agent metadata that does not shell out or inspect user config.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub key: String,
    pub display_name: String,
}

pub enum Status {
    NotDetected,
    Detected,
    Registered,
    NeedsApproval,
    Error(String),
}

impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Status::NotDetected => "notDetected",
            Status::Detected => "detected",
            Status::Registered => "registered",
            Status::NeedsApproval => "needsApproval",
            Status::Error(_) => "error",
        }
    }
    fn detail(&self) -> Option<String> {
        match self {
            Status::Error(e) => Some(e.clone()),
            _ => None,
        }
    }
}

/// Tests set this to avoid writing into real agent configs / shelling out.
fn install_disabled() -> bool {
    std::env::var_os("VERNE_SKIP_MCP_INSTALL").is_some()
}

/// Registration name (and thus the agent-facing `mcp__<name>__*` tool namespace)
/// for the Verne notes server. Flavored by build so a dev and a prod install
/// register SEPARATE entries in the shared user-scope agent config instead of
/// clobbering each other's command path — which would route notes writes to
/// the wrong (`build.verne` vs `build.verne-dev`) data dir. Must stay paired
/// with `verne_binary()`'s flavored symlink.
pub fn mcp_server_name() -> &'static str {
    if cfg!(debug_assertions) { "verne-dev" } else { "verne" }
}

/// The stable launcher path baked into agent configs: the `~/.local/bin/verne`
/// (or `verne-dev`) symlink that `ensure_cli_symlink` refreshes every GUI launch,
/// so registrations survive app updates without re-registration. Falls back to the
/// running executable if the symlink is somehow absent.
pub fn verne_binary() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let name = if cfg!(debug_assertions) { "verne-dev" } else { "verne" };
        let link = home.join(".local/bin").join(name);
        if link.exists() {
            return link;
        }
    }
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("verne"))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file()
        && p.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Resolve the first of `names` found on the user's login-shell PATH.
fn resolve_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = crate::services::session_manager::shell_path();
    for dir in std::env::split_paths(&path) {
        for n in names {
            let p = dir.join(n);
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Run an agent CLI with the login-shell PATH so it can find node/bun/etc.
fn run(bin: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(bin)
        .args(args)
        .env("PATH", crate::services::session_manager::shell_path())
        .output()
        .map_err(|e| e.to_string())
}

// --- JSON config helpers (Cursor / OpenCode) ---

fn load_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

/// Insert/replace `outer[name] = entry`, creating `outer` if needed, preserving
/// every other key. Pure (no I/O) so it's unit-testable.
fn json_set_nested(cfg: &mut Value, outer: &str, name: &str, entry: Value) -> Result<(), String> {
    let obj = cfg.as_object_mut().ok_or("config is not a JSON object")?;
    let inner = obj
        .entry(outer)
        .or_insert_with(|| Value::Object(Default::default()));
    let inner = inner
        .as_object_mut()
        .ok_or_else(|| format!("{outer} is not a JSON object"))?;
    inner.insert(name.to_string(), entry);
    Ok(())
}

/// Remove `outer[name]` if present, preserving everything else.
fn json_remove_nested(cfg: &mut Value, outer: &str, name: &str) {
    if let Some(inner) = cfg
        .as_object_mut()
        .and_then(|o| o.get_mut(outer))
        .and_then(|v| v.as_object_mut())
    {
        inner.remove(name);
    }
}

fn save_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_file_name(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("cfg"),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

// --- trait ---

pub trait McpAgent: Send + Sync {
    fn key(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn binary_names(&self) -> &'static [&'static str];

    fn detected(&self) -> bool {
        resolve_on_path(self.binary_names()).is_some()
    }
    fn ensure_mcp(&self, verne: &Path) -> Result<(), String>;
    fn remove_mcp(&self) -> Result<(), String>;
    fn status(&self) -> Status;
    /// Copy-paste install steps for users who'd rather do it manually.
    fn manual_commands(&self, verne: &Path) -> String;

    fn status_row(&self) -> AgentStatus {
        let s = self.status();
        AgentStatus {
            key: self.key().to_string(),
            display_name: self.display_name().to_string(),
            status: s.as_str().to_string(),
            detail: s.detail(),
        }
    }

    fn info_row(&self) -> AgentInfo {
        AgentInfo {
            key: self.key().to_string(),
            display_name: self.display_name().to_string(),
        }
    }
}

pub fn all_agents() -> Vec<Box<dyn McpAgent>> {
    vec![
        Box::new(Claude),
        Box::new(Codex),
        Box::new(Cursor),
        Box::new(OpenCode),
    ]
}

pub fn get_agent(key: &str) -> Option<Box<dyn McpAgent>> {
    all_agents().into_iter().find(|a| a.key() == key)
}

pub fn status_all() -> Vec<AgentStatus> {
    all_agents().iter().map(|a| a.status_row()).collect()
}

pub fn status_one(key: &str) -> Option<AgentStatus> {
    get_agent(key).map(|a| a.status_row())
}

pub fn supported_agents() -> Vec<AgentInfo> {
    all_agents().iter().map(|a| a.info_row()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_nested_preserves_siblings_and_replaces_verne() {
        // A user config with an existing server + an unrelated top-level key.
        let mut cfg = serde_json::json!({
            "mcpServers": { "context7": { "command": "npx" } },
            "someUserSetting": true
        });
        json_set_nested(
            &mut cfg,
            "mcpServers",
            "verne",
            serde_json::json!({ "command": "/x/verne", "args": ["mcp"] }),
        )
        .unwrap();
        // Sibling server + unrelated key untouched; verne added.
        assert_eq!(cfg["mcpServers"]["context7"]["command"], "npx");
        assert_eq!(cfg["someUserSetting"], true);
        assert_eq!(cfg["mcpServers"]["verne"]["command"], "/x/verne");

        json_remove_nested(&mut cfg, "mcpServers", "verne");
        assert!(cfg["mcpServers"].get("verne").is_none());
        assert_eq!(cfg["mcpServers"]["context7"]["command"], "npx");
    }

    #[test]
    fn set_nested_creates_outer_when_missing() {
        let mut cfg = serde_json::json!({});
        json_set_nested(&mut cfg, "mcp", "verne", serde_json::json!({ "type": "local" })).unwrap();
        assert_eq!(cfg["mcp"]["verne"]["type"], "local");
    }

    #[test]
    fn atomic_json_roundtrip_no_temp_left() {
        let tmp = std::env::temp_dir().join(format!("verne-mcpcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let path = tmp.join("nested/cfg.json");
        let v = serde_json::json!({ "a": 1 });
        save_json_atomic(&path, &v).unwrap();
        assert_eq!(load_json(&path)["a"], 1);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

// --- Claude (CLI, user scope) ---

struct Claude;
impl McpAgent for Claude {
    fn key(&self) -> &'static str { "claude" }
    fn display_name(&self) -> &'static str { "Claude Code" }
    fn binary_names(&self) -> &'static [&'static str] { &["claude"] }

    fn ensure_mcp(&self, _verne: &Path) -> Result<(), String> {
        if install_disabled() { return Ok(()); }
        let bin = resolve_on_path(self.binary_names()).ok_or("claude CLI not found")?;
        let v = crate::paths::mcp_launcher_path().to_string_lossy().to_string();
        let name = mcp_server_name();
        // Idempotent: remove any prior entry, then add fresh (refreshes the path).
        let _ = run(&bin, &["mcp", "remove", name]);
        let out = run(&bin, &["mcp", "add", "--scope", "user", "--transport", "stdio", name, "--", &v])?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn remove_mcp(&self) -> Result<(), String> {
        let bin = resolve_on_path(self.binary_names()).ok_or("claude CLI not found")?;
        let _ = run(&bin, &["mcp", "remove", mcp_server_name()]);
        Ok(())
    }

    fn status(&self) -> Status {
        let Some(bin) = resolve_on_path(self.binary_names()) else { return Status::NotDetected };
        match run(&bin, &["mcp", "get", mcp_server_name()]) {
            Ok(o) if o.status.success() => Status::Registered,
            Ok(_) => Status::Detected,
            Err(e) => Status::Error(e),
        }
    }

    fn manual_commands(&self, _verne: &Path) -> String {
        format!(
            "claude mcp add --scope user --transport stdio {} -- {}",
            mcp_server_name(),
            crate::paths::mcp_launcher_path().to_string_lossy()
        )
    }
}

// --- Codex (CLI add + toml_edit env_vars patch) ---

struct Codex;

impl Codex {
    fn config_path() -> PathBuf {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
            .join("config.toml")
    }

    /// Add `env_vars = ["VERNE_WORKSPACE_DIR", "VERNE_INTERNAL_DATA_DIR"]` to
    /// `[mcp_servers.verne]`, preserving the rest of the file's formatting. Codex
    /// forwards env by allowlist, so this is required for the server to receive the
    /// workspace root and to locate browser-control.json (other agents inherit the
    /// full PTY env; Codex does not).
    fn patch_env_vars() -> Result<(), String> {
        use toml_edit::{Array, DocumentMut, Item, Value as TomlValue};
        let path = Self::config_path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let mut doc = text.parse::<DocumentMut>().map_err(|e| e.to_string())?;
        let mut arr = Array::new();
        arr.push("VERNE_WORKSPACE_DIR");
        arr.push("VERNE_INTERNAL_DATA_DIR");
        doc["mcp_servers"][mcp_server_name()]["env_vars"] = Item::Value(TomlValue::Array(arr));
        std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
    }
}

impl McpAgent for Codex {
    fn key(&self) -> &'static str { "codex" }
    fn display_name(&self) -> &'static str { "Codex" }
    fn binary_names(&self) -> &'static [&'static str] { &["codex"] }

    fn ensure_mcp(&self, _verne: &Path) -> Result<(), String> {
        if install_disabled() { return Ok(()); }
        let bin = resolve_on_path(self.binary_names()).ok_or("codex CLI not found")?;
        let v = crate::paths::mcp_launcher_path().to_string_lossy().to_string();
        let name = mcp_server_name();
        let _ = run(&bin, &["mcp", "remove", name]);
        let out = run(&bin, &["mcp", "add", name, "--", &v])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        // Forward the workspace root (allowlist) so worktrees key correctly.
        Self::patch_env_vars()
    }

    fn remove_mcp(&self) -> Result<(), String> {
        let bin = resolve_on_path(self.binary_names()).ok_or("codex CLI not found")?;
        let _ = run(&bin, &["mcp", "remove", mcp_server_name()]);
        Ok(())
    }

    fn status(&self) -> Status {
        let Some(bin) = resolve_on_path(self.binary_names()) else { return Status::NotDetected };
        match run(&bin, &["mcp", "get", mcp_server_name()]) {
            Ok(o) if o.status.success() => Status::Registered,
            Ok(_) => Status::Detected,
            Err(e) => Status::Error(e),
        }
    }

    fn manual_commands(&self, _verne: &Path) -> String {
        let name = mcp_server_name();
        format!(
            "codex mcp add {name} -- {}\n# then add to ~/.codex/config.toml under [mcp_servers.{name}]:\n#   env_vars = [\"VERNE_WORKSPACE_DIR\", \"VERNE_INTERNAL_DATA_DIR\"]",
            crate::paths::mcp_launcher_path().to_string_lossy()
        )
    }
}

// --- Cursor CLI (`agent`) — write ~/.cursor/mcp.json + `agent mcp enable` ---

struct Cursor;

impl Cursor {
    fn config_path() -> PathBuf {
        dirs::home_dir().unwrap_or_default().join(".cursor/mcp.json")
    }
}

impl McpAgent for Cursor {
    fn key(&self) -> &'static str { "cursor" }
    fn display_name(&self) -> &'static str { "Cursor CLI" }
    fn binary_names(&self) -> &'static [&'static str] { &["cursor-agent", "agent"] }

    fn ensure_mcp(&self, _verne: &Path) -> Result<(), String> {
        if install_disabled() { return Ok(()); }
        let path = Self::config_path();
        let name = mcp_server_name();
        let v = crate::paths::mcp_launcher_path().to_string_lossy().to_string();
        let mut cfg = load_json(&path);
        json_set_nested(
            &mut cfg,
            "mcpServers",
            name,
            serde_json::json!({
                "command": v,
                "args": [],
                "env": { "VERNE_WORKSPACE_DIR": "${env:VERNE_WORKSPACE_DIR}" }
            }),
        )?;
        save_json_atomic(&path, &cfg)?;
        // Move it onto the approved list so it loads without an interactive prompt.
        if let Some(bin) = resolve_on_path(self.binary_names()) {
            let _ = run(&bin, &["mcp", "enable", name]);
        }
        Ok(())
    }

    fn remove_mcp(&self) -> Result<(), String> {
        let name = mcp_server_name();
        if let Some(bin) = resolve_on_path(self.binary_names()) {
            let _ = run(&bin, &["mcp", "disable", name]);
        }
        let path = Self::config_path();
        let mut cfg = load_json(&path);
        json_remove_nested(&mut cfg, "mcpServers", name);
        save_json_atomic(&path, &cfg)
    }

    fn status(&self) -> Status {
        let detected = self.detected();
        let name = mcp_server_name();
        let registered = load_json(&Self::config_path())
            .get("mcpServers")
            .and_then(|s| s.get(name))
            .is_some();
        if !registered {
            return if detected { Status::Detected } else { Status::NotDetected };
        }
        // Registered in mcp.json — check whether the CLI has it loaded vs. pending approval.
        if let Some(bin) = resolve_on_path(self.binary_names()) {
            if let Ok(o) = run(&bin, &["mcp", "list"]) {
                let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
                let pending = text
                    .lines()
                    .any(|l| l.contains(name) && l.contains("approval"));
                return if pending { Status::NeedsApproval } else { Status::Registered };
            }
        }
        Status::Registered
    }

    fn manual_commands(&self, _verne: &Path) -> String {
        let name = mcp_server_name();
        format!(
            "# add to ~/.cursor/mcp.json under \"mcpServers\":\n\
             \"{name}\": {{ \"command\": \"{}\", \"args\": [], \"env\": {{ \"VERNE_WORKSPACE_DIR\": \"${{env:VERNE_WORKSPACE_DIR}}\" }} }}\n\
             # then approve it:\n\
             agent mcp enable {name}",
            crate::paths::mcp_launcher_path().to_string_lossy()
        )
    }
}

// --- OpenCode — write ~/.config/opencode/opencode.json ---

struct OpenCode;

impl OpenCode {
    fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".config/opencode/opencode.json")
    }
}

impl McpAgent for OpenCode {
    fn key(&self) -> &'static str { "opencode" }
    fn display_name(&self) -> &'static str { "OpenCode" }
    fn binary_names(&self) -> &'static [&'static str] { &["opencode"] }

    fn ensure_mcp(&self, _verne: &Path) -> Result<(), String> {
        if install_disabled() { return Ok(()); }
        let path = Self::config_path();
        let v = crate::paths::mcp_launcher_path().to_string_lossy().to_string();
        let mut cfg = load_json(&path);
        json_set_nested(
            &mut cfg,
            "mcp",
            mcp_server_name(),
            serde_json::json!({
                "type": "local",
                "command": [v],
                "enabled": true
            }),
        )?;
        save_json_atomic(&path, &cfg)
    }

    fn remove_mcp(&self) -> Result<(), String> {
        let path = Self::config_path();
        let mut cfg = load_json(&path);
        json_remove_nested(&mut cfg, "mcp", mcp_server_name());
        save_json_atomic(&path, &cfg)
    }

    fn status(&self) -> Status {
        let registered = load_json(&Self::config_path())
            .get("mcp")
            .and_then(|m| m.get(mcp_server_name()))
            .is_some();
        if registered {
            Status::Registered
        } else if self.detected() {
            Status::Detected
        } else {
            Status::NotDetected
        }
    }

    fn manual_commands(&self, _verne: &Path) -> String {
        format!(
            "# add to ~/.config/opencode/opencode.json under \"mcp\":\n\
             \"{}\": {{ \"type\": \"local\", \"command\": [\"{}\"], \"enabled\": true }}",
            mcp_server_name(),
            crate::paths::mcp_launcher_path().to_string_lossy()
        )
    }
}
