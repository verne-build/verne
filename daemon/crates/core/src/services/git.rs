use crate::types::{CommitFileEntry, CommitInfo, CommitLogResult, GitDiffResult, GitFileEntry, GitStatus};
use git2::Repository;
use std::collections::HashMap;
use std::path::Path;

pub const GIT_OPERATION_CANCELLED: &str = "git operation cancelled";

/// `git` command with the expanded login PATH. Bundled `.app` launches inherit
/// a minimal PATH (/usr/bin:/bin:…) that often lacks `git`, so a bare
/// `Command::new("git")` fails with "No such file or directory". `expanded_path`
/// adds Homebrew / volta / nvm bins so checkout/pull/push/fetch actually run.
fn git_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.env("PATH", expanded_path());
    // Backend process: never let git block on an interactive credential prompt.
    // Without an answerable TTY it hangs forever on /dev/tty waiting for a
    // username/password; this makes it fail fast with a readable error instead.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// Run a git command with a hard timeout. Reader threads drain stdout/stderr
/// (avoids pipe-fill deadlock) and the child is killed on timeout. Network ops
/// (push/pull/fetch) can otherwise hang indefinitely when a credential helper
/// blocks on a prompt the backend can't satisfy — `GIT_TERMINAL_PROMPT=0` stops
/// git's own prompt, this is the backstop for a wedged helper.
fn run_git_timed(mut cmd: std::process::Command, secs: u64) -> Result<std::process::Output, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn git: {e}"))?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let so_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let se_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait().map_err(|e| format!("git wait: {e}"))? {
            Some(status) => {
                let stdout = so_h.join().unwrap_or_default();
                let stderr = se_h.join().unwrap_or_default();
                return Ok(std::process::Output { status, stdout, stderr });
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git timed out after {secs}s (no remote response; check credentials/network)"
                ));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// PATH augmented with common node/git install locations + nvm default. Bundled
/// `.app` launches inherit a minimal PATH that often lacks these bins.
fn expanded_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();

    let mut extras = vec![
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        home.join(".volta/bin").to_string_lossy().to_string(),
    ];

    // Resolve nvm default alias → actual version bin dir
    if let Ok(alias) = std::fs::read_to_string(home.join(".nvm/alias/default")) {
        let alias = alias.trim();
        let versions_dir = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&versions_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str == format!("v{alias}") || name_str.starts_with(&format!("v{alias}.")) {
                    extras.push(entry.path().join("bin").to_string_lossy().to_string());
                    break;
                }
            }
        }
    }

    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| !current.contains(p.as_str()))
        .collect();
    parts.push(current);
    parts.join(":")
}

