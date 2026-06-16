use std::sync::Arc;

use serde::Deserialize;

use crate::protocol::{methods, Request, Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathParams {
    path: String,
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        methods::GIT_WATCH
            | methods::GIT_UNWATCH
            | methods::WATCH_FILE
            | methods::UNWATCH_FILE
            | methods::WATCH_DIRECTORY
            | methods::UNWATCH_DIRECTORY
    )
}

pub async fn dispatch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    match req.method.as_str() {
        methods::GIT_WATCH => git_watch(req, state).await,
        methods::GIT_UNWATCH => git_unwatch(req, state).await,
        methods::WATCH_FILE => watch_file(req, state).await,
        methods::UNWATCH_FILE => unwatch_file(req, state).await,
        methods::WATCH_DIRECTORY => watch_directory(req, state).await,
        methods::UNWATCH_DIRECTORY => unwatch_directory(req, state).await,
        _ => Response::err(req.id, format!("unknown watch method: {}", req.method)),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, Response> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| Response::err(req.id, format!("bad {} params: {e}", req.method)))
}

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

async fn git_watch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    match git_watch_impl(&state, params.path) {
        Ok(()) => Response::ok(id, serde_json::Value::Null),
        Err(e) => Response::err(id, e),
    }
}

fn git_watch_impl(state: &Arc<crate::state::AppState>, path: String) -> Result<(), String> {
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut watchers = state.git_watchers.lock().map_err(|e| e.to_string())?;
        if watchers.contains_key(&path) {
            return Ok(());
        }
        watchers.insert(path.clone(), Arc::clone(&stop));
    }
    let worker = match git_handle(state, &path) {
        Ok(w) => w,
        Err(e) => {
            if let Ok(mut w) = state.git_watchers.lock() {
                w.remove(&path);
            }
            return Err(e);
        }
    };
    if let Err(e) = worker.register_watch(path.clone()) {
        if let Ok(mut w) = state.git_watchers.lock() {
            w.remove(&path);
        }
        return Err(e);
    }
    let stop_clone = Arc::clone(&stop);
    let visible = Arc::clone(&state.source_control_visible);
    std::thread::spawn(move || loop {
        if stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let interval = if visible.load(std::sync::atomic::Ordering::Relaxed) {
            1
        } else {
            5
        };
        std::thread::sleep(std::time::Duration::from_secs(interval));
        if stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let _ = worker.schedule_refresh(std::time::Duration::ZERO);
    });
    watch_git_head(state, &path);
    Ok(())
}

async fn git_unwatch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    match git_unwatch_impl(&state, params.path) {
        Ok(()) => Response::ok(id, serde_json::Value::Null),
        Err(e) => Response::err(id, e),
    }
}

fn git_unwatch_impl(state: &Arc<crate::state::AppState>, path: String) -> Result<(), String> {
    {
        let mut watchers = state.git_watchers.lock().map_err(|e| e.to_string())?;
        if let Some(stop) = watchers.remove(&path) {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    if let Ok(mut fw) = state.file_watchers.lock() {
        fw.remove(&format!("git-head:{path}"));
    }
    if let Ok(handle) = git_handle(state, &path) {
        let _ = handle.unregister_watch(path);
    }
    Ok(())
}

async fn watch_file(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || watch_file_impl(&state, params.path))
        .await
        .map_err(|e| format!("watch file task failed: {e}"));
    bool_result_to_response(id, result)
}

async fn unwatch_file(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.remove(&params.path);
    }
    Response::ok(id, serde_json::json!(true))
}

async fn watch_directory(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || watch_directory_impl(&state, params.path))
        .await
        .map_err(|e| format!("watch directory task failed: {e}"));
    bool_result_to_response(id, result)
}

async fn unwatch_directory(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.remove(&format!("dir:{}", params.path));
    }
    Response::ok(id, serde_json::json!(true))
}

fn bool_result_to_response(id: u64, result: Result<Result<bool, String>, String>) -> Response {
    match result {
        Ok(Ok(v)) => Response::ok(id, serde_json::json!(v)),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

fn path_is_head(path: &std::path::Path) -> bool {
    path.file_name().is_some_and(|n| n == "HEAD")
}

fn watch_git_head(state: &Arc<crate::state::AppState>, root: &str) {
    use notify::{Event, RecursiveMode, Watcher};

    let git_dir = std::path::Path::new(root).join(".git");
    if !git_dir.is_dir() {
        return;
    }

    let key = format!("git-head:{root}");
    if state
        .file_watchers
        .lock()
        .map(|w| w.contains_key(&key))
        .unwrap_or(false)
    {
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
        log::warn!(
            "watch_git_head: watch failed for {}: {e}",
            git_dir.display()
        );
        return;
    }
    if let Ok(mut watchers) = state.file_watchers.lock() {
        watchers.insert(key, watcher);
    }
}

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

fn watch_directory_impl(state: &crate::state::AppState, path: String) -> Result<bool, String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::path::PathBuf;

    let watch_path = PathBuf::from(&path);
    if !watch_path.is_dir() {
        return Err("not a directory".to_string());
    }
    let emit_path = path.clone();
    let file_cache = Arc::clone(&state.file_list_cache);
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
                    if let Ok(mut c) = file_cache.lock() {
                        c.retain(|cached_dir, _| {
                            !(cached_dir == &emit_path
                                || cached_dir.starts_with(&format!("{}/", emit_path))
                                || emit_path.starts_with(&format!("{}/", cached_dir)))
                        });
                    }
                    bus.emit(
                        "directory-changed",
                        serde_json::Value::String(emit_path.clone()),
                    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn request(id: u64, method: &str, params: serde_json::Value) -> Request {
        Request {
            id,
            method: method.to_string(),
            params,
        }
    }

    fn test_state() -> Arc<crate::state::AppState> {
        Arc::new(crate::state::AppState::new(
            0,
            std::path::PathBuf::new(),
            std::env::temp_dir(),
            std::env::temp_dir(),
            None,
        ))
    }

    #[test]
    fn handles_watch_methods_only() {
        assert!(handles(methods::GIT_WATCH));
        assert!(handles(methods::UNWATCH_DIRECTORY));
        assert!(!handles(methods::NOTES_LIST));
    }

    #[test]
    fn matches_head_only() {
        assert!(path_is_head(Path::new("/repo/.git/HEAD")));
        assert!(!path_is_head(Path::new("/repo/.git/HEAD.lock")));
        assert!(!path_is_head(Path::new("/repo/.git/index")));
        assert!(!path_is_head(Path::new("/repo/.git/config")));
    }

    #[tokio::test]
    async fn dispatch_rejects_bad_params() {
        let resp = dispatch(
            request(9, methods::WATCH_FILE, serde_json::json!({})),
            test_state(),
        )
        .await;
        assert_eq!(resp.id, 9);
        assert!(resp
            .error
            .unwrap()
            .message
            .contains("bad watch_file params"));
    }
}
