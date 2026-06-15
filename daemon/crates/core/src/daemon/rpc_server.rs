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
                    let c = state.picker_cache.lock().map_err(|e| e.to_string())?;
                    let paths: u32 = c
                        .values()
                        .map(|e| {
                            e.picker
                                .read()
                                .ok()
                                .and_then(|g| g.as_ref().map(|p| p.get_files().len() as u32))
                                .unwrap_or(0)
                        })
                        .sum();
                    (c.len() as u32, paths)
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
        m if m == crate::protocol::methods::GIT_WATCH => {
            let path = s(req.params.get("path"));
            // Reserve the watcher entry atomically under the lock BEFORE spawning,
            // so two concurrent git_watch(path) calls can't both spawn a polling
            // thread (the second insert would orphan the first thread's stop flag).
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let mut watchers = match state.git_watchers.lock() {
                    Ok(w) => w,
                    Err(e) => return Response::err(req.id, e.to_string()),
                };
                if watchers.contains_key(&path) {
                    return Response::ok(req.id, serde_json::Value::Null);
                }
                watchers.insert(path.clone(), std::sync::Arc::clone(&stop));
            }
            let worker = match git_handle(&state, &path) {
                Ok(w) => w,
                Err(e) => {
                    if let Ok(mut w) = state.git_watchers.lock() { w.remove(&path); }
                    return Response::err(req.id, e);
                }
            };
            if let Err(e) = worker.register_watch(path.clone()) {
                if let Ok(mut w) = state.git_watchers.lock() { w.remove(&path); }
                return Response::err(req.id, e);
            }
            let stop_clone = std::sync::Arc::clone(&stop);
            let visible = std::sync::Arc::clone(&state.source_control_visible);
            std::thread::spawn(move || loop {
                if stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let interval = if visible.load(std::sync::atomic::Ordering::Relaxed) { 1 } else { 5 };
                std::thread::sleep(std::time::Duration::from_secs(interval));
                if stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let _ = worker.schedule_refresh(std::time::Duration::ZERO);
            });
            // Instant branch-change detection: nudge the same worker on HEAD
            // fs events. Poll above stays as the fallback.
            watch_git_head(&state, &path);
            Response::ok(req.id, serde_json::Value::Null)
        }
        m if m == crate::protocol::methods::GIT_UNWATCH => {
            let path = s(req.params.get("path"));
            {
                let mut watchers = match state.git_watchers.lock() {
                    Ok(w) => w,
                    Err(e) => return Response::err(req.id, e.to_string()),
                };
                if let Some(stop) = watchers.remove(&path) {
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
            if let Ok(mut fw) = state.file_watchers.lock() {
                fw.remove(&format!("git-head:{path}"));
            }
            if let Ok(handle) = git_handle(&state, &path) {
                let _ = handle.unregister_watch(path);
            }
            Response::ok(req.id, serde_json::Value::Null)
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

        // ---- notes.rs ----
        m if m == crate::protocol::methods::NOTES_DIR_PATH => {
            let workspace_root = s(req.params.get("workspaceRoot"));
            let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
                let dir = notes_dir_for(&workspace_root);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                Ok(dir.to_string_lossy().into_owned())
            })
            .await
            .map_err(|e| format!("notes dir task failed: {e}"));
            match result {
                Ok(Ok(v)) => Response::ok(req.id, serde_json::Value::String(v)),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::NOTES_LIST => {
            let workspace_root = s(req.params.get("workspaceRoot"));
            let result = crate::notes::list(&notes_dir_for(&workspace_root));
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::NOTES_CREATE => {
            let workspace_root = s(req.params.get("workspaceRoot"));
            let title = s(req.params.get("title"));
            let result: Result<crate::notes::NoteMeta, String> = (|| {
                let dir = notes_dir_for(&workspace_root);
                let slug = crate::notes::create(&dir, &title, "")?;
                Ok(crate::notes::NoteMeta { slug, title })
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::NOTES_RENAME => {
            let workspace_root = s(req.params.get("workspaceRoot"));
            let slug = s(req.params.get("slug"));
            let title = s(req.params.get("title"));
            let result =
                crate::notes::rename(&notes_dir_for(&workspace_root), &slug, &title);
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::NOTES_DELETE => {
            let workspace_root = s(req.params.get("workspaceRoot"));
            let slug = s(req.params.get("slug"));
            let result = crate::notes::delete(&notes_dir_for(&workspace_root), &slug);
            match result {
                Ok(()) => Response::ok(req.id, serde_json::Value::Null),
                Err(e) => Response::err(req.id, e),
            }
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
            // Recency now native to FFF's frecency tracker; no recency arg.
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                search_files_impl(&state, &dir, &query)
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
        // Record a file open into FFF's native frecency tracker. Re-ranks future
        // file/content searches; no separate recent_files table.
        m if m == "touch_recent_file" => {
            let path = s(req.params.get("path"));
            let state = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(g) = state.frecency.read() {
                    if let Some(t) = g.as_ref() {
                        let _ = t.track_access(std::path::Path::new(&path));
                    }
                }
            })
            .await;
            Response::ok(req.id, serde_json::json!(true))
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
                ensure_dir_picker(&state, &dir).map(|_| ())
            })
            .await
            .map_err(|e| format!("prewarm_file_index task failed: {e}"));
            match result {
                Ok(Ok(())) => Response::ok(req.id, serde_json::Value::Null),
                Ok(Err(e)) => Response::err(req.id, e),
                Err(e) => Response::err(req.id, e),
            }
        }
        // ---- file_watch.rs (notify watchers → event bus) ----
        m if m == crate::protocol::methods::WATCH_FILE => {
            let path = s(req.params.get("path"));
            match watch_file_impl(&state, path) {
                Ok(v) => Response::ok(req.id, serde_json::json!(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::UNWATCH_FILE => {
            let path = s(req.params.get("path"));
            if let Ok(mut watchers) = state.file_watchers.lock() {
                watchers.remove(&path);
            }
            Response::ok(req.id, serde_json::json!(true))
        }
        m if m == crate::protocol::methods::WATCH_DIRECTORY => {
            let path = s(req.params.get("path"));
            match watch_directory_impl(&state, path) {
                Ok(v) => Response::ok(req.id, serde_json::json!(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == crate::protocol::methods::UNWATCH_DIRECTORY => {
            let path = s(req.params.get("path"));
            if let Ok(mut watchers) = state.file_watchers.lock() {
                watchers.remove(&format!("dir:{}", path));
            }
            Response::ok(req.id, serde_json::json!(true))
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

/// Get (building if needed) the shared FFF picker for `dir`. Used by both file
/// and content search. The picker runs a background scan + fs watcher and
/// applies the global frecency tracker to every file during the walk.
fn ensure_dir_picker(
    state: &crate::state::AppState,
    dir: &str,
) -> Result<fff_search::SharedFilePicker, String> {
    use fff_search::{FilePicker, FilePickerOptions, SharedFilePicker};
    use std::time::Duration;

    let mut cache = state.picker_cache.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = cache.get(dir) {
        return Ok(entry.picker.clone());
    }
    if !std::path::Path::new(dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let shared = SharedFilePicker::default();
    FilePicker::new_with_shared_state(
        shared.clone(),
        state.frecency.clone(),
        FilePickerOptions {
            base_path: dir.to_string(),
            watch: true,
            enable_home_dir_scanning: true,
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    // First build only — blocks until the initial scan lands so the next query
    // hits a warm index.
    shared.wait_for_scan(Duration::from_secs(10));
    cache.insert(
        dir.to_string(),
        crate::state::DirPickerCache { picker: shared.clone() },
    );
    Ok(shared)
}

/// File search via FFF `fuzzy_search` over the per-dir shared picker. Ranking
/// (incl. native frecency boost) is FFF's; no custom scoring.
fn search_files_impl(
    state: &crate::state::AppState,
    dir: &str,
    query: &str,
) -> Result<serde_json::Value, String> {
    use fff_search::{FuzzySearchOptions, PaginationArgs, QueryParser};
    use serde_json::json;
    use std::path::Path;

    let base = Path::new(dir);
    let t0 = std::time::Instant::now();
    let shared = ensure_dir_picker(state, dir)?;
    let guard = shared.read().map_err(|e| e.to_string())?;
    let picker = guard.as_ref().ok_or("picker not ready")?;

    // `recent` = file has been opened before (FFF frecency > 0). Lets the
    // renderer split results into a "Recent Files" header section.
    let mk = |rel: String, recent: bool| {
        let name = Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let abs = base.join(&rel).to_string_lossy().to_string();
        json!({ "name": name, "path": abs, "relPath": rel, "recent": recent })
    };

    let results: Vec<serde_json::Value> = if query.trim().is_empty() {
        // No query: list files ordered by frecency desc, then relative path asc.
        let mut files: Vec<&fff_search::FileItem> = picker.get_files().iter().collect();
        files.sort_by(|a, b| {
            b.total_frecency_score()
                .cmp(&a.total_frecency_score())
                .then_with(|| a.relative_path(picker).cmp(&b.relative_path(picker)))
        });
        files
            .into_iter()
            .take(50)
            .map(|f| mk(f.relative_path(picker), f.total_frecency_score() > 0))
            .collect()
    } else {
        let parser = QueryParser::default();
        let parsed = parser.parse(query);
        let result = picker.fuzzy_search(
            &parsed,
            None,
            FuzzySearchOptions {
                max_threads: 0,
                current_file: None,
                project_path: Some(base),
                pagination: PaginationArgs { offset: 0, limit: 50 },
                ..Default::default()
            },
        );
        result
            .items
            .into_iter()
            .map(|f| mk(f.relative_path(picker), f.total_frecency_score() > 0))
            .collect()
    };

    if std::env::var_os("VERNE_SEARCH_TIMING").is_some() {
        eprintln!(
            "[search] q={:?} returned={} {:?}",
            query,
            results.len(),
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

    let shared = ensure_dir_picker(state, dir)?;
    let guard = shared.read().map_err(|e| e.to_string())?;
    let picker = guard.as_ref().ok_or("picker not ready")?;
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

/// True if a path is a repo's `HEAD` ref file (branch pointer) — exactly
/// `HEAD`, not the transient `HEAD.lock` or other `.git` entries. Used to
/// filter `.git`-directory fs events down to branch changes.
fn path_is_head(path: &std::path::Path) -> bool {
    path.file_name().is_some_and(|n| n == "HEAD")
}

/// Watch `<root>/.git` (non-recursive) and nudge the git worker on `HEAD`
/// changes, so a branch checkout refreshes immediately instead of waiting for
/// the 1–5s poll. The `RecommendedWatcher` is stored in `file_watchers` under
/// `git-head:<root>` to keep it alive; `git_unwatch` removes it. No-op if
/// `<root>/.git` is not a directory (non-repo, or a linked worktree whose
/// `.git` is a file — the poll still covers those).
fn watch_git_head(state: &Arc<crate::state::AppState>, root: &str) {
    use notify::{Event, RecursiveMode, Watcher};

    let git_dir = std::path::Path::new(root).join(".git");
    if !git_dir.is_dir() {
        return;
    }

    // Dedup: never replace a live watcher for this root (dropping the old one
    // briefly drops its kernel watch). Mirrors the git_watchers dedup upstream.
    let key = format!("git-head:{root}");
    if state.file_watchers.lock().map(|w| w.contains_key(&key)).unwrap_or(false) {
        return;
    }

    let state_cb = Arc::clone(state);
    let root_owned = root.to_string();
    let mut watcher = match notify::RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(ev) = res else { return };
            if !matches!(
                ev.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            ) {
                return;
            }
            if ev.paths.iter().any(|p| path_is_head(p)) {
                if let Ok(worker) = git_handle(&state_cb, &root_owned) {
                    let _ = worker.schedule_refresh(std::time::Duration::ZERO);
                }
            }
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("watch_git_head: watcher init failed for {root}: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&git_dir, RecursiveMode::NonRecursive) {
        log::warn!("watch_git_head: watch failed for {}: {e}", git_dir.display());
        return;
    }
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.insert(key, watcher);
    }
}

/// Mirror of `commands/file_watch.rs::watch_file` — notify watcher whose
/// callback emits `file-changed` / `file-deleted` through the daemon event bus.
fn watch_file_impl(state: &crate::state::AppState, path: String) -> Result<bool, String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::path::PathBuf;
    use std::time::Duration;

    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err("file does not exist".to_string());
    }
    let emit_path = path.clone();
    let emit_path2 = path.clone();
    let watch_path2 = watch_path.clone();
    let bus1 = state.event_bus.clone();
    let bus2 = state.event_bus.clone();
    let mut watcher = notify::RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    bus1.emit("file-changed", serde_json::Value::String(emit_path.clone()));
                } else if matches!(ev.kind, EventKind::Remove(_)) {
                    let path = watch_path2.clone();
                    let bus = bus2.clone();
                    let emit = emit_path2.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(150));
                        if path.exists() {
                            bus.emit("file-changed", serde_json::Value::String(emit));
                        } else {
                            bus.emit("file-deleted", serde_json::Value::String(emit));
                        }
                    });
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.insert(path, watcher);
    }
    Ok(true)
}

/// Mirror of `commands/file_watch.rs::watch_directory` — emits `directory-changed`
/// via the bus on structural changes. The FFF per-dir picker owns its own fs
/// watcher, so no manual index-cache invalidation is needed here.
fn watch_directory_impl(state: &crate::state::AppState, path: String) -> Result<bool, String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::path::PathBuf;

    let watch_path = PathBuf::from(&path);
    if !watch_path.is_dir() {
        return Err("not a directory".to_string());
    }
    let emit_path = path.clone();
    let bus = state.event_bus.clone();
    let mut watcher = notify::RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) {
                    bus.emit("directory-changed", serde_json::Value::String(emit_path.clone()));
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.insert(format!("dir:{}", path), watcher);
    }
    Ok(true)
}

/// Resolve a workspace root's notes storage dir. Root is resolved by the
/// caller (Electron) and passed in — no DB read here.
fn notes_dir_for(workspace_root: &str) -> std::path::PathBuf {
    crate::paths::notes_dir(workspace_root)
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
        build_content_grep_query, search_content_impl, search_files_impl, split_match_segments,
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

    /// AppState with an isolated internal_data_dir so each test gets its own
    /// frecency LMDB env (no cross-test lock contention).
    fn isolated_state(internal: &std::path::Path) -> crate::state::AppState {
        crate::state::AppState::new(
            9601,
            std::path::PathBuf::from("/tmp/verne-test-resources"),
            internal.to_path_buf(),
            dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp")),
            None,
        )
    }

    fn rel_paths(out: &serde_json::Value) -> Vec<String> {
        out["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["relPath"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn search_files_impl_ranks_filename_match() {
        let internal = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("foo.rs"), "").unwrap();
        std::fs::write(dir.path().join("src").join("foobar.rs"), "").unwrap();

        let state = isolated_state(internal.path());
        let dir_str = dir.path().to_str().unwrap();
        let out = search_files_impl(&state, dir_str, "foo").unwrap();
        let rels = rel_paths(&out);
        assert!(rels.iter().any(|r| r.ends_with("foo.rs")));
        assert!(rels.iter().any(|r| r.ends_with("foobar.rs")));
        // Exact-stem match should rank at/near the top.
        let foo_pos = rels.iter().position(|r| r.ends_with("foo.rs")).unwrap();
        let foobar_pos = rels.iter().position(|r| r.ends_with("foobar.rs")).unwrap();
        assert!(foo_pos <= foobar_pos);
    }

    #[test]
    fn search_files_impl_empty_query_returns_files() {
        let internal = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "").unwrap();
        }
        let state = isolated_state(internal.path());
        let dir_str = dir.path().to_str().unwrap();
        let out = search_files_impl(&state, dir_str, "").unwrap();
        let results = out["results"].as_array().unwrap();
        assert!(!results.is_empty());
        assert!(results.len() <= 50);
        for r in results {
            assert!(r["name"].is_string());
            assert!(r["path"].is_string());
            assert!(r["relPath"].is_string());
        }
    }

    #[test]
    fn search_files_impl_respects_gitignore() {
        let internal = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        std::fs::write(dir.path().join("keep.rs"), "").unwrap();
        std::fs::create_dir(dir.path().join("ignored")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::write(dir.path().join("ignored").join("x.rs"), "").unwrap();

        let state = isolated_state(internal.path());
        let dir_str = dir.path().to_str().unwrap();
        let out = search_files_impl(&state, dir_str, "").unwrap();
        let rels = rel_paths(&out);
        assert!(rels.iter().any(|r| r.ends_with("keep.rs")));
        assert!(!rels.iter().any(|r| r.contains("ignored")));
    }
}

#[cfg(test)]
mod git_head_tests {
    use super::path_is_head;
    use std::path::Path;

    #[test]
    fn matches_head_only() {
        assert!(path_is_head(Path::new("/repo/.git/HEAD")));
        assert!(!path_is_head(Path::new("/repo/.git/HEAD.lock")));
        assert!(!path_is_head(Path::new("/repo/.git/index")));
        assert!(!path_is_head(Path::new("/repo/.git/config")));
    }
}