pub fn repo_key(path: &str) -> String {
    Repository::discover(path)
        .ok()
        .and_then(|repo| {
            repo.workdir()
                .map(|path| path.to_path_buf())
                .or_else(|| repo.path().parent().map(|path| path.to_path_buf()))
        })
        .unwrap_or_else(|| std::path::PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

/// Resolve the git working-tree root containing `working_dir` (libgit2 discover,
/// not a `git` shell-out — bundled `.app` launches lack `git` on PATH).
pub fn resolve_repo_root(working_dir: &str) -> Option<String> {
    let repo = Repository::discover(working_dir).ok()?;
    let workdir = repo.workdir()?;
    let s = workdir.to_string_lossy();
    Some(s.trim_end_matches('/').to_string())
}

/// Initialize a new git repo at `path`
pub fn init(path: &str) -> Result<(), String> {
    Repository::init(path).map_err(|e| format!("git init: {e}"))?;
    Ok(())
}

/// Get full git status for a repo at `path`
pub fn status(path: &str) -> Result<GitStatus, String> {
    // A missing path or a non-repo directory is a benign "no git here" state for
    // read-only queries (the UI speculatively fetches status for every saved
    // workspace, some of which may be deleted or not repos) — return empty
    // rather than erroring.
    if !repo_present(path) {
        return Ok(GitStatus {
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            current_branch: None,
            upstream: None,
            has_remote: false,
            default_remote: None,
        });
    }
    status_git2(path)
}

/// True if `path` exists and resolves inside a git repository. Used to short-
/// circuit read-only queries (status/branch) into an empty result instead of a
/// hard error when a saved workspace was deleted or was never a repo.
fn repo_present(path: &str) -> bool {
    std::path::Path::new(path).exists() && Repository::discover(path).is_ok()
}

fn status_git2(path: &str) -> Result<GitStatus, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let (current_branch, upstream, has_remote, default_remote) = branch_remote_meta(&repo);
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git status: {e}"))?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path_str = entry.path().unwrap_or("").to_string();
        let st = entry.status();

        // Staged (index → HEAD)
        if st.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        ) {
            let status = if st.contains(git2::Status::INDEX_NEW) {
                "A"
            } else if st.contains(git2::Status::INDEX_DELETED) {
                "D"
            } else if st.contains(git2::Status::INDEX_RENAMED) {
                "R"
            } else {
                "M"
            };

            let old_path = if status == "R" {
                entry
                    .head_to_index()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
            } else {
                None
            };

            let is_binary = entry
                .head_to_index()
                .map(|d| {
                    d.old_file().is_binary() || d.new_file().is_binary()
                })
                .unwrap_or(false);

            staged.push(GitFileEntry {
                path: path_str.clone(),
                old_path,
                status: status.to_string(),
                added: 0,
                deleted: 0,
                is_binary,
            });
        }

        // Unstaged (workdir → index)
        if st.intersects(
            git2::Status::WT_MODIFIED | git2::Status::WT_DELETED | git2::Status::WT_RENAMED,
        ) {
            let status = if st.contains(git2::Status::WT_DELETED) {
                "D"
            } else if st.contains(git2::Status::WT_RENAMED) {
                "R"
            } else {
                "M"
            };

            let old_path = if status == "R" {
                entry
                    .index_to_workdir()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
            } else {
                None
            };

            let is_binary = entry
                .index_to_workdir()
                .map(|d| {
                    d.old_file().is_binary() || d.new_file().is_binary()
                })
                .unwrap_or(false);

            unstaged.push(GitFileEntry {
                path: path_str.clone(),
                old_path,
                status: status.to_string(),
                added: 0,
                deleted: 0,
                is_binary,
            });
        }

        // Untracked
        if st.contains(git2::Status::WT_NEW) {
            let is_binary = repo.workdir().map(|wd| {
                let fp = wd.join(&path_str);
                let mut buf = [0u8; 8192];
                std::fs::File::open(&fp)
                    .and_then(|mut f| std::io::Read::read(&mut f, &mut buf))
                    .map(|n| buf[..n].contains(&0u8))
                    .unwrap_or(false)
            }).unwrap_or(false);

            untracked.push(GitFileEntry {
                path: path_str,
                old_path: None,
                status: "U".to_string(),
                added: 0,
                deleted: 0,
                is_binary,
            });
        }
    }

    Ok(GitStatus {
        staged,
        unstaged,
        untracked,
        current_branch,
        upstream,
        has_remote,
        default_remote,
    })
}

fn branch_remote_meta(repo: &Repository) -> (Option<String>, Option<String>, bool, Option<String>) {
    let remotes = repo.remotes().ok();
    let remote_names: Vec<String> = remotes
        .as_ref()
        .map(|names| names.iter().flatten().map(str::to_string).collect())
        .unwrap_or_default();
    let has_remote = !remote_names.is_empty();
    let default_remote = remote_names
        .iter()
        .find(|name| name.as_str() == "origin")
        .or_else(|| remote_names.first())
        .cloned();

    let mut current_branch = None;
    let mut upstream = None;
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            current_branch = head.shorthand().map(str::to_string);
            if let Some(head_name) = head.name() {
                if let Ok(upstream_name) = repo.branch_upstream_name(head_name) {
                    upstream = upstream_name.as_str().map(|name| {
                        name.strip_prefix("refs/remotes/")
                            .unwrap_or(name)
                            .to_string()
                    });
                }
            }
        }
    }

    (current_branch, upstream, has_remote, default_remote)
}

