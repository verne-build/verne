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

        // ---- files.rs (filesystem CRUD + tree) ----
        m if m == crate::protocol::methods::READ_FILE => {
            let path = s(req.params.get("path"));
            let result: Result<serde_json::Value, String> = (|| {
                let language = detect_language(&path);
                let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "content": content, "language": language }))
            })();
            match result {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::WRITE_FILE => {
            let path = s(req.params.get("path"));
            let content = s(req.params.get("content"));
            let result: Result<serde_json::Value, String> = (|| {
                std::fs::write(&path, &content).map_err(|e| e.to_string())?;
                if std::path::Path::new(&path) == crate::settings::settings_path() {
                    state.settings.invalidate();
                    state.event_bus.emit("settings-changed", serde_json::Value::Null);
                }
                let mtime = std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                Ok(serde_json::json!({ "ok": true, "mtime": mtime }))
            })();
            match result {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::CREATE_FILE => {
            let path = s(req.params.get("path"));
            let result: Result<(), String> = (|| {
                let p = std::path::Path::new(&path);
                if p.exists() {
                    return Err("File already exists".to_string());
                }
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(p, "").map_err(|e| e.to_string())
            })();
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::CREATE_DIR => {
            let path = s(req.params.get("path"));
            let result: Result<(), String> = (|| {
                let p = std::path::Path::new(&path);
                if p.exists() {
                    return Err("Directory already exists".to_string());
                }
                std::fs::create_dir_all(p).map_err(|e| e.to_string())
            })();
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::LIST_TREE => {
            let dir = s(req.params.get("dir"));
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || list_tree_impl(&state, &dir))
                .await
                .map_err(|e| format!("list_tree task failed: {e}"));
            match result {
                Ok(Ok(v)) => Response::ok(req.id, v),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::GET_FILE_MTIME => {
            let path = s(req.params.get("path"));
            let result: Result<serde_json::Value, String> = (|| {
                let mtime = std::fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_millis() as i64;
                Ok(serde_json::json!({ "mtime": mtime }))
            })();
            match result {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::PASTE_PATH => {
            let source = s(req.params.get("source"));
            let target_dir = s(req.params.get("targetDir"));
            let cut = req.params.get("cut").and_then(|v| v.as_bool()).unwrap_or(false);
            match paste_path_impl(&source, &target_dir, cut) {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::FIND_PROJECT_ICON => {
            let dir = s(req.params.get("dir"));
            let icon = find_project_icon_impl(&dir);
            Response::ok(req.id, serde_json::to_value(icon).unwrap())
        }
        m if m == crate::protocol::methods::RENAME_PATH => {
            let old_path = s(req.params.get("oldPath"));
            let new_path = s(req.params.get("newPath"));
            match std::fs::rename(&old_path, &new_path) {
                Ok(()) => Response::ok(req.id, serde_json::json!(true)),
                Err(e) => Response::err(req.id, e.to_string()),
            }
        }
        m if m == crate::protocol::methods::FILE_EXISTS => {
            let path = s(req.params.get("path"));
            Response::ok(req.id, serde_json::json!(std::path::Path::new(&path).is_file()))
        }

        // ---- file_search.rs (index + fuzzy search + recent files) ----
        m if m == crate::protocol::methods::SEARCH_FILES => {
            let dir = s(req.params.get("dir"));
            let query = s(req.params.get("query"));
            // Recency resolved by Electron (path → openedAt), wire shape: [[path, openedAt], ...].
            let recency_map: std::collections::HashMap<String, i64> = req
                .params
                .get("recentFiles")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            let pair = e.as_array()?;
                            let path = pair.first()?.as_str()?.to_string();
                            let opened = pair.get(1)?.as_i64()?;
                            Some((path, opened))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                search_files_impl(&state, &dir, &query, recency_map)
            })
            .await
            .map_err(|e| format!("search_files task failed: {e}"));
            match result {
                Ok(Ok(v)) => Response::ok(req.id, v),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SEARCH_CONTENT => {
            let dir = s(req.params.get("dir"));
            let query = s(req.params.get("query"));
            let case_sensitive = req
                .params
                .get("caseSensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let include = s(req.params.get("include"));
            let exclude = s(req.params.get("exclude"));
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                search_content_impl(&state, &dir, &query, case_sensitive, &include, &exclude)
            })
            .await
            .map_err(|e| format!("search_content task failed: {e}"));
            match result {
                Ok(Ok(v)) => Response::ok(req.id, v),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::LIST_DIRECTORY_PATHS => {
            let partial = s(req.params.get("partial"));
            match list_directory_paths_impl(&state, &partial) {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::PREWARM_FILE_INDEX => {
            let dir = s(req.params.get("dir"));
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                let base = std::path::PathBuf::from(&dir);
                let exclude_key = state.file_exclude_cache_key();
                let mut cache = state.file_list_cache.lock().unwrap();
                if cache.get(&dir).is_some_and(|c| c.exclude_key == exclude_key) {
                    return Ok::<(), String>(());
                }
                let files = collect_files_app(&state, &dir, &base)?;
                insert_file_list_cache_app(&state, &mut cache, &dir, &exclude_key, files);
                Ok(())
            })
            .await
            .map_err(|e| format!("prewarm_file_index task failed: {e}"));
            match result {
                Ok(Ok(())) => Response::ok(req.id, serde_json::Value::Null),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        // ---- shadow.rs (per-dir shadow git tree) ----
        m if m == crate::protocol::methods::SHADOW_COMMIT => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let content = s(req.params.get("content"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.commit_file(&rel_path, &content));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::String(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_READ => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let result = shadow_with_tree(&state, &dir, |tree| Ok(tree.read_file(&rel_path)));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_READ_WITH_BASELINE => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.read_file_with_baseline(&rel_path));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_DIFF => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let disk_content = s(req.params.get("diskContent"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.diff_file(&rel_path, &disk_content));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_HISTORY => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.file_history(&rel_path));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_READ_AT => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let oid = s(req.params.get("oid"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.read_at_commit(&rel_path, &oid));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::String(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_ON_SAVED => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let content = s(req.params.get("content"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.on_file_saved(&rel_path, &content));
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::SHADOW_REMOVE => {
            let dir = s(req.params.get("dir"));
            let rel_path = s(req.params.get("relPath"));
            let result = shadow_with_tree(&state, &dir, |tree| tree.remove_file(&rel_path));
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
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

// ============================================================================
// Group B helpers (files / file_search / file_watch) — mirror the bodies in
// commands/{files,file_search,file_watch}.rs against daemon AppState. The
// file-index caching + gitignore logic is reproduced faithfully (perf path).
// ============================================================================

/// Mirror of `commands/files.rs::read_file` language detection.
fn detect_language(path: &str) -> &'static str {
    use std::path::Path;
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let lang_map = [
        ("ts", "typescript"), ("tsx", "typescript"), ("mts", "typescript"), ("cts", "typescript"),
        ("js", "javascript"), ("mjs", "javascript"), ("cjs", "javascript"), ("jsx", "javascript"),
        ("vue", "vue"), ("json", "json"), ("jsonc", "jsonc"), ("md", "markdown"),
        ("css", "css"), ("html", "html"), ("htm", "html"),
        ("py", "python"), ("pyw", "python"), ("rs", "rust"), ("go", "go"),
        ("sh", "shell"), ("bash", "shell"), ("zsh", "shell"),
        ("yml", "yaml"), ("yaml", "yaml"), ("env", "dotenv"), ("toml", "toml"),
        ("sql", "sql"), ("graphql", "graphql"), ("gql", "graphql"), ("rb", "ruby"),
        ("xml", "xml"), ("svg", "xml"), ("xsl", "xml"), ("xsd", "xml"), ("plist", "xml"),
        ("php", "php"), ("scss", "scss"), ("less", "less"), ("dockerfile", "dockerfile"),
        ("c", "c"), ("h", "c"), ("cpp", "cpp"), ("cc", "cpp"), ("cxx", "cpp"),
        ("hpp", "cpp"), ("hxx", "cpp"), ("hh", "cpp"),
        ("java", "java"), ("cs", "csharp"), ("csx", "csharp"), ("swift", "swift"),
        ("lua", "lua"), ("ini", "ini"), ("cfg", "ini"), ("conf", "ini"), ("properties", "ini"),
        ("hbs", "handlebars"), ("handlebars", "handlebars"),
        ("pl", "perl"), ("pm", "perl"),
        ("ps1", "powershell"), ("psd1", "powershell"), ("psm1", "powershell"),
        ("r", "r"), ("m", "objective-c"), ("mm", "objective-c"),
        ("dart", "dart"), ("groovy", "groovy"), ("gradle", "groovy"),
        ("clj", "clojure"), ("cljs", "clojure"), ("edn", "clojure"),
        ("tex", "latex"), ("sty", "latex"), ("cls", "latex"),
        ("pug", "pug"), ("jade", "pug"),
        ("fs", "fsharp"), ("fsi", "fsharp"), ("fsx", "fsharp"),
        ("tpl", "smarty"), ("smarty", "smarty"),
    ];
    let file_name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let jsonc_files = ["tsconfig.json", "jsconfig.json", ".swcrc"];
    if file_name.starts_with(".env") {
        "dotenv"
    } else if file_name == "Dockerfile" || file_name.starts_with("Dockerfile.") {
        "dockerfile"
    } else if file_name == "Makefile" || file_name == "makefile" || file_name == "GNUmakefile" {
        "makefile"
    } else if jsonc_files.contains(&file_name)
        || (file_name.starts_with("tsconfig.") && file_name.ends_with(".json"))
    {
        "jsonc"
    } else {
        lang_map.iter().find(|(k, _)| *k == ext).map(|(_, v)| *v).unwrap_or("plaintext")
    }
}

/// Mirror of `commands/files.rs::list_tree` (gitignore-aware single-level listing).
fn list_tree_impl(state: &crate::state::AppState, dir: &str) -> Result<serde_json::Value, String> {
    use globset::{Glob, GlobSetBuilder};
    use std::path::PathBuf;

    let patterns = &state.settings.get().files_exclude;
    let mut builder = GlobSetBuilder::new();
    for (pattern, enabled) in patterns {
        if *enabled {
            if let Ok(glob) = Glob::new(pattern) {
                builder.add(glob);
            }
        }
    }
    let exclude = builder
        .build()
        .unwrap_or_else(|_| GlobSetBuilder::new().build().unwrap());

    struct FsEntry {
        name: String,
        path: PathBuf,
        is_dir: bool,
    }

    let gitignore = git2::Repository::discover(dir)
        .ok()
        .and_then(|repo| repo.workdir().map(PathBuf::from))
        .and_then(|workdir| {
            let dir_path = PathBuf::from(dir);
            let mut builder = ignore::gitignore::GitignoreBuilder::new(&workdir);
            let mut current = workdir.clone();

            let root_gitignore = current.join(".gitignore");
            if root_gitignore.is_file() {
                let _ = builder.add(root_gitignore);
            }

            if let Ok(rel_dir) = dir_path.strip_prefix(&workdir) {
                for component in rel_dir.components() {
                    current.push(component.as_os_str());
                    let gitignore_path = current.join(".gitignore");
                    if gitignore_path.is_file() {
                        let _ = builder.add(gitignore_path);
                    }
                }
            }

            builder.build().ok().map(|gitignore| (workdir, gitignore))
        });

    let fs_entries: Vec<FsEntry> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| !exclude.is_match(entry.file_name().to_string_lossy().as_ref()))
        .map(|entry| FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();

    let mut entries: Vec<crate::types::TreeEntry> = fs_entries
        .into_iter()
        .map(|entry| {
            let is_ignored = gitignore
                .as_ref()
                .and_then(|(workdir, gitignore)| {
                    entry.path.strip_prefix(workdir).ok().map(|rel| {
                        gitignore
                            .matched_path_or_any_parents(rel, entry.is_dir)
                            .is_ignore()
                    })
                })
                .unwrap_or(false);
            crate::types::TreeEntry {
                name: entry.name,
                path: entry.path.to_string_lossy().to_string(),
                is_dir: entry.is_dir,
                is_ignored,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.cmp(&b.name)
    });
    Ok(serde_json::json!({ "entries": entries }))
}

/// Mirror of `commands/files.rs::paste_path`.
fn paste_path_impl(source: &str, target_dir: &str, cut: bool) -> Result<serde_json::Value, String> {
    use std::path::{Path, PathBuf};
    fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let target = dest.join(entry.file_name());
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                copy_dir_recursive(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    let src = Path::new(source);
    if !src.exists() {
        return Err("Source does not exist".to_string());
    }
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let mut dest = PathBuf::from(target_dir).join(file_name);
    if dest.exists() {
        let stem = dest.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = dest
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let parent = dest.parent().unwrap().to_path_buf();
        let mut i = 1u32;
        loop {
            let suffix = if i > 1 { format!(" {}", i) } else { String::new() };
            let candidate = if src.is_dir() {
                parent.join(format!("{} copy{}", stem, suffix))
            } else {
                parent.join(format!("{} copy{}{}", stem, suffix, ext))
            };
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            i += 1;
        }
    }
    if cut {
        std::fs::rename(source, &dest).map_err(|e| e.to_string())?;
    } else if src.is_dir() {
        copy_dir_recursive(src, &dest)?;
    } else {
        std::fs::copy(source, &dest).map_err(|e| e.to_string())?;
    }
    Ok(serde_json::json!({ "dest": dest.to_string_lossy() }))
}

/// Mirror of `commands/files.rs::find_project_icon`.
fn find_project_icon_impl(dir: &str) -> Option<String> {
    use std::path::Path;
    let base = Path::new(dir);
    let candidates = [
        "public/favicon.svg", "favicon.svg", "static/favicon.svg",
        "public/apple-touch-icon.png", "apple-touch-icon.png",
        "public/favicon.png", "public/icon.png", "favicon.png",
        "app/icon.png", "src/app/icon.png", "src-tauri/icons/icon.png",
        "build/icon.png", "resources/icon.png", "web/favicon.png",
        "web/icons/Icon-192.png", "src/favicon.ico", "static/favicon.png",
        "src/images/icon.png", "assets/icon.png", "assets/favicon.png",
        "resources/images/favicon.ico", "app/assets/images/favicon.ico",
        "app/assets/images/favicon.png", "static/images/favicon.ico",
        "public/favicon.ico", "favicon.ico", "app/favicon.ico",
        "static/favicon.ico", "src/assets/icon.png",
    ];
    for candidate in candidates {
        let path = base.join(candidate);
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

const FILE_INDEX_CACHE_LIMIT: usize = 8;

/// Mirror of `commands/file_search.rs::insert_file_list_cache` against AppState.
fn insert_file_list_cache_app(
    state: &crate::state::AppState,
    cache: &mut std::collections::HashMap<String, crate::state::FileListCache>,
    dir: &str,
    exclude_key: &str,
    files: std::sync::Arc<Vec<String>>,
) {
    if cache.len() >= FILE_INDEX_CACHE_LIMIT && !cache.contains_key(dir) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_access_tick)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        dir.to_string(),
        crate::state::FileListCache {
            files,
            exclude_key: exclude_key.to_string(),
            last_access_tick: state.next_file_cache_tick(),
        },
    );
}

/// Mirror of `commands/file_search.rs::collect_files` against AppState.
fn collect_files_app(
    state: &crate::state::AppState,
    dir: &str,
    base: &std::path::Path,
) -> Result<std::sync::Arc<Vec<String>>, String> {
    use ignore::WalkBuilder;
    let mut list = Vec::new();
    let mut builder = WalkBuilder::new(dir);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .max_depth(Some(20));
    let exclude_patterns = &state.settings.get().files_exclude;
    let mut overrides = ignore::overrides::OverrideBuilder::new(dir);
    for (pattern, enabled) in exclude_patterns {
        if *enabled {
            overrides.add(&format!("!{}", pattern)).ok();
        }
    }
    if let Ok(overrides) = overrides.build() {
        builder.overrides(overrides);
    }
    for entry in builder.build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(base) {
            list.push(rel.to_string_lossy().to_string());
        }
    }
    Ok(std::sync::Arc::new(list))
}

/// Mirror of `commands/file_search.rs::search_files` (cache + nucleo fuzzy).
fn search_files_impl(
    state: &crate::state::AppState,
    dir: &str,
    query: &str,
    recency_map: std::collections::HashMap<String, i64>,
) -> Result<serde_json::Value, String> {
    use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
    use nucleo_matcher::{Config, Matcher, Utf32Str};
    use serde_json::json;
    use std::path::Path;
    use std::sync::Arc;

    let base = Path::new(dir);
    let t0 = std::time::Instant::now();
    let exclude_key = state.file_exclude_cache_key();

    let files: Arc<Vec<String>> = {
        let mut cache = state.file_list_cache.lock().unwrap();
        if let Some(cached) = cache.get_mut(dir) {
            if cached.exclude_key == exclude_key {
                cached.last_access_tick = state.next_file_cache_tick();
                Arc::clone(&cached.files)
            } else {
                cache.remove(dir);
                let files = collect_files_app(state, dir, base)?;
                insert_file_list_cache_app(state, &mut cache, dir, &exclude_key, Arc::clone(&files));
                files
            }
        } else {
            let files = collect_files_app(state, dir, base)?;
            insert_file_list_cache_app(state, &mut cache, dir, &exclude_key, Arc::clone(&files));
            files
        }
    };

    if query.trim().is_empty() {
        // Precompute recency once per file. Joining + allocating the abs path
        // inside the comparator was O(N log N) string allocs — the hot path when
        // backspacing to an empty query.
        let mut ordered: Vec<(i64, &String)> = files
            .iter()
            .map(|rel| {
                let abs = base.join(rel);
                let recent = recency_map.get(abs.to_string_lossy().as_ref()).copied().unwrap_or(0);
                (recent, rel)
            })
            .collect();
        ordered.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        ordered.truncate(50);
        let results: Vec<serde_json::Value> = ordered
            .into_iter()
            .map(|(_, rel)| {
                let name = Path::new(rel)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let abs = base.join(rel).to_string_lossy().to_string();
                json!({ "name": name, "path": abs, "relPath": rel })
            })
            .collect();
        return Ok(json!({ "results": results }));
    }

    // Recency lookup keyed by rel path so the hot loop never re-joins/allocates
    // the abs path per candidate (broad queries match thousands of files).
    let recent_rel: std::collections::HashSet<&str> = recency_map
        .keys()
        .filter_map(|abs| Path::new(abs).strip_prefix(base).ok())
        .filter_map(|p| p.to_str())
        .collect();
    const IMAGE_EXTS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "icns"];

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    // Store the file index, not a cloned String — only the surviving 50 are
    // materialized. The previous `rel.clone()` per match was a per-keystroke
    // allocation storm on broad/backspace queries.
    let mut scored: Vec<(u32, usize)> = Vec::new();
    let mut buf = Vec::new();
    for (idx, rel) in files.iter().enumerate() {
        let haystack = Utf32Str::new(rel, &mut buf);
        if let Some(mut score) = pattern.score(haystack, &mut matcher) {
            let path = Path::new(rel.as_str());
            // &str slices — no per-candidate String allocation.
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("");
            let fname_haystack = Utf32Str::new(filename, &mut buf);
            if let Some(fname_score) = pattern.score(fname_haystack, &mut matcher) {
                score = score.saturating_add(fname_score).saturating_add(200);
                if stem.eq_ignore_ascii_case(query) {
                    score = score.saturating_add(500);
                }
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if IMAGE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
                score = score.saturating_sub(300);
            }
            if recent_rel.contains(rel.as_str()) {
                score = score.saturating_add(100);
            }
            scored.push((score, idx));
        }
    }
    let matched = scored.len();
    // Partial-select the top 50 instead of fully sorting every match.
    if scored.len() > 50 {
        scored.select_nth_unstable_by(49, |a, b| b.0.cmp(&a.0));
        scored.truncate(50);
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<serde_json::Value> = scored
        .into_iter()
        .map(|(_, idx)| {
            let rel = &files[idx];
            let name = Path::new(rel.as_str())
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let abs = base.join(rel).to_string_lossy().to_string();
            json!({ "name": name, "path": abs, "relPath": rel })
        })
        .collect();
    if std::env::var_os("VERNE_SEARCH_TIMING").is_some() {
        eprintln!(
            "[search] q={:?} files={} matched={} {:?}",
            query,
            files.len(),
            matched,
            t0.elapsed()
        );
    }
    Ok(json!({ "results": results }))
}

const CONTENT_SEARCH_MAX: usize = 500;
const CONTENT_SEARCH_CONTEXT: usize = 200;

fn split_glob_list(raw: &str) -> Vec<String> {
    raw.split([',', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn build_content_grep_query(
    state: &crate::state::AppState,
    query: &str,
    include: &str,
    exclude: &str,
) -> String {
    let mut parts = Vec::new();
    if !query.trim().is_empty() {
        parts.push(query.trim().to_string());
    }
    parts.extend(split_glob_list(include));
    for glob in split_glob_list(exclude) {
        parts.push(format!("!{glob}"));
    }
    let settings = state.settings.get();
    let mut exclude_pairs: Vec<_> = settings.files_exclude.into_iter().collect();
    exclude_pairs.sort_by(|a, b| a.0.cmp(&b.0));
    for (pattern, enabled) in exclude_pairs {
        if enabled {
            parts.push(format!("!{pattern}"));
        }
    }
    parts.join(" ")
}

/// Truncate to at most `max_bytes` from the start, never splitting a UTF-8 codepoint.
fn truncate_prefix(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Truncate to at most `max_bytes` from the end, never splitting a UTF-8 codepoint.
fn truncate_suffix(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len().saturating_sub(max_bytes);
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

fn split_match_segments(line: &str, match_byte_offsets: &[(u32, u32)]) -> (String, String, String) {
    let (start, end) = match_byte_offsets
        .first()
        .copied()
        .unwrap_or((0, 0));
    let start = start as usize;
    let end = end as usize;
    let pre = line.get(..start.min(line.len())).unwrap_or("").to_string();
    let match_text = line
        .get(start.min(line.len())..end.min(line.len()))
        .unwrap_or("")
        .to_string();
    let post = line.get(end.min(line.len())..).unwrap_or("").to_string();
    (
        truncate_suffix(&pre, CONTENT_SEARCH_CONTEXT),
        match_text,
        truncate_prefix(&post, CONTENT_SEARCH_CONTEXT),
    )
}

fn ensure_content_picker(
    state: &crate::state::AppState,
    dir: &str,
) -> Result<(), String> {
    use fff_search::file_picker::{FilePicker, FilePickerOptions};
    use std::path::Path;

    let exclude_key = state.file_exclude_cache_key();
    let mut cache = state
        .content_picker_cache
        .lock()
        .map_err(|e| e.to_string())?;
    let needs_build = match cache.get(dir) {
        Some(c) => c.exclude_key != exclude_key,
        None => true,
    };
    if needs_build {
        let base = Path::new(dir);
        if !base.is_dir() {
            return Err(format!("not a directory: {dir}"));
        }
        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: dir.to_string(),
            watch: false,
            enable_home_dir_scanning: true,
            ..Default::default()
        })
        .map_err(|e| e.to_string())?;
        picker.collect_files().map_err(|e| e.to_string())?;
        cache.insert(
            dir.to_string(),
            crate::state::ContentPickerCache {
                picker,
                exclude_key,
            },
        );
    }
    Ok(())
}

/// Content search via fff-search grep across an indexed workspace tree.
fn search_content_impl(
    state: &crate::state::AppState,
    dir: &str,
    query: &str,
    case_sensitive: bool,
    include: &str,
    exclude: &str,
) -> Result<serde_json::Value, String> {
    use fff_search::grep::{parse_grep_query, GrepMode, GrepSearchOptions, MAX_FFFILE_SIZE};
    use serde_json::json;
    use std::path::Path;

    if query.trim().is_empty() {
        return Ok(json!({ "results": [], "truncated": false }));
    }

    let grep_query_str = build_content_grep_query(state, query, include, exclude);
    let fff_query = parse_grep_query(&grep_query_str);
    let options = GrepSearchOptions {
        max_file_size: MAX_FFFILE_SIZE,
        max_matches_per_file: 0,
        smart_case: !case_sensitive,
        file_offset: 0,
        page_limit: CONTENT_SEARCH_MAX + 1,
        mode: GrepMode::PlainText,
        time_budget_ms: 0,
        before_context: 0,
        after_context: 0,
        classify_definitions: false,
        trim_whitespace: false,
        abort_signal: None,
    };

    ensure_content_picker(state, dir)?;
    let mut cache = state
        .content_picker_cache
        .lock()
        .map_err(|e| e.to_string())?;
    let entry = cache
        .get_mut(dir)
        .ok_or_else(|| format!("picker cache miss: {dir}"))?;
    let picker = &entry.picker;
    let base = Path::new(dir);
    let grep_result = picker.grep(&fff_query, &options);
    let total_matches = grep_result.matches.len();

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut truncated = false;
    for m in grep_result.matches {
        if results.len() >= CONTENT_SEARCH_MAX {
            truncated = true;
            break;
        }
        let file = grep_result
            .files
            .get(m.file_index)
            .ok_or_else(|| "grep file_index out of range".to_string())?;
        let rel = file.relative_path(picker);
        let abs = base.join(&rel).to_string_lossy().to_string();
        let name = Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let offsets: Vec<(u32, u32)> = m.match_byte_offsets.iter().copied().collect();
        let (pre, match_text, post) = split_match_segments(&m.line_content, &offsets);
        results.push(json!({
            "relPath": rel,
            "path": abs,
            "name": name,
            "line": m.line_number,
            "column": m.col.saturating_add(1),
            "pre": pre,
            "match": match_text,
            "post": post,
        }));
    }
    if total_matches > CONTENT_SEARCH_MAX {
        truncated = true;
    }

    Ok(json!({ "results": results, "truncated": truncated }))
}

/// Mirror of `commands/file_search.rs::list_directory_paths`.
fn list_directory_paths_impl(
    state: &crate::state::AppState,
    partial: &str,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    use std::path::Path;

    let home_str = state.home_dir.to_string_lossy().to_string();
    let expanded = partial.replacen("~", &home_str, 1);
    let (parent_dir, prefix) = if expanded.is_empty() || expanded == home_str {
        (home_str.clone(), String::new())
    } else if expanded.ends_with('/') {
        (expanded.clone(), String::new())
    } else if Path::new(&expanded).is_dir() {
        (expanded.clone(), String::new())
    } else {
        let path = Path::new(&expanded);
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| home_str.clone());
        let prefix = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        (parent, prefix)
    };
    let entries = match std::fs::read_dir(&parent_dir) {
        Ok(e) => e,
        Err(_) => return Ok(json!({ "dirs": [], "resolved": parent_dir })),
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            is_dir
                && !name.starts_with('.')
                && (prefix.is_empty() || name.to_lowercase().starts_with(&prefix))
        })
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect();
    dirs.sort();
    dirs.truncate(50);
    let collapsed: Vec<String> = dirs
        .into_iter()
        .map(|dir| {
            if dir.starts_with(&home_str) {
                format!("~{}", &dir[home_str.len()..])
            } else {
                dir
            }
        })
        .collect();
    Ok(json!({ "dirs": collapsed, "resolved": parent_dir }))
}

/// Get-or-create the per-dir `ShadowTree` and run `f` against it, mirroring
/// `commands/shadow.rs::with_tree` but typed against daemon `AppState`. The
/// shadow tree map persists across requests in the daemon.
fn shadow_with_tree<T, F>(
    state: &crate::state::AppState,
    dir: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&crate::services::shadow_tree::ShadowTree) -> Result<T, String>,
{
    let mut trees = state.shadow_trees.lock().map_err(|e| e.to_string())?;
    if !trees.contains_key(dir) {
        let tree = crate::services::shadow_tree::ShadowTree::open(
            &state.internal_data_dir,
            &std::path::PathBuf::from(dir),
        )?;
        trees.insert(dir.to_string(), tree);
    }
    f(trees.get(dir).unwrap())
}

#[cfg(test)]
mod search_content_tests {
    use super::{
        build_content_grep_query, search_content_impl, split_match_segments,
    };
    use fff_search::file_picker::{FilePicker, FilePickerOptions};
    use fff_search::grep::{parse_grep_query, GrepMode, GrepSearchOptions, MAX_FFFILE_SIZE};
    use std::io::Write;

    /// Spike: FilePicker::new + collect_files + picker.grep(parse_grep_query(q), opts)
    /// → GrepResult.matches[].line_number (1-based), .col (0-based byte), .line_content, .match_byte_offsets
    #[test]
    fn search_content_spike() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = std::fs::File::create(dir.path().join("hello.txt")).unwrap();
        writeln!(f, "find this needle here").unwrap();

        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: dir.path().to_str().unwrap().into(),
            watch: false,
            ..Default::default()
        })
        .unwrap();
        picker.collect_files().unwrap();

        let query = parse_grep_query("needle");
        let options = GrepSearchOptions {
            max_file_size: MAX_FFFILE_SIZE,
            max_matches_per_file: 0,
            smart_case: true,
            file_offset: 0,
            page_limit: 100,
            mode: GrepMode::PlainText,
            time_budget_ms: 0,
            before_context: 0,
            after_context: 0,
            classify_definitions: false,
            trim_whitespace: false,
            abort_signal: None,
        };
        let result = picker.grep(&query, &options);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line_number, 1);
        assert!(result.matches[0].line_content.contains("needle"));
    }

    #[test]
    fn split_match_segments_basic() {
        let (pre, m, post) = split_match_segments("const x = needle;", &[(10, 16)]);
        assert_eq!(pre, "const x = ");
        assert_eq!(m, "needle");
        assert_eq!(post, ";");
    }

    #[test]
    fn split_match_segments_respects_utf8_boundaries() {
        // Byte index 200 can land inside U+2500 '─' (3 bytes); must not panic.
        let dashes = "─".repeat(80);
        let line = format!(" {dashes}needle");
        let start = line.find("needle").unwrap() as u32;
        let end = start + 6;
        let (pre, m, post) = split_match_segments(&line, &[(start, end)]);
        assert_eq!(m, "needle");
        assert!(pre.starts_with('…'));
        assert!(post.is_empty());
    }

    fn test_state() -> crate::state::AppState {
        crate::state::AppState::new(
            9601,
            std::path::PathBuf::from("/tmp/verne-test-resources"),
            std::env::temp_dir().join("verne-test-internal"),
            dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp")),
            None,
        )
    }

    #[test]
    fn search_content_impl_finds_lines_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        let mut f = std::fs::File::create(dir.path().join("a.txt")).unwrap();
        writeln!(f, "first NEEDLE line").unwrap();
        writeln!(f, "no match here").unwrap();
        writeln!(f, "second needle line").unwrap();

        std::fs::create_dir(dir.path().join("ignored")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::write(dir.path().join("ignored").join("secret.txt"), "needle hidden").unwrap();

        let state = test_state();
        let dir_str = dir.path().to_str().unwrap();
        let out = search_content_impl(&state, dir_str, "needle", false, "", "")
            .unwrap();
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["line"], 1);
        assert_eq!(results[1]["line"], 3);
        assert!(results[0]["match"].as_str().unwrap().eq_ignore_ascii_case("needle"));
    }

    #[test]
    fn search_content_impl_case_sensitive() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.txt"), "Needle\nneedle\n").unwrap();
        let state = test_state();
        let dir_str = dir.path().to_str().unwrap();

        let insensitive = search_content_impl(&state, dir_str, "needle", false, "", "").unwrap();
        assert_eq!(insensitive["results"].as_array().unwrap().len(), 2);

        let sensitive = search_content_impl(&state, dir_str, "needle", true, "", "").unwrap();
        assert_eq!(sensitive["results"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn search_content_impl_include_glob() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "needle\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "needle\n").unwrap();
        let state = test_state();
        let dir_str = dir.path().to_str().unwrap();
        let out = search_content_impl(&state, dir_str, "needle", false, "*.rs", "").unwrap();
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0]["relPath"].as_str().unwrap().ends_with(".rs"));
    }

    #[test]
    fn build_content_grep_query_adds_excludes() {
        let state = test_state();
        let q = build_content_grep_query(&state, "foo", "*.ts", "**/node_modules/**");
        assert!(q.contains("foo"));
        assert!(q.contains("*.ts"));
        assert!(q.contains("!**/node_modules/**"));
    }
}
