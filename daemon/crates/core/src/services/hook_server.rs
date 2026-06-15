use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::services::agent_shadow::AgentShadow;
use crate::services::jsonl_reader::{FileOpType, FileOperation};

type ShadowCache = Arc<Mutex<HashMap<String, AgentShadow>>>;

fn with_shadow<F, R>(
    shadows: &ShadowCache,
    internal_data_dir: &std::path::Path,
    agent_id: &str,
    f: F,
) -> Option<R>
where
    F: FnOnce(&AgentShadow) -> R,
{
    let mut guard = match shadows.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("[hook] shadows lock poisoned: {}", e);
            return None;
        }
    };
    if !guard.contains_key(agent_id) {
        match AgentShadow::open(internal_data_dir, agent_id) {
            Ok(s) => {
                guard.insert(agent_id.to_string(), s);
            }
            Err(e) => {
                log::error!("[hook] open shadow: {}", e);
                return None;
            }
        }
    }
    Some(f(guard.get(agent_id).unwrap()))
}

/// Canonical mapping from a hook event + payload to the tab's AgentState.
/// Hook events carry richer, non-conflated state signals; this dedicated
/// mapping lets the UI distinguish Blocked (needs human input) from Working
/// (running).
pub fn hook_to_state(event_type: &str, approval_required: bool) -> Option<&'static str> {
    match event_type {
        "PreToolUse" | "preToolUse" if approval_required => Some("blocked"),
        "PreToolUse" | "preToolUse" => Some("working"),
        "PostToolUse" | "postToolUse" => Some("working"),
        "SubagentStop" | "subagentStop" => Some("working"),
        "UserPromptSubmit" | "userPromptSubmit" | "userPromptSubmitted" => Some("working"),
        // Antigravity/agy (PreInvocation/PostInvocation) + Cursor
        // (beforeSubmitPrompt) lifecycle events. agy's PreToolUse/PostToolUse/Stop
        // and Cursor's preToolUse/postToolUse/stop/sessionStart are handled above.
        "PreInvocation" | "PostInvocation" | "beforeSubmitPrompt" => Some("working"),
        // Cursor terminal CLI fires only these two today.
        "beforeShellExecution" | "afterShellExecution" => Some("working"),
        "SessionStart" | "sessionStart" => Some("idle"),
        "SessionEnd" | "sessionEnd" => Some("idle"),
        "Notification" | "notification" => Some("idle"),
        "Stop" | "stop" => Some("idle"),
        "PermissionRequest" | "permissionRequest" => Some("blocked"),
        _ => None,
    }
}

#[cfg(test)]
mod hook_mapping_tests {
    use super::hook_to_state;

    #[test]
    fn maps_every_installed_lifecycle_event() {
        for event in [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "PermissionRequest",
            "PreToolUse",
            "PostToolUse",
            "sessionStart",
            "userPromptSubmitted",
            "preToolUse",
            "postToolUse",
            "sessionEnd",
            "PreInvocation",
            "PostInvocation",
            "beforeSubmitPrompt",
            "beforeShellExecution",
            "afterShellExecution",
            "stop",
        ] {
            assert!(
                hook_to_state(event, false).is_some(),
                "unmapped event: {event}"
            );
        }
    }

    #[test]
    fn unknown_event_does_not_update_state() {
        assert_eq!(hook_to_state("futureEvent", false), None);
    }
}

/// Snapshot a file's git-HEAD content (or working-tree content if untracked) as
/// the baseline if no baseline exists yet for this rel_path.
/// Returns true if a snapshot was taken.
fn snapshot_baseline_if_missing(
    shadows: &ShadowCache,
    internal_data_dir: &std::path::Path,
    agent_id: &str,
    working_dir: &str,
    op: &FileOperation,
) -> bool {
    let wd = working_dir.trim_end_matches('/');
    let rel_path = match op.file_path.strip_prefix(wd) {
        Some(s) => s.trim_start_matches('/').to_string(),
        None => return false,
    };
    if rel_path.is_empty() {
        return false;
    }
    with_shadow(shadows, internal_data_dir, agent_id, |shadow| {
        if shadow.has_baseline(&rel_path) {
            return false;
        }
        let content = crate::services::agent_shadow::read_file_from_git_head(wd, &op.file_path)
            .or_else(|| std::fs::read_to_string(&op.file_path).ok());
        if let Some(content) = content {
            let _ = shadow.commit_file(&rel_path, &content, true);
            true
        } else {
            false
        }
    })
    .unwrap_or(false)
}