pub fn stage_with_progress<F, C>(
    path: &str,
    files: Vec<String>,
    mut on_progress: F,
    should_cancel: C,
) -> Result<(), String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("git index: {e}"))?;
    let files = dedupe_paths(files);
    let total = files.len();
    for (idx, file) in files.iter().enumerate() {
        if should_cancel() {
            break;
        }
        let full = repo.workdir().unwrap().join(file);
        if full.exists() {
            index
                .add_path(std::path::Path::new(file))
                .map_err(|e| format!("stage {file}: {e}"))?;
        } else {
            index
                .remove_path(std::path::Path::new(file))
                .map_err(|e| format!("stage delete {file}: {e}"))?;
        }
        emit_progress(&mut on_progress, idx + 1, total);
    }
    index.write().map_err(|e| format!("index write: {e}"))?;
    if should_cancel() {
        Err(GIT_OPERATION_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

pub fn stage_all_with_progress<F, C>(
    path: &str,
    mut on_progress: F,
    should_cancel: C,
) -> Result<(), String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("git index: {e}"))?;
    let files = collect_stage_all_files(&repo)?;
    let total = files.len();
    if total == 0 {
        return Ok(());
    }

    let deleted: std::collections::HashSet<_> = repo
        .workdir()
        .into_iter()
        .flat_map(|wd| files.iter().filter(move |file| !wd.join(file).exists()).cloned())
        .collect();
    let pathspecs: Vec<&str> = files.iter().map(|file| file.as_str()).collect();
    let mut completed = 0usize;
    let mut cb = |matched: &Path, _matched_spec: &[u8]| -> i32 {
        if should_cancel() {
            return -1;
        }
        let rel = matched.to_string_lossy();
        if deleted.contains(rel.as_ref()) {
            return 0;
        }
        completed += 1;
        emit_progress(&mut on_progress, completed, total);
        0
    };

    let add_result = index
        .add_all(
            pathspecs.iter(),
            git2::IndexAddOption::DEFAULT,
            Some(&mut cb),
        );
    if let Err(error) = add_result {
        if !should_cancel() {
            return Err(format!("stage all: {error}"));
        }
    }

    for file in files.iter().filter(|file| deleted.contains(file.as_str())) {
        if should_cancel() {
            break;
        }
        index
            .remove_path(std::path::Path::new(file))
            .map_err(|e| format!("stage delete {file}: {e}"))?;
        completed += 1;
        emit_progress(&mut on_progress, completed, total);
    }

    index.write().map_err(|e| format!("index write: {e}"))?;
    if should_cancel() {
        Err(GIT_OPERATION_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

pub fn unstage_with_progress<F, C>(
    path: &str,
    files: Vec<String>,
    mut on_progress: F,
    should_cancel: C,
) -> Result<(), String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let files = dedupe_paths(files);
    let total = files.len();
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    match head_commit {
        Some(commit) => {
            for (idx, file) in files.iter().enumerate() {
                if should_cancel() {
                    break;
                }
                let pathspecs = [file.as_str()];
                repo.reset_default(Some(commit.as_object()), pathspecs.iter())
                    .map_err(|e| format!("unstage {file}: {e}"))?;
                emit_progress(&mut on_progress, idx + 1, total);
            }
        }
        None => {
            let mut index = repo.index().map_err(|e| format!("git index: {e}"))?;
            for (idx, file) in files.iter().enumerate() {
                if should_cancel() {
                    break;
                }
                index
                    .remove_path(std::path::Path::new(file))
                    .map_err(|e| format!("unstage {file}: {e}"))?;
                emit_progress(&mut on_progress, idx + 1, total);
            }
            index.write().map_err(|e| format!("index write: {e}"))?;
        }
    }
    if should_cancel() {
        Err(GIT_OPERATION_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

pub fn unstage_all_with_progress<F, C>(path: &str, on_progress: F, should_cancel: C) -> Result<(), String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let staged_files = collect_unstage_all_files(&repo)?;
    if staged_files.is_empty() {
        return Ok(());
    }
    unstage_with_progress(path, staged_files, on_progress, should_cancel)
}

fn collect_stage_all_files(repo: &Repository) -> Result<Vec<String>, String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("status: {e}"))?;
    let mut files = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_NEW,
        ) {
            if let Some(path) = entry.path() {
                files.push(path.to_string());
            }
        }
    }
    Ok(dedupe_paths(files))
}

fn collect_unstage_all_files(repo: &Repository) -> Result<Vec<String>, String> {
    let statuses = repo.statuses(None).map_err(|e| format!("status: {e}"))?;
    let mut files = Vec::new();
    for entry in statuses.iter() {
        if entry.status().intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        ) {
            if let Some(path) = entry.path() {
                files.push(path.to_string());
            }
        }
    }
    Ok(dedupe_paths(files))
}

