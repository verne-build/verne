use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crate::services::git;
use crate::emitter::Emitter;
use crate::types::{GitDiffResult, GitOperationProgress, GitStatus};

const VISIBLE_STATUS_MAX_AGE: Duration = Duration::from_millis(150);
const HIDDEN_STATUS_MAX_AGE: Duration = Duration::from_secs(2);
const VISIBLE_POLL_INTERVAL: Duration = Duration::from_secs(1);
const HIDDEN_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct GitRepoHandle {
    tx: Sender<GitCommand>,
    operation_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

struct CachedStatus {
    status: GitStatus,
    hash: u64,
    at: Instant,
}

enum GitCommand {
    GetStatus {
        max_age: Duration,
        respond_to: oneshot::Sender<Result<GitStatus, String>>,
    },
    ScheduleRefresh {
        delay: Duration,
    },
    RegisterWatch {
        path: String,
    },
    UnregisterWatch {
        path: String,
    },
    SetVisible {
        visible: bool,
    },
    Stage {
        notify_path: String,
        files: Vec<String>,
        respond_to: oneshot::Sender<Result<(), String>>,
    },
    Unstage {
        notify_path: String,
        files: Vec<String>,
        respond_to: oneshot::Sender<Result<(), String>>,
    },
    StageAll {
        notify_path: String,
        respond_to: oneshot::Sender<Result<(), String>>,
    },
    UnstageAll {
        notify_path: String,
        respond_to: oneshot::Sender<Result<(), String>>,
    },
    Discard {
        files: Vec<String>,
        respond_to: oneshot::Sender<Result<(), String>>,
    },
    Commit {
        message: String,
        respond_to: oneshot::Sender<Result<String, String>>,
    },
    Diff {
        file: String,
        staged: bool,
        respond_to: oneshot::Sender<Result<GitDiffResult, String>>,
    },
}

impl GitRepoHandle {
    pub fn new(repo_key: String, wire: Emitter, visible: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        let operation_cancel = Arc::new(Mutex::new(None));
        let operation_cancel_for_worker = operation_cancel.clone();
        std::thread::spawn(move || {
            run_worker(repo_key, wire, visible, rx, operation_cancel_for_worker)
        });
        Self {
            tx,
            operation_cancel,
        }
    }

    pub async fn status(&self, max_age: Duration) -> Result<GitStatus, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::GetStatus {
                max_age,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub fn schedule_refresh(&self, delay: Duration) -> Result<(), String> {
        self.tx
            .send(GitCommand::ScheduleRefresh { delay })
            .map_err(|_| "git worker offline".to_string())
    }

    pub fn register_watch(&self, path: String) -> Result<(), String> {
        self.tx
            .send(GitCommand::RegisterWatch { path })
            .map_err(|_| "git worker offline".to_string())
    }

    pub fn unregister_watch(&self, path: String) -> Result<(), String> {
        self.tx
            .send(GitCommand::UnregisterWatch { path })
            .map_err(|_| "git worker offline".to_string())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.tx
            .send(GitCommand::SetVisible { visible })
            .map_err(|_| "git worker offline".to_string())
    }

    pub async fn stage(&self, notify_path: String, files: Vec<String>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::Stage {
                notify_path,
                files,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn unstage(&self, notify_path: String, files: Vec<String>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::Unstage {
                notify_path,
                files,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn stage_all(&self, notify_path: String) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::StageAll {
                notify_path,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn unstage_all(&self, notify_path: String) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::UnstageAll {
                notify_path,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn discard(&self, files: Vec<String>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::Discard {
                files,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn commit(&self, message: String) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::Commit {
                message,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

    pub async fn diff(&self, file: String, staged: bool) -> Result<GitDiffResult, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(GitCommand::Diff {
                file,
                staged,
                respond_to: tx,
            })
            .map_err(|_| "git worker offline".to_string())?;
        rx.await.map_err(|_| "git worker dropped response".to_string())?
    }

pub fn cancel_operation(&self) -> Result<bool, String> {
        let guard = self
            .operation_cancel
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

pub fn handle_for_path(
    workers: &Mutex<HashMap<String, GitRepoHandle>>,
    wire: &Emitter,
    visible: bool,
    path: &str,
) -> Result<GitRepoHandle, String> {
    let key = git::repo_key(path);
    let mut workers = workers.lock().map_err(|e| e.to_string())?;
    Ok(workers
        .entry(key.clone())
        .or_insert_with(|| GitRepoHandle::new(key, wire.clone(), visible))
        .clone())
}

fn run_worker(
    repo_key: String,
    wire: Emitter,
    mut visible: bool,
    rx: Receiver<GitCommand>,
    operation_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    let mut watched_paths = HashSet::new();
    let mut cache: Option<CachedStatus> = None;
    let mut pending_refresh_at: Option<Instant> = None;
    let mut next_poll_at: Option<Instant> = None;

    loop {
        let timeout = next_timeout(pending_refresh_at, next_poll_at);
        let timed_out = match timeout {
            Some(timeout) => match rx.recv_timeout(timeout) {
                Ok(command) => {
                    handle_command(
                        &repo_key,
                        &wire,
                        command,
                        &mut visible,
                        &mut watched_paths,
                        &mut cache,
                        &mut pending_refresh_at,
                        &operation_cancel,
                    );
                    false
                }
                Err(RecvTimeoutError::Timeout) => true,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(command) => {
                    handle_command(
                        &repo_key,
                        &wire,
                        command,
                        &mut visible,
                        &mut watched_paths,
                        &mut cache,
                        &mut pending_refresh_at,
                        &operation_cancel,
                    );
                    false
                }
                Err(_) => break,
            },
        };

        if timed_out {
            let now = Instant::now();
            if pending_refresh_at.is_some_and(|at| at <= now) {
                pending_refresh_at = None;
                let _ = refresh_status(&repo_key, &wire, &watched_paths, &mut cache);
            }
            if next_poll_at.is_some_and(|at| at <= now) {
                let _ = refresh_status(&repo_key, &wire, &watched_paths, &mut cache);
            }
        }

        next_poll_at = watched_paths
            .is_empty()
            .then_some(None)
            .unwrap_or_else(|| Some(Instant::now() + poll_interval(visible)));
    }
}

fn next_timeout(pending_refresh_at: Option<Instant>, next_poll_at: Option<Instant>) -> Option<Duration> {
    let now = Instant::now();
    [pending_refresh_at, next_poll_at]
        .into_iter()
        .flatten()
        .min()
        .map(|deadline| deadline.saturating_duration_since(now))
}

fn handle_command(
    repo_key: &str,
    wire: &Emitter,
    command: GitCommand,
    visible: &mut bool,
    watched_paths: &mut HashSet<String>,
    cache: &mut Option<CachedStatus>,
    pending_refresh_at: &mut Option<Instant>,
    operation_cancel: &Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    match command {
        GitCommand::GetStatus { max_age, respond_to } => {
            let result = if cache
                .as_ref()
                .is_some_and(|cache| cache.at.elapsed() <= max_age)
            {
                Ok(cache.as_ref().unwrap().status.clone())
            } else {
                refresh_status(repo_key, wire, watched_paths, cache).map(|status| status.status.clone())
            };
            let _ = respond_to.send(result);
        }
        GitCommand::ScheduleRefresh { delay } => {
            schedule_refresh(pending_refresh_at, cache.as_ref(), *visible, delay);
        }
        GitCommand::RegisterWatch { path } => {
            watched_paths.insert(path);
            if *visible {
                schedule_refresh(pending_refresh_at, cache.as_ref(), *visible, Duration::ZERO);
            }
        }
        GitCommand::UnregisterWatch { path } => {
            watched_paths.remove(&path);
        }
        GitCommand::SetVisible { visible: is_visible } => {
            *visible = is_visible;
            if *visible && !watched_paths.is_empty() {
                schedule_refresh(pending_refresh_at, cache.as_ref(), *visible, Duration::ZERO);
            }
        }
        GitCommand::Stage {
            notify_path,
            files,
            respond_to,
        } => {
            let result = run_cancelable_operation(operation_cancel, |cancel_flag| {
                let should_cancel = || cancel_flag.load(Ordering::Relaxed);
                git::stage_with_progress(
                    repo_key,
                    files,
                    |completed, total| {
                        emit_operation_progress(wire, &notify_path, "stage", completed, total);
                    },
                    should_cancel,
                )
            });
            if result.is_ok() || is_cancelled(&result) {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::Unstage {
            notify_path,
            files,
            respond_to,
        } => {
            let result = run_cancelable_operation(operation_cancel, |cancel_flag| {
                let should_cancel = || cancel_flag.load(Ordering::Relaxed);
                git::unstage_with_progress(
                    repo_key,
                    files,
                    |completed, total| {
                        emit_operation_progress(wire, &notify_path, "unstage", completed, total);
                    },
                    should_cancel,
                )
            });
            if result.is_ok() || is_cancelled(&result) {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::StageAll {
            notify_path,
            respond_to,
        } => {
            let result = run_cancelable_operation(operation_cancel, |cancel_flag| {
                let should_cancel = || cancel_flag.load(Ordering::Relaxed);
                git::stage_all_with_progress(
                    repo_key,
                    |completed, total| {
                        emit_operation_progress(wire, &notify_path, "stage", completed, total);
                    },
                    should_cancel,
                )
            });
            if result.is_ok() || is_cancelled(&result) {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::UnstageAll {
            notify_path,
            respond_to,
        } => {
            let result = run_cancelable_operation(operation_cancel, |cancel_flag| {
                let should_cancel = || cancel_flag.load(Ordering::Relaxed);
                git::unstage_all_with_progress(
                    repo_key,
                    |completed, total| {
                        emit_operation_progress(wire, &notify_path, "unstage", completed, total);
                    },
                    should_cancel,
                )
            });
            if result.is_ok() || is_cancelled(&result) {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::Discard { files, respond_to } => {
            let result = git::discard_files(repo_key, files);
            if result.is_ok() {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::Commit { message, respond_to } => {
            let result = git::commit(repo_key, &message);
            if result.is_ok() {
                *cache = None;
                schedule_refresh(pending_refresh_at, None, *visible, Duration::ZERO);
            }
            let _ = respond_to.send(result);
        }
        GitCommand::Diff {
            file,
            staged,
            respond_to,
        } => {
            let _ = respond_to.send(git::diff(repo_key, &file, staged));
        }
    }
}

fn run_cancelable_operation<T>(
    operation_cancel: &Arc<Mutex<Option<Arc<AtomicBool>>>>,
    f: impl FnOnce(Arc<AtomicBool>) -> Result<T, String>,
) -> Result<T, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut slot = operation_cancel.lock().map_err(|e| e.to_string())?;
        *slot = Some(cancel_flag.clone());
    }
    let result = f(cancel_flag.clone());
    let mut slot = operation_cancel.lock().map_err(|e| e.to_string())?;
    if slot
        .as_ref()
        .is_some_and(|flag| Arc::ptr_eq(flag, &cancel_flag))
    {
        *slot = None;
    }
    result
}

fn is_cancelled<T>(result: &Result<T, String>) -> bool {
    matches!(result, Err(error) if error == git::GIT_OPERATION_CANCELLED)
}

fn schedule_refresh(
    pending_refresh_at: &mut Option<Instant>,
    cache: Option<&CachedStatus>,
    visible: bool,
    delay: Duration,
) {
    let min_gap = if visible {
        VISIBLE_STATUS_MAX_AGE
    } else {
        HIDDEN_STATUS_MAX_AGE
    };
    if cache.is_some_and(|cache| cache.at.elapsed() < min_gap && delay <= min_gap) {
        return;
    }
    let due = Instant::now() + delay;
    match pending_refresh_at {
        Some(existing) if *existing <= due => {}
        _ => *pending_refresh_at = Some(due),
    }
}

fn refresh_status(
    repo_key: &str,
    wire: &Emitter,
    watched_paths: &HashSet<String>,
    cache: &mut Option<CachedStatus>,
) -> Result<CachedStatus, String> {
    let status = git::status(repo_key)?;
    // Branch folded into the hash so a checkout (clean tree, file lists
    // unchanged) still flips the hash → emits git-status-changed → UI refreshes
    // the branch name.
    let branch = git::branch_name(repo_key).unwrap_or_default();
    let hash = status_hash(&status, &branch);
    let changed = cache.as_ref().map(|cache| cache.hash != hash).unwrap_or(true);
    let next = CachedStatus {
        status,
        hash,
        at: Instant::now(),
    };
    if changed {
        for path in watched_paths {
            wire.emit("git-status-changed", path);
        }
    }
    *cache = Some(CachedStatus {
        status: next.status.clone(),
        hash: next.hash,
        at: next.at,
    });
    Ok(next)
}

fn status_hash(status: &GitStatus, branch: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{:?}{:?}{:?}{branch}", status.staged, status.unstaged, status.untracked)
        .hash(&mut hasher);
    hasher.finish()
}

fn emit_operation_progress(
    wire: &Emitter,
    path: &str,
    action: &str,
    completed: usize,
    total: usize,
) {
    wire.emit(
        "git-operation-progress",
        GitOperationProgress {
            path: path.to_string(),
            action: action.to_string(),
            completed: completed as u32,
            total: total as u32,
        },
    );
}

fn poll_interval(visible: bool) -> Duration {
    if visible {
        VISIBLE_POLL_INTERVAL
    } else {
        HIDDEN_POLL_INTERVAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_status() -> GitStatus {
        GitStatus {
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            current_branch: None,
            upstream: None,
            has_remote: false,
            default_remote: None,
        }
    }

    #[test]
    fn branch_change_flips_hash() {
        // Same (clean) file state, different branch → hash must differ so a
        // checkout emits git-status-changed.
        let status = empty_status();
        assert_ne!(status_hash(&status, "main"), status_hash(&status, "feature"));
    }

    #[test]
    fn same_branch_same_hash() {
        let status = empty_status();
        assert_eq!(status_hash(&status, "main"), status_hash(&status, "main"));
    }
}
