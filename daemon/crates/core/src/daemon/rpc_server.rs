//! Sidecar RPC dispatch — the full non-PTY surface: DB, git, shadow git, hooks,
//! file search/watch, worktrees, settings, notes, MCP. Runs in the
//! `verne-sidecar` process via `rpc_serve::serve`. PTY/detection methods live in
//! `rpc_daemon` and are served by the daemon process instead.

use std::sync::Arc;

use crate::protocol::{Request, Response};
use crate::rpc_serve::BoxFut;

/// Box the async dispatch so it fits the `rpc_serve::serve` fn-pointer shape.
pub fn dispatch_boxed(req: Request, state: Arc<crate::state::AppState>) -> BoxFut {
    Box::pin(dispatch(req, state))
}

fn s(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn opt_s(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| {
        if x.is_null() { None } else { x.as_str().map(|s| s.to_string()) }
    })
}

/// Obtain a git worker handle wired to the daemon event bus (mirrors the
/// Tauri `repo_handle` helper but emits over the bus instead of an AppHandle).
fn git_handle(
    state: &Arc<crate::state::AppState>,
    path: &str,
) -> Result<crate::services::git_worker::GitRepoHandle, String> {
    let emitter = crate::emitter::Emitter::daemon(state.event_bus.clone());
    let visible = state
        .source_control_visible
        .load(std::sync::atomic::Ordering::Relaxed);
    crate::services::git_worker::handle_for_path(&state.git_workers, &emitter, visible, path)
}