fn dedupe_paths(files: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for file in files {
        if !file.is_empty() && seen.insert(file.clone()) {
            out.push(file);
        }
    }
    out
}

fn emit_progress<F>(on_progress: &mut F, completed: usize, total: usize)
where
    F: FnMut(usize, usize),
{
    if total == 0 {
        return;
    }
    if completed == total || total <= 25 || completed == 1 || completed % 10 == 0 {
        on_progress(completed, total);
    }
}

/// Discard all changes for the given files: restore tracked files to HEAD
/// (both index and working tree), and delete untracked files from disk.
pub fn discard_files(path: &str, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let workdir = repo.workdir().ok_or("bare repo")?.to_path_buf();
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let files = dedupe_paths(files);

    let (tracked, untracked): (Vec<&String>, Vec<&String>) = files.iter().partition(|file| {
        head_tree
            .as_ref()
            .map(|t| t.get_path(std::path::Path::new(file)).is_ok())
            .unwrap_or(false)
    });

    // Tracked: restore all in one checkout_head.
    if !tracked.is_empty() {
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force().update_index(true);
        for file in &tracked {
            opts.path(file.as_str());
        }
        repo.checkout_head(Some(&mut opts))
            .map_err(|e| format!("discard tracked files: {e}"))?;
    }

    // Untracked: remove from index once, then delete from disk.
    if !untracked.is_empty() {
        let mut index = repo.index().map_err(|e| format!("git index: {e}"))?;
        for file in &untracked {
            let _ = index.remove_path(std::path::Path::new(file));
        }
        index.write().map_err(|e| format!("index write: {e}"))?;
        for file in &untracked {
            let fp = workdir.join(file);
            if fp.exists() {
                std::fs::remove_file(&fp).map_err(|e| format!("delete {file}: {e}"))?;
            }
        }
    }

    Ok(())
}

/// Commit staged changes
pub fn commit(path: &str, message: &str) -> Result<String, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;

    let sig = repo
        .signature()
        .or_else(|_| {
            let config = repo
                .config()
                .map_err(|e| git2::Error::from_str(&format!("config: {e}")))?;
            let name = config
                .get_string("user.name")
                .map_err(|_| git2::Error::from_str("user.name not set"))?;
            let email = config
                .get_string("user.email")
                .map_err(|_| git2::Error::from_str("user.email not set"))?;
            git2::Signature::now(&name, &email)
        })
        .map_err(|e| {
            format!("No git identity. Set user.name and user.email in git config. ({e})")
        })?;

    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    let tree_oid = index.write_tree().map_err(|e| format!("write tree: {e}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("find tree: {e}"))?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| format!("commit: {e}"))?;

    Ok(oid.to_string())
}

/// Get diff content for a file
pub fn diff(path: &str, file: &str, staged: bool) -> Result<GitDiffResult, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let workdir = repo.workdir().ok_or("bare repo")?;

    if staged {
        // Staged: original = HEAD, modified = index
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let original = head_tree
            .as_ref()
            .and_then(|t| t.get_path(std::path::Path::new(file)).ok())
            .and_then(|e| repo.find_blob(e.id()).ok())
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default();

        let index = repo.index().map_err(|e| format!("index: {e}"))?;
        let modified = index
            .get_path(std::path::Path::new(file), 0)
            .and_then(|e| repo.find_blob(e.id).ok())
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default();

        Ok(GitDiffResult { original, modified })
    } else {
        // Unstaged: original = index (or empty for untracked), modified = working tree
        let index = repo.index().map_err(|e| format!("index: {e}"))?;
        let original = index
            .get_path(std::path::Path::new(file), 0)
            .and_then(|e| repo.find_blob(e.id).ok())
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default();

        let full_path = workdir.join(file);
        let modified = std::fs::read_to_string(&full_path).unwrap_or_default(); // empty for deleted files

        Ok(GitDiffResult { original, modified })
    }
}