/// Snapshot a file's current working-tree content as an update.
/// Auto-creates a baseline first if none exists.
fn snapshot_update(
    shadows: &ShadowCache,
    internal_data_dir: &std::path::Path,
    agent_id: &str,
    working_dir: &str,
    op: &FileOperation,
) -> bool {
    let wd = working_dir.trim_end_matches('/');
    let rel_path = match op.file_path.strip_prefix(wd) {
        Some(s) => s.trim_start_matches('/').to_string(),
        None => return false,
    };
    if rel_path.is_empty() {
        return false;
    }
    with_shadow(shadows, internal_data_dir, agent_id, |shadow| {
        if !shadow.has_baseline(&rel_path) {
            if let Some(git_content) =
                crate::services::agent_shadow::read_file_from_git_head(wd, &op.file_path)
            {
                let _ = shadow.commit_file(&rel_path, &git_content, true);
            }
        }
        match std::fs::read_to_string(&op.file_path) {
            Ok(c) => {
                let _ = shadow.commit_file(&rel_path, &c, false);
                true
            }
            Err(e) => {
                log::warn!("[hook] read {} err: {}", op.file_path, e);
                false
            }
        }
    })
    .unwrap_or(false)
}

/// Entry point for the sidecar RPC `agent_shadow_on_hook`. Called by Electron
/// when it receives the daemon's `agent-hook-fileops` event. Returns true if
/// any file was snapshotted (used to decide whether to emit agent-files-changed).
pub fn agent_shadow_on_hook(
    working_dir: &str,
    shadows: &ShadowCache,
    internal_data_dir: &std::path::Path,
    agent_id: &str,
    event: &str,
    tool_name: &str,
    tool_input: &serde_json::Value,
    agent_type: &str,
) -> bool {
    let is_pre = event == "PreToolUse" || event == "preToolUse";
    let is_post = event == "PostToolUse" || event == "postToolUse";
    if !is_pre && !is_post {
        return false;
    }
    // Electron supplies the working dir (the tab's cwd; agent_id == tab_id) so the
    // sidecar needs no DB. Empty means no resolvable tab → nothing to snapshot.
    if working_dir.is_empty() {
        return false;
    }
    let ops = crate::services::file_ops::extract_file_ops(agent_type, tool_name, tool_input);
    let mut snapshotted = false;
    for op in &ops {
        let did = if is_pre {
            snapshot_baseline_if_missing(shadows, internal_data_dir, agent_id, working_dir, op)
        } else if op.op == FileOpType::Read {
            false
        } else {
            snapshot_update(shadows, internal_data_dir, agent_id, working_dir, op)
        };
        if did {
            snapshotted = true;
        }
    }
    snapshotted
}

/// Entry point for the sidecar RPC `agent_shadow_resync`. Called by Electron
/// on startup to re-baseline tracked files after the app was closed. For each
/// live agent that has an open shadow, re-commits every tracked file with the
/// current on-disk content as a fresh baseline so diffs are consistent.
///
/// Electron supplies `(agent_id, working_dir)` pairs (from its tab rows) so the
/// sidecar needs no DB. The shadows lock is held briefly per-agent via
/// `with_shadow`, never across another lock.
pub fn agent_shadow_resync(
    shadows: &ShadowCache,
    internal_data_dir: &std::path::Path,
    agent_dirs: &[(String, String)],
) {
    for (agent_id, working_dir) in agent_dirs {
        let wd = working_dir.trim_end_matches('/');
        // Collect tracked rel_paths (brief shadows lock per call)
        let tracked = with_shadow(shadows, internal_data_dir, agent_id, |shadow| {
            shadow.tracked_rel_paths()
        })
        .unwrap_or_default();

        for rel_path in &tracked {
            let abs_path = format!("{}/{}", wd, rel_path);
            let content = crate::services::agent_shadow::read_file_from_git_head(wd, &abs_path)
                .or_else(|| std::fs::read_to_string(&abs_path).ok());
            if let Some(c) = content {
                // Brief shadows lock per commit
                with_shadow(shadows, internal_data_dir, agent_id, |shadow| {
                    let _ = shadow.commit_file(rel_path, &c, true);
                });
            }
        }
        log::info!("[resync] agent={} tracked={}", agent_id, tracked.len());
    }
}