/// Extract a `files: Vec<String>` param (git_stage/unstage/discard).
fn git_files(req: &Request) -> Vec<String> {
    req.params
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

async fn dispatch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    match req.method.as_str() {
        "ping" => Response::ok(req.id, serde_json::json!("pong")),
        "__debug_hook_port" => {
            if cfg!(debug_assertions) {
                let port = state.hook_port.load(std::sync::atomic::Ordering::Relaxed);
                Response::ok(req.id, serde_json::json!(port))
            } else {
                Response::err(req.id, "debug method disabled in release build".to_string())
            }
        }
        "__debug_hook_secret" => {
            if cfg!(debug_assertions) {
                let secret = state.hook_secret.lock().map(|g| g.clone()).unwrap_or_default();
                Response::ok(req.id, serde_json::json!(secret))
            } else {
                Response::err(req.id, "debug method disabled in release build".to_string())
            }
        }
        "__shutdown" => {
            log::info!("sidecar shutdown requested");
            // Hook uninstall moved to Electron before-quit (slice 4).
            let _ = std::fs::remove_file(crate::paths::sidecar_pid_file_path());
            let resp = Response::ok(req.id, serde_json::Value::Null);
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                std::process::exit(0);
            });
            resp
        }

        // Watcher/cache counters owned by the sidecar. The daemon serves the
        // session/tab-pid half via `get_daemon_diagnostics`; Electron merges.
        m if m == crate::protocol::methods::GET_SIDECAR_DIAGNOSTICS => {
            let result: Result<crate::types::SidecarDiagnostics, String> = (|| {
                let (file_watchers, directory_watchers) = {
                    let w = state.file_watchers.lock().map_err(|e| e.to_string())?;
                    (w.keys().filter(|k| !k.starts_with("dir:")).count() as u32,
                     w.keys().filter(|k| k.starts_with("dir:")).count() as u32)
                };
                let git_watchers = state.git_watchers.lock().map_err(|e| e.to_string())?.len() as u32;
                let (cached_file_indexes, cached_file_paths) = {
                    let c = state.file_list_cache.lock().map_err(|e| e.to_string())?;
                    (c.len() as u32, c.values().map(|e| e.files.len() as u32).sum())
                };
                // Electron owns the tabs DB now; it overrides agent_count from
                // its own connection when merging the diagnostics halves.
                Ok(crate::types::SidecarDiagnostics {
                    sidecar_pid: std::process::id(),
                    agent_count: 0,
                    file_watchers, directory_watchers, git_watchers,
                    cached_file_indexes, cached_file_paths,
                    source_control_visible: state.source_control_visible.load(std::sync::atomic::Ordering::Relaxed),
                })
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }

        // Slice 5b: DB-free agent-shadow teardown. Electron deletes the tab row
        // itself on close, then forwards this so the sidecar drops the in-memory
        // git2 repo + on-disk shadow tree (it still owns those resources).
        m if m == crate::protocol::methods::AGENT_SHADOW_CLEANUP => {
            let id = s(req.params.get("tabId"));
            crate::daemon::tabs::cleanup_agent_shadow(&state, &id);
            Response::ok(req.id, serde_json::json!(true))
        }
        // git_cmds.rs — daemon owns git workers; uses a Daemon emitter so
        // git status/refresh events flow over the event bus.
        m if m == crate::protocol::methods::GIT_STATUS => {
            let path = s(req.params.get("path"));
            let emitter = crate::emitter::Emitter::daemon(state.event_bus.clone());
            let visible = state.source_control_visible.load(std::sync::atomic::Ordering::Relaxed);
            let handle = match crate::services::git_worker::handle_for_path(
                &state.git_workers,
                &emitter,
                visible,
                &path,
            ) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.status(std::time::Duration::from_millis(150)).await {
                Ok(status) => Response::ok(req.id, serde_json::to_value(status).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_INIT => {
            let path = s(req.params.get("path"));
            match crate::services::git::init(&path) {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_STAGE => {
            let path = s(req.params.get("path"));
            let files = git_files(&req);
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.stage(path.clone(), files).await {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_UNSTAGE => {
            let path = s(req.params.get("path"));
            let files = git_files(&req);
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.unstage(path.clone(), files).await {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_STAGE_ALL => {
            let path = s(req.params.get("path"));
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.stage_all(path.clone()).await {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_UNSTAGE_ALL => {
            let path = s(req.params.get("path"));
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.unstage_all(path.clone()).await {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_DISCARD_FILES => {
            let path = s(req.params.get("path"));
            let files = git_files(&req);
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.discard(files).await {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_COMMIT => {
            let path = s(req.params.get("path"));
            let message = s(req.params.get("message"));
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.commit(message).await {
                Ok(oid) => Response::ok(req.id, serde_json::to_value(oid).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_DIFF => {
            let path = s(req.params.get("path"));
            let file = s(req.params.get("file"));
            let staged = req.params.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.diff(file, staged).await {
                Ok(diff) => Response::ok(req.id, serde_json::to_value(diff).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_COMMIT_LOG => {
            let path = s(req.params.get("path"));
            let count = req.params.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let skip = req.params.get("skip").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            match crate::services::git::commit_log(&path, count, skip) {
                Ok(log) => Response::ok(req.id, serde_json::to_value(log).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_COMMIT_FILES => {
            let path = s(req.params.get("path"));
            let commit_id = s(req.params.get("commitId"));
            match crate::services::git::commit_files(&path, &commit_id) {
                Ok(files) => Response::ok(req.id, serde_json::json!({ "files": files })),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_COMMIT_FILE_DIFF => {
            let path = s(req.params.get("path"));
            let commit_id = s(req.params.get("commitId"));
            let file = s(req.params.get("file"));
            match crate::services::git::commit_file_diff(&path, &commit_id, &file) {
                Ok(diff) => Response::ok(req.id, serde_json::to_value(diff).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_CHERRY_PICK => {
            let path = s(req.params.get("path"));
            let commit_id = s(req.params.get("commitId"));
            match crate::services::git::cherry_pick(&path, &commit_id) {
                Ok(_) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_REVERT => {
            let path = s(req.params.get("path"));
            let commit_id = s(req.params.get("commitId"));
            match crate::services::git::revert_commit(&path, &commit_id) {
                Ok(_) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_BRANCH_NAME => {
            let path = s(req.params.get("path"));
            match crate::services::git::branch_name(&path) {
                Ok(name) => Response::ok(req.id, serde_json::to_value(name).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_LIST_BRANCHES => {
            let path = s(req.params.get("path"));
            match crate::services::git::list_branches(&path) {
                Ok(branches) => Response::ok(req.id, serde_json::to_value(branches).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_CREATE_BRANCH => {
            let path = s(req.params.get("path"));
            let name = s(req.params.get("name"));
            let from_ref = opt_s(req.params.get("fromRef"));
            match crate::services::git::create_branch(&path, &name, from_ref.as_deref()) {
                Ok(()) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::Value::Null)
                }
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_RENAME_BRANCH => {
            let path = s(req.params.get("path"));
            let old_name = s(req.params.get("oldName"));
            let new_name = s(req.params.get("newName"));
            match crate::services::git::rename_branch(&path, &old_name, &new_name) {
                Ok(()) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::Value::Null)
                }
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_CHECKOUT_BRANCH => {
            let path = s(req.params.get("path"));
            let name = s(req.params.get("name"));
            let is_remote = req.params.get("isRemote").and_then(|v| v.as_bool()).unwrap_or(false);
            let remote_ref = opt_s(req.params.get("remoteRef"));
            match crate::services::git::checkout_branch(&path, &name, is_remote, remote_ref.as_deref()) {
                Ok(()) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::Value::Null)
                }
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_PULL => {
            let path = s(req.params.get("path"));
            let res = tokio::task::spawn_blocking({
                let path = path.clone();
                move || crate::services::git::git_pull(&path)
            })
            .await
            .map_err(|e| format!("git pull task failed: {e}"));
            match res {
                Ok(Ok(result)) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::to_value(result).unwrap())
                }
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_PUSH => {
            let path = s(req.params.get("path"));
            let res = tokio::task::spawn_blocking({
                let path = path.clone();
                move || crate::services::git::git_push(&path)
            })
            .await
            .map_err(|e| format!("git push task failed: {e}"));
            match res {
                Ok(Ok(result)) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::to_value(result).unwrap())
                }
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_PUBLISH => {
            let path = s(req.params.get("path"));
            let res = tokio::task::spawn_blocking({
                let path = path.clone();
                move || crate::services::git::git_publish(&path)
            })
            .await
            .map_err(|e| format!("git publish task failed: {e}"));
            match res {
                Ok(Ok(result)) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::to_value(result).unwrap())
                }
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GIT_FETCH => {
            let path = s(req.params.get("path"));
            let res = tokio::task::spawn_blocking({
                let path = path.clone();
                move || crate::services::git::git_fetch(&path)
            })
            .await
            .map_err(|e| format!("git fetch task failed: {e}"));
            match res {
                Ok(Ok(result)) => {
                    if let Ok(handle) = git_handle(&state, &path) {
                        let _ = handle.schedule_refresh(std::time::Duration::ZERO);
                    }
                    Response::ok(req.id, serde_json::to_value(result).unwrap())
                }
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if crate::sidecar::dispatch::watch::handles(m) => {
            crate::sidecar::dispatch::watch::dispatch(req, state).await
        }
        m if m == crate::protocol::methods::SET_SOURCE_CONTROL_VISIBLE => {
            let visible = req.params.get("visible").and_then(|v| v.as_bool()).unwrap_or(false);
            state
                .source_control_visible
                .store(visible, std::sync::atomic::Ordering::Relaxed);
            if let Ok(workers) = state.git_workers.lock() {
                for worker in workers.values() {
                    let _ = worker.set_visible(visible);
                }
            }
            Response::ok(req.id, serde_json::Value::Bool(true))
        }
        m if m == crate::protocol::methods::CANCEL_GIT_OPERATION => {
            let path = s(req.params.get("path"));
            let handle = match git_handle(&state, &path) {
                Ok(h) => h,
                Err(e) => return Response::err(req.id, e),
            };
            match handle.cancel_operation() {
                Ok(v) => Response::ok(req.id, serde_json::Value::Bool(v)),
                Err(e) => Response::err(req.id, e),
            }
        }

        // DB-free: Electron now owns the directory row — it deletes the row + emits
        // the event, then forwards the pre-delete snapshot here so the sidecar can
        // tear down the subtree's watchers/shadow trees/caches (no DB read needed).
        m if m == crate::protocol::methods::EVICT_DIRECTORY_RESOURCES => {
            let id = s(req.params.get("id"));
            let all_dirs: Vec<crate::types::WorkingDirectory> = req
                .params
                .get("allDirs")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            state.evict_directory_resources(&id, &all_dirs);
            Response::ok(req.id, serde_json::json!(true))
        }

        // ---- worktree_cmds.rs (git2-only ops; Electron owns the DB rows) ----
        m if m == crate::protocol::methods::WORKTREE_CREATE_GIT => {
            let parent_path = s(req.params.get("parentPath"));
            let parent_directory_id = s(req.params.get("parentDirectoryId"));
            let branch = s(req.params.get("branch"));
            let default_base_ref = opt_s(req.params.get("defaultBaseRef"));
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::services::worktrees::create_workspace_worktree_git(
                    &*state, &parent_path, default_base_ref.as_deref(),
                    &parent_directory_id, &branch,
                )
            })
            .await
            .map_err(|e| format!("worktree create task failed: {e}"));
            match result {
                Ok(Ok(r)) => Response::ok(req.id, serde_json::to_value(r).unwrap()),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::WORKTREE_REMOVE_GIT => {
            let parent_path = s(req.params.get("parentPath"));
            let dir_path = s(req.params.get("dirPath"));
            let force = req.params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let result = tokio::task::spawn_blocking(move || {
                crate::services::worktrees::remove_workspace_worktree_git(
                    &parent_path, &dir_path, force,
                )
            })
            .await
            .map_err(|e| format!("worktree remove task failed: {e}"));
            match result {
                Ok(Ok(())) => Response::ok(req.id, serde_json::json!(true)),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::WORKTREE_RENAME_GIT => {
            let parent_path = s(req.params.get("parentPath"));
            let dir_path = s(req.params.get("dirPath"));
            let branch = s(req.params.get("branch"));
            let result = tokio::task::spawn_blocking(move || {
                crate::services::worktrees::rename_workspace_worktree_branch_git(
                    &parent_path, &dir_path, &branch,
                )
            })
            .await
            .map_err(|e| format!("worktree rename task failed: {e}"));
            match result {
                Ok(Ok(new_branch)) => {
                    Response::ok(req.id, serde_json::json!({ "branch": new_branch }))
                }
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }

        // ---- settings.rs (settings + app state) ----
        m if m == crate::protocol::methods::GET_SETTINGS => {
            Response::ok(req.id, serde_json::to_value(state.settings.get()).unwrap())
        }
        m if m == crate::protocol::methods::GET_SETTINGS_PATH => {
            let path = crate::settings::settings_path();
            let result: Result<String, String> = (|| {
                if !path.exists() {
                    let s_val = state.settings.get();
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    std::fs::write(&path, serde_json::to_string_pretty(&s_val).unwrap())
                        .map_err(|e| e.to_string())?;
                }
                Ok(path.to_string_lossy().to_string())
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::String(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::UPDATE_SETTINGS => {
            let settings = req.params.get("settings").cloned().unwrap_or(serde_json::Value::Null);
            let updated = state.settings.update(&settings);
            state.event_bus.emit("settings-changed", serde_json::Value::Null);
            Response::ok(req.id, serde_json::to_value(updated).unwrap())
        }
        m if m == crate::protocol::methods::SET_CONFIG => {
            let settings = req.params.get("settings").cloned().unwrap_or_default();
            // Tolerant parse: an unknown top-level key (e.g. a new renderer-only
            // setting the backend doesn't model) must not fail the whole push.
            let s = crate::settings::deserialize_lenient(settings);
            state.settings.set_cache(s);
            Response::ok(req.id, serde_json::Value::Null)
        }
        m if m == crate::protocol::methods::LIST_USER_THEMES => {
            let result = tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
                let dir = crate::paths::user_data_dir().join("themes");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let mut themes = Vec::new();
                for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                    let path = entry.path();
                    if path.extension().is_some_and(|e| e == "json") {
                        if let Ok(json) = std::fs::read_to_string(&path) {
                            let is_verne = serde_json::from_str::<serde_json::Value>(&json)
                                .ok()
                                .and_then(|v| v.get("$schema").and_then(|s| s.as_str()).map(String::from))
                                .is_some_and(|s| s == "verne-theme/v1");
                            if !is_verne {
                                continue;
                            }
                            let name = path.file_stem().unwrap().to_string_lossy().to_string();
                            themes.push(serde_json::json!({ "name": name, "json": json }));
                        }
                    }
                }
                Ok(themes)
            })
            .await
            .map_err(|e| format!("theme list task failed: {e}"));
            match result {
                Ok(Ok(v)) => Response::ok(req.id, serde_json::Value::Array(v)),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }

        m if crate::sidecar::dispatch::notes::handles(m) => {
            crate::sidecar::dispatch::notes::dispatch(req).await
        }

        m if crate::sidecar::dispatch::file_search::handles(m) => {
            crate::sidecar::dispatch::file_search::dispatch(req, state).await
        }
        m if crate::sidecar::dispatch::shadow::handles(m) => {
            crate::sidecar::dispatch::shadow::dispatch(req, state).await
        }

        // ---- mcp.rs (agent MCP registration) ----
        m if m == crate::protocol::methods::MCP_SUPPORTED_AGENTS => {
            let agents = crate::services::mcp_agents::supported_agents();
            Response::ok(req.id, serde_json::to_value(agents).unwrap())
        }
        m if m == crate::protocol::methods::MCP_AGENT_STATUS => {
            let agent = req.params.get("agent").and_then(|v| v.as_str()).unwrap_or_default();
            if agent.is_empty() {
                let status = crate::services::mcp_agents::status_all();
                Response::ok(req.id, serde_json::to_value(status).unwrap())
            } else {
                match crate::services::mcp_agents::status_one(agent) {
                    Some(status) => Response::ok(req.id, serde_json::to_value(status).unwrap()),
                    None => Response::err(req.id, "unknown agent"),
                }
            }
        }
        m if m == crate::protocol::methods::MCP_INSTALL => {
            let agent = s(req.params.get("agent"));
            let result = crate::services::mcp_agents::get_agent(&agent)
                .ok_or_else(|| "unknown agent".to_string())
                .and_then(|a| a.ensure_mcp(&crate::services::mcp_agents::verne_binary()));
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::MCP_INSTALL_ALL => {
            let verne = crate::services::mcp_agents::verne_binary();
            let mut ok = Vec::new();
            for a in crate::services::mcp_agents::all_agents() {
                if a.detected() && a.ensure_mcp(&verne).is_ok() {
                    ok.push(a.key().to_string());
                }
            }
            Response::ok(req.id, serde_json::to_value(ok).unwrap())
        }
        m if m == crate::protocol::methods::MCP_UNINSTALL => {
            let agent = s(req.params.get("agent"));
            let result = crate::services::mcp_agents::get_agent(&agent)
                .ok_or_else(|| "unknown agent".to_string())
                .and_then(|a| a.remove_mcp());
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::MCP_MANUAL_COMMANDS => {
            let agent = s(req.params.get("agent"));
            let result = crate::services::mcp_agents::get_agent(&agent)
                .ok_or_else(|| "unknown agent".to_string())
                .map(|a| a.manual_commands(&crate::services::mcp_agents::verne_binary()));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::String(v)),
                Err(e) => Response::err(req.id, e),
            }
        }

        // ---- system util ----
        m if m == crate::protocol::methods::GET_WS_PORT => {
            Response::ok(req.id, serde_json::json!(state.ws_port))
        }
        m if m == crate::protocol::methods::GET_HOME_PATH => {
            Response::ok(req.id, serde_json::Value::String(state.home_dir.to_string_lossy().to_string()))
        }
        m if m == crate::protocol::methods::RESOLVE_REPO_ROOT => {
            let working_dir = s(req.params.get("workingDir"));
            Response::ok(
                req.id,
                serde_json::json!({ "repoRoot": crate::services::git::resolve_repo_root(&working_dir) }),
            )
        }

        m if m == crate::protocol::methods::AGENT_SHADOW_ON_HOOK => {
            // Forwarded by Electron from the daemon's `agent-hook-fileops` event.
            // Snapshots the file-op baseline or update, then emits agent-files-changed.
            let agent_id = s(req.params.get("agentId"));
            let working_dir = s(req.params.get("workingDir"));
            let event = s(req.params.get("event"));
            let tool_name = s(req.params.get("toolName"));
            let tool_input = req.params.get("toolInput").cloned().unwrap_or(serde_json::Value::Null);
            let agent_type = req.params.get("agentType").and_then(|v| v.as_str()).unwrap_or("claude").to_string();
            let snapshotted = crate::services::hook_server::agent_shadow_on_hook(
                &working_dir,
                &state.agent_shadows,
                &state.internal_data_dir,
                &agent_id,
                &event,
                &tool_name,
                &tool_input,
                &agent_type,
            );
            if snapshotted {
                state.event_bus.emit(
                    "agent-files-changed",
                    serde_json::json!({ "agentId": agent_id }),
                );
            }
            Response::ok(req.id, serde_json::json!(snapshotted))
        }

        m if m == crate::protocol::methods::AGENT_SHADOW_RESYNC => {
            // Called by Electron on startup to re-baseline tracked files. Electron
            // supplies (agentId, workingDir) pairs from its tab rows — no sidecar DB.
            let agent_dirs: Vec<(String, String)> = req.params.get("agentDirs")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| {
                    let id = x.get("agentId")?.as_str()?.to_string();
                    let wd = x.get("workingDir")?.as_str()?.to_string();
                    Some((id, wd))
                }).collect())
                .unwrap_or_default();
            crate::services::hook_server::agent_shadow_resync(
                &state.agent_shadows,
                &state.internal_data_dir,
                &agent_dirs,
            );
            Response::ok(req.id, serde_json::json!(true))
        }

        other => Response::err(req.id, format!("unknown method: {other}")),
    }
}