/// Get current branch name
pub fn branch_name(path: &str) -> Result<String, String> {
    // No repo (deleted path or non-repo dir) → no branch, not an error.
    if !repo_present(path) {
        return Ok(String::new());
    }
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

/// List local + remote branches
pub fn list_branches(path: &str) -> Result<Vec<crate::types::GitBranch>, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let head = repo.head().ok();
    let head_target = head.as_ref().and_then(|h| h.target());

    let mut branches = Vec::new();

    for branch_result in repo.branches(None).map_err(|e| format!("branches: {e}"))? {
        let (branch, branch_type) = branch_result.map_err(|e| format!("branch iter: {e}"))?;
        let Some(name) = branch.name().ok().flatten() else { continue };

        let is_remote = branch_type == git2::BranchType::Remote;
        if is_remote && name.contains("/HEAD") { continue; }

        let display_name = name.to_string();

        let full_ref = if is_remote {
            format!("refs/remotes/{name}")
        } else {
            format!("refs/heads/{name}")
        };

        let is_head = !is_remote
            && head_target.is_some()
            && branch.get().target() == head_target;

        branches.push(crate::types::GitBranch {
            name: display_name,
            full_ref,
            is_remote,
            is_head,
        });
    }

    branches.sort_by(|a, b| {
        a.is_remote.cmp(&b.is_remote).then(a.name.cmp(&b.name))
    });

    Ok(branches)
}

/// Checkout a branch (local or remote tracking)
pub fn checkout_branch(path: &str, name: &str, is_remote: bool, remote_ref: Option<&str>) -> Result<(), String> {
    let repo_path = repo_key(path);

    let repo = Repository::discover(&repo_path).map_err(|e| format!("git open: {e}"))?;
    let statuses = repo.statuses(None).map_err(|e| format!("statuses: {e}"))?;
    let dirty = statuses.iter().any(|s| {
        !s.status().intersects(git2::Status::IGNORED)
    });
    if dirty {
        return Err("Commit or stash your changes first".to_string());
    }

    let args = if is_remote {
        // name is e.g. "origin/feature" — strip remote prefix for local branch name
        let local_name = name.splitn(2, '/').nth(1).unwrap_or(name);
        let track = remote_ref.map(|r| r.to_string()).unwrap_or_else(|| name.to_string());
        vec!["checkout".to_string(), "-b".to_string(), local_name.to_string(), "--track".to_string(), track]
    } else {
        vec!["checkout".to_string(), name.to_string()]
    };

    let output = git_cmd()
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("checkout failed: {stderr}"))
    }
}

/// Rename a local branch
pub fn rename_branch(path: &str, old_name: &str, new_name: &str) -> Result<(), String> {
    let repo_path = repo_key(path);

    let output = git_cmd()
        .args(["branch", "-m", old_name, new_name])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("rename branch failed: {stderr}"))
    }
}

/// Create a new branch
pub fn create_branch(path: &str, name: &str, from_ref: Option<&str>) -> Result<(), String> {
    let repo_path = repo_key(path);

    let mut args = vec!["checkout", "-b", name];
    if let Some(base) = from_ref {
        args.push(base);
    }

    let output = git_cmd()
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("create branch failed: {stderr}"))
    }
}

fn check_upstream(repo_path: &str) -> Result<(), String> {
    let output = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("No upstream configured for this branch".to_string())
    }
}

pub fn git_pull(path: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    check_upstream(&repo_path)?;
    log::info!("git_pull: {repo_path}");
    let mut cmd = git_cmd();
    cmd.args(["pull"]).current_dir(&repo_path);
    let output = run_git_timed(cmd, 120)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("git_pull failed: {stderr}");
        Err(format!("pull failed: {stderr}"))
    }
}

pub fn git_push(path: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    check_upstream(&repo_path)?;
    log::info!("git_push: {repo_path}");
    let mut cmd = git_cmd();
    cmd.args(["push"]).current_dir(&repo_path);
    let output = run_git_timed(cmd, 120)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("git_push failed: {stderr}");
        Err(format!("push failed: {stderr}"))
    }
}

