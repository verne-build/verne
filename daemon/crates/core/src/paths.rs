use std::path::PathBuf;

pub const BUNDLE_ID: &str = "build.verne";

/// `VERNE_INTERNAL_DATA_DIR` env var overrides the full path (used in tests/CI).
/// When set, `bundle_id` and `debug` are ignored.
pub fn internal_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VERNE_INTERNAL_DATA_DIR") {
        return PathBuf::from(dir);
    }
    internal_data_dir_for_bundle(BUNDLE_ID, cfg!(debug_assertions))
}

/// Pure bundle-id + dev-suffix path logic. No env override — the
/// `VERNE_INTERNAL_DATA_DIR` short-circuit lives in [`internal_data_dir`] so
/// that an explicit `debug` flag here always maps to the `-dev` suffix.
pub fn internal_data_dir_for_bundle(bundle_id: &str, debug: bool) -> PathBuf {
    let home = dirs::home_dir().expect("no home dir");
    let id = if debug { format!("{bundle_id}-dev") } else { bundle_id.to_string() };
    home.join("Library").join("Application Support").join(id)
}

pub fn user_data_dir() -> PathBuf {
    user_data_dir_for(cfg!(debug_assertions))
}

/// `VERNE_USER_DATA_DIR` env var overrides the full path (used in tests/CI).
/// When set, `debug` is ignored.
pub fn user_data_dir_for(debug: bool) -> PathBuf {
    if let Some(dir) = std::env::var_os("VERNE_USER_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = dirs::home_dir().expect("no home dir");
    if debug { home.join(".verne-dev") } else { home.join(".verne") }
}

pub fn socket_path() -> PathBuf {
    internal_data_dir().join("verne.sock")
}

/// RPC socket for the `verne-sidecar` process (DB/git/hooks/search/etc). Kept
/// separate from the daemon socket so the two processes have independent
/// lifecycles — the daemon survives Electron restarts, the sidecar does not.
pub fn sidecar_socket_path() -> PathBuf {
    internal_data_dir().join("verne-sidecar.sock")
}

pub fn sidecar_pid_file_path() -> PathBuf {
    internal_data_dir().join("verne-sidecar.pid")
}

/// Stable hook-server port. Pinned (not ephemeral) so the `notify.sh` the
/// sidecar writes keeps resolving across sidecar restarts. Honors
/// `VERNE_HOOK_PORT`; dev/prod default to distinct ports so two instances don't
/// collide. The sidecar still falls back to an ephemeral port if this is taken.
pub fn hook_port() -> u16 {
    if let Some(p) = std::env::var("VERNE_HOOK_PORT").ok().and_then(|v| v.parse::<u16>().ok()) {
        return p;
    }
    if cfg!(debug_assertions) { 9611 } else { 9610 }
}

pub fn browser_control_file() -> PathBuf {
    internal_data_dir().join("browser-control.json")
}

/// Persisted hook secret. Per data dir, so DEV/PROD stay isolated, but stable
/// across daemon restarts so the secret baked into notify.sh never desyncs when
/// the detached daemon is restarted out-of-band of Electron.
pub fn hook_secret_path() -> PathBuf {
    internal_data_dir().join("hook-secret")
}

/// Stable path of the Node MCP launcher script (written by Electron on launch).
/// Agents are configured to spawn this instead of the old `verne mcp`.
pub fn mcp_launcher_path() -> PathBuf {
    internal_data_dir().join("verne-mcp")
}

/// Notes storage dir for a workspace, keyed by a hash of its *root* (parent)
/// directory path so worktrees share their parent's notes. Single source of truth
/// for both the host Tauri commands and the `verne mcp` subcommand — the DB-aware
/// host resolves the root before calling; the DB-less MCP server gets the root via
/// `VERNE_WORKSPACE_DIR`. Both then hash the same path here.
pub fn notes_dir(root_path: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(root_path.as_bytes()));
    internal_data_dir().join("notes").join(hash)
}

/// xterm WebSocket bridge port. Honors `VERNE_WS_PORT` if set (so the Electron
/// supervisor can isolate dev from prod even when running a release binary),
/// else falls back to the build-time default. The renderer learns the actual
/// port via the `get_ws_port` RPC, so host and daemon always agree.
pub fn ws_port() -> u16 {
    if let Some(p) = std::env::var("VERNE_WS_PORT").ok().and_then(|v| v.parse::<u16>().ok()) {
        return p;
    }
    if cfg!(debug_assertions) { 9601 } else { 9600 }
}

pub fn pid_file_path() -> PathBuf {
    internal_data_dir().join("verne.pid")
}

pub fn server_log_path() -> PathBuf {
    internal_data_dir().join("server.log")
}

/// Symlink `~/.local/bin/verne` (or `verne-dev` for debug builds) to the
/// currently-running binary so the CLI is on PATH. Refreshed on every GUI
/// launch — newest install wins. Best-effort: returns Err but never aborts.
pub fn ensure_cli_symlink() -> std::io::Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    let bin_dir = home.join(".local").join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let name = if cfg!(debug_assertions) { "verne-dev" } else { "verne" };
    let link = bin_dir.join(name);
    let target = std::env::current_exe()?;
    if let Ok(existing) = std::fs::read_link(&link) {
        if existing == target { return Ok(link); }
    }
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link)?;
    }
    std::os::unix::fs::symlink(&target, &link)?;
    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards both the BUNDLE_ID value and the `-dev` suffix logic. Uses an
    // explicit bundle arg so it never reads the VERNE_INTERNAL_DATA_DIR env
    // (which other processes/tests may set).
    #[test]
    fn internal_dir_uses_build_verne_bundle_id() {
        let old_val = std::env::var_os("VERNE_INTERNAL_DATA_DIR");
        std::env::remove_var("VERNE_INTERNAL_DATA_DIR");

        assert_eq!(BUNDLE_ID, "build.verne");

        let prod = internal_data_dir_for_bundle("build.verne", false);
        let prod_ok = prod.ends_with("Library/Application Support/build.verne");

        let dev = internal_data_dir_for_bundle("build.verne", true);
        let dev_ok = dev.ends_with("Library/Application Support/build.verne-dev");

        if let Some(val) = old_val {
            std::env::set_var("VERNE_INTERNAL_DATA_DIR", val);
        }

        assert!(prod_ok, "prod dir was {prod:?}");
        assert!(dev_ok, "dev dir was {dev:?}");
    }
}