pub fn git_publish(path: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    let repo = Repository::discover(&repo_path).map_err(|e| format!("git open: {e}"))?;
    let (_, upstream, has_remote, default_remote) = branch_remote_meta(&repo);
    if upstream.is_some() {
        return git_push(path);
    }
    if !has_remote {
        return Err("No remote configured for this repository".to_string());
    }
    let remote = default_remote.ok_or_else(|| "No remote configured for this repository".to_string())?;
    log::info!("git_publish: pushing HEAD to {remote} ({repo_path})");
    let mut cmd = git_cmd();
    cmd.args(["push", "-u", &remote, "HEAD"]).current_dir(&repo_path);
    let output = run_git_timed(cmd, 120)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("git_publish failed: {stderr}");
        Err(format!("publish failed: {stderr}"))
    }
}

pub fn git_fetch(path: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    log::info!("git_fetch: {repo_path}");
    let mut cmd = git_cmd();
    cmd.args(["fetch"]).current_dir(&repo_path);
    let output = run_git_timed(cmd, 120)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("git_fetch failed: {stderr}");
        Err(format!("fetch failed: {stderr}"))
    }
}

/// Get paginated commit log with parent IDs and ref decorations
pub fn commit_log(path: &str, count: usize, skip: usize) -> Result<CommitLogResult, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;

    // Determine current branch + upstream tracking branch
    let mut current_branch: Option<String> = None;
    let mut upstream_shorthand: Option<String> = None;
    let mut upstream_fullname: Option<String> = None;
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            current_branch = Some(name.to_string());
        }
        if let Some(head_name) = head.name() {
            if let Ok(upstream) = repo.branch_upstream_name(head_name) {
                if let Some(uname) = upstream.as_str() {
                    upstream_fullname = Some(uname.to_string());
                    // Derive shorthand (e.g. "refs/remotes/origin/main" -> "origin/main")
                    if let Ok(uref) = repo.find_reference(uname) {
                        if let Some(short) = uref.shorthand() {
                            upstream_shorthand = Some(short.to_string());
                        }
                    }
                }
            }
        }
    }

    // Build OID -> ref names map (only HEAD, current branch, upstream, and tags)
    let mut ref_map: HashMap<git2::Oid, Vec<String>> = HashMap::new();
    for reference in repo.references().map_err(|e| format!("refs: {e}"))?.flatten() {
        if let Some(target) = reference.target() {
            if let Some(name) = reference.shorthand() {
                let fullname = reference.name().unwrap_or("");
                let dominated = fullname.starts_with("refs/tags/")
                    || current_branch.as_deref() == Some(name)
                    || upstream_shorthand.as_deref() == Some(name);
                if dominated {
                    ref_map.entry(target).or_default().push(name.to_string());
                }
            }
        }
    }
    // Add HEAD
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            ref_map.entry(target).or_default().retain(|n| n != "HEAD");
            ref_map.entry(target).or_default().insert(0, "HEAD".to_string());
        }
    }

    let mut revwalk = repo.revwalk().map_err(|e| format!("revwalk: {e}"))?;
    revwalk.push_head().map_err(|e| format!("push head: {e}"))?;
    // Push upstream tracking branch tip so we see remote-ahead commits
    if let Some(ref uname) = upstream_fullname {
        if let Ok(upstream_ref) = repo.find_reference(uname) {
            if let Some(target) = upstream_ref.target() {
                let _ = revwalk.push(target);
            }
        }
    }
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| format!("sort: {e}"))?;

    let mut commits = Vec::new();
    let mut seen = 0usize;
    for oid in revwalk {
        let oid = oid.map_err(|e| format!("revwalk: {e}"))?;
        if seen < skip {
            seen += 1;
            continue;
        }
        if commits.len() >= count + 1 {
            break;
        }
        let commit = repo.find_commit(oid).map_err(|e| format!("find commit: {e}"))?;
        let id_str = oid.to_string();
        let short_id = id_str[..7.min(id_str.len())].to_string();
        let message = commit.summary().unwrap_or("").to_string();
        let author = commit.author();
        let parent_ids: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        let refs = ref_map.get(&oid).cloned().unwrap_or_default();

        commits.push(CommitInfo {
            id: id_str,
            short_id,
            message,
            author: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            timestamp: author.when().seconds(),
            parent_ids,
            refs,
        });
    }

    let has_more = commits.len() > count;
    commits.truncate(count);
    Ok(CommitLogResult { commits, has_more })
}

/// Get files changed in a specific commit (diff against first parent, or empty tree for root)
pub fn commit_files(path: &str, commit_id: &str) -> Result<Vec<CommitFileEntry>, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("parse oid: {e}"))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("find commit: {e}"))?;
    let commit_tree = commit.tree().map_err(|e| format!("commit tree: {e}"))?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0).map_err(|e| format!("parent: {e}"))?.tree().map_err(|e| format!("parent tree: {e}"))?)
    } else {
        None
    };

    let mut diff_opts = git2::DiffOptions::new();
    let diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        Some(&mut diff_opts),
    ).map_err(|e| format!("diff: {e}"))?;

    let mut files: Vec<CommitFileEntry> = Vec::new();
    let current_added = std::cell::Cell::new(0u32);
    let current_deleted = std::cell::Cell::new(0u32);
    let file_idx = std::cell::Cell::new(0usize);

    diff.foreach(
        &mut |delta, _| {
            let idx = file_idx.get();
            if idx > 0 && idx <= files.len() {
                files[idx - 1].added = current_added.get();
                files[idx - 1].deleted = current_deleted.get();
            }
            current_added.set(0);
            current_deleted.set(0);
            file_idx.set(idx + 1);

            let status = match delta.status() {
                git2::Delta::Added => "A",
                git2::Delta::Deleted => "D",
                git2::Delta::Modified => "M",
                git2::Delta::Renamed => "R",
                _ => "M",
            };
            let new_file = delta.new_file();
            let old_file = delta.old_file();
            let file_path = new_file.path()
                .or_else(|| old_file.path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let old_path = if status == "R" {
                old_file.path().map(|p| p.to_string_lossy().to_string())
            } else {
                None
            };
            let is_binary = new_file.is_binary() || old_file.is_binary();

            files.push(CommitFileEntry {
                path: file_path,
                old_path,
                status: status.to_string(),
                added: 0,
                deleted: 0,
                is_binary,
            });
            true
        },
        None,
        None,
        Some(&mut |_delta, _hunk, line| {
            match line.origin() {
                '+' => current_added.set(current_added.get() + 1),
                '-' => current_deleted.set(current_deleted.get() + 1),
                _ => {}
            }
            true
        }),
    ).map_err(|e| format!("foreach: {e}"))?;

    let idx = file_idx.get();
    if idx > 0 && idx <= files.len() {
        files[idx - 1].added = current_added.get();
        files[idx - 1].deleted = current_deleted.get();
    }

    Ok(files)
}

/// Get original/modified content for a single file in a commit (parent vs commit)
pub fn commit_file_diff(path: &str, commit_id: &str, file_path: &str) -> Result<GitDiffResult, String> {
    let repo = Repository::discover(path).map_err(|e| format!("git open: {e}"))?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("parse oid: {e}"))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("find commit: {e}"))?;
    let commit_tree = commit.tree().map_err(|e| format!("commit tree: {e}"))?;

    let modified = match commit_tree.get_path(Path::new(file_path)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id()).map_err(|e| format!("blob: {e}"))?;
            if blob.is_binary() {
                return Ok(GitDiffResult { original: String::new(), modified: "(binary file)".to_string() });
            }
            String::from_utf8_lossy(blob.content()).to_string()
        }
        Err(_) => String::new(),
    };

    let original = if commit.parent_count() > 0 {
        let parent_tree = commit.parent(0).map_err(|e| format!("parent: {e}"))?
            .tree().map_err(|e| format!("parent tree: {e}"))?;
        match parent_tree.get_path(Path::new(file_path)) {
            Ok(entry) => {
                let blob = repo.find_blob(entry.id()).map_err(|e| format!("blob: {e}"))?;
                String::from_utf8_lossy(blob.content()).to_string()
            }
            Err(_) => String::new(),
        }
    } else {
        String::new()
    };

    Ok(GitDiffResult { original, modified })
}

/// Cherry-pick a commit (shells out to git CLI)
pub fn cherry_pick(path: &str, commit_id: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    let output = git_cmd()
        .args(["cherry-pick", commit_id])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("cherry-pick failed: {stderr}"))
    }
}

/// Revert a commit (shells out to git CLI)
pub fn revert_commit(path: &str, commit_id: &str) -> Result<String, String> {
    let repo_path = repo_key(path);
    let output = git_cmd()
        .args(["revert", "--no-edit", commit_id])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("revert failed: {stderr}"))
    }
}
