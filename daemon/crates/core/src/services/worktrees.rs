use std::path::{Path, PathBuf};

/// Fields the worktree workspace ops need from the sidecar's `AppState`
/// (settings for the worktrees-root override, the internal data dir, and
/// subtree-resource eviction). A trait so the git logic stays decoupled.
pub trait WorktreeHost {
    fn settings(&self) -> &crate::settings::SettingsManager;
    fn internal_data_dir(&self) -> &Path;
    fn evict_directory_resources(&self, id: &str, all_dirs: &[crate::types::WorkingDirectory]);
}

impl WorktreeHost for crate::state::AppState {
    fn settings(&self) -> &crate::settings::SettingsManager { &self.settings }
    fn internal_data_dir(&self) -> &Path { &self.internal_data_dir }
    fn evict_directory_resources(&self, id: &str, all_dirs: &[crate::types::WorkingDirectory]) {
        crate::state::AppState::evict_directory_resources(self, id, all_dirs)
    }
}

// `&self.settings` (an `&Arc<SettingsManager>`) coerces to `&SettingsManager`
// via deref in the impls above; `internal_data_dir` (`PathBuf`) to `&Path`.

pub const WORKTREE_NAME_POOL: &[&str] = &[
    "magellan", "columbus", "drake", "cook", "shackleton", "amundsen", "scott",
    "hillary", "cousteau", "darwin", "livingstone", "polo", "hudson", "vespucci",
    "peary", "balboa", "raleigh", "cabot", "ericson", "frobisher",
    "beagle", "endurance", "endeavour", "discovery", "resolution", "terranova",
    "fram", "victoria", "mayflower", "bounty", "challenger", "calypso", "santamaria",
    "apollo", "voyager", "pioneer", "sputnik", "cassini", "hubble", "juno",
    "perseverance", "curiosity", "atlantis", "enterprise", "mariner", "viking", "rosetta",
    "newton", "tesla", "edison", "faraday", "curie", "pasteur", "galileo", "kepler",
    "copernicus", "halley", "herschel", "einstein",
    "compass", "sextant", "astrolabe", "atlas", "telescope", "horizon", "beacon",
    "polaris", "orion", "andromeda", "sirius",
    "nemo", "nautilus", "fogg", "aronnax", "robur",
    "marty", "doc", "delorean", "flux", "capacitor",
];

#[derive(Debug, Clone)]
pub enum BaseRef {
    Ref(String),
    HeadFallback,
}

#[derive(Debug, Clone)]
pub struct WorktreeCreated {
    pub path: PathBuf,
    pub name: String,
    pub branch: String,
    pub used_head_fallback: bool,
}

/// Resolved git fields returned to Electron after a worktree create. Electron
/// builds the `directories` row (uuid, sort_order, parent) from these.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeGitResult {
    pub path: String,
    pub branch: String,
    pub repo_root: String,
}

/// Resolve worktrees root: app setting override → `<internal_data>/worktrees`.
pub fn resolve_root(internal_data_dir: &Path, override_path: Option<&str>) -> PathBuf {
    match override_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(shellexpand_tilde(p)),
        _ => internal_data_dir.join("worktrees"),
    }
}

fn shellexpand_tilde(input: &str) -> String {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    input.to_string()
}

use std::collections::HashSet;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

/// Pick an unused pool name given a set of already-taken names. Falls back to
/// `<base>-<n>` if all pool entries are taken. Time-rotated start index so
/// repeated calls don't always return the same first-free entry.
pub fn pick_pool_name(taken: &HashSet<String>) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let len = WORKTREE_NAME_POOL.len();
    let start = (nanos as usize) % len;

    for offset in 0..len {
        let candidate = WORKTREE_NAME_POOL[(start + offset) % len];
        if !taken.contains(candidate) {
            return candidate.to_string();
        }
    }

    let base = WORKTREE_NAME_POOL[start];
    for n in 2..1_000_000 {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    // Astronomically unreachable; fall back to nanos suffix.
    format!("{base}-{nanos}")
}

/// Pick an unused worktree name. Scans `<root>/<dir_id>/` for folder
/// collisions plus the git worktree registry.
pub fn pick_name(root: &Path, dir_id: &str, repo: &git2::Repository) -> Result<String, String> {
    let dir_root = root.join(dir_id);
    if !dir_root.exists() {
        fs::create_dir_all(&dir_root).map_err(|e| format!("create worktrees dir: {e}"))?;
    }

    let mut taken: HashSet<String> = HashSet::new();
    if let Ok(rd) = fs::read_dir(&dir_root) {
        for entry in rd.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                taken.insert(name.to_string());
            }
        }
    }
    if let Ok(names) = repo.worktrees() {
        for i in 0..names.len() {
            if let Some(n) = names.get(i) {
                taken.insert(n.to_string());
            }
        }
    }

    Ok(pick_pool_name(&taken))
}

/// Slugify an arbitrary string into a git-branch-safe form: lowercase
/// `[a-z0-9-]` only, hyphen-collapsed, no leading/trailing hyphens, max 40 chars.
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_dash = true;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') { out.pop(); }
    if out.len() > 40 {
        out.truncate(40);
        while out.ends_with('-') { out.pop(); }
    }
    out
}

/// Pick an unused branch/worktree name based on a slug. Returns `slug` if free,
/// otherwise `slug-2`, `slug-3`, … Caller passes the same conflict set used by
/// `pick_name`.
pub fn pick_branch_name_from_slug(slug: &str, taken: &HashSet<String>) -> String {
    if !slug.is_empty() && !taken.contains(slug) {
        return slug.to_string();
    }
    let base = if slug.is_empty() { "branch" } else { slug };
    for n in 2..1_000_000 {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{base}-{nanos}")
}

/// Build the conflict set used for both `pick_name` and `pick_branch_name_from_slug`.
pub fn taken_worktree_names(root: &Path, dir_id: &str, repo: &git2::Repository) -> HashSet<String> {
    let dir_root = root.join(dir_id);
    let mut taken: HashSet<String> = HashSet::new();
    if let Ok(rd) = fs::read_dir(&dir_root) {
        for entry in rd.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                taken.insert(name.to_string());
            }
        }
    }
    if let Ok(names) = repo.worktrees() {
        for i in 0..names.len() {
            if let Some(n) = names.get(i) {
                taken.insert(n.to_string());
            }
        }
    }
    taken
}

use crate::types::DirectorySettings;

/// Resolve the base ref to branch a new worktree from.
/// Precedence: per-directory override → origin/main → origin/master → HEAD fallback.
pub fn resolve_base_ref(
    repo: &git2::Repository,
    dir_settings: &DirectorySettings,
) -> BaseRef {
    let candidates: Vec<String> = std::iter::once(dir_settings.default_base_ref.clone())
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .chain(["origin/main".to_string(), "origin/master".to_string()])
        .collect();

    for candidate in &candidates {
        if revparse_exists(repo, candidate) {
            return BaseRef::Ref(candidate.clone());
        }
    }
    BaseRef::HeadFallback
}

fn revparse_exists(repo: &git2::Repository, refname: &str) -> bool {
    repo.revparse_single(refname).is_ok()
}

/// Create a new worktree at `<root>/<dir_id>/<name>` on a new branch named the
/// same as the worktree, branched from the resolved base ref.
pub fn create(
    repo: &git2::Repository,
    root: &Path,
    dir_id: &str,
    name: &str,
    base: &BaseRef,
) -> Result<WorktreeCreated, String> {
    let dir_root = root.join(dir_id);
    fs::create_dir_all(&dir_root).map_err(|e| format!("create worktrees dir: {e}"))?;
    let path = dir_root.join(name);

    if path.exists() {
        return Err(format!("worktree path already exists: {}", path.display()));
    }

    if let Some(workdir) = repo.workdir() {
        let canon_path = path.parent().map(|p| p.to_path_buf()).unwrap_or(path.clone());
        if canon_path.starts_with(workdir) {
            return Err(
                "Worktrees root cannot live inside the repository — pick another location"
                    .to_string(),
            );
        }
    }

    let (commit, used_fallback) = match base {
        BaseRef::Ref(r) => {
            let obj = repo
                .revparse_single(r)
                .map_err(|e| format!("revparse {r}: {e}"))?;
            let c = obj
                .peel_to_commit()
                .map_err(|e| format!("peel {r}: {e}"))?;
            (c, false)
        }
        BaseRef::HeadFallback => {
            let head = repo.head().map_err(|e| format!("head: {e}"))?;
            let c = head
                .peel_to_commit()
                .map_err(|e| format!("peel HEAD: {e}"))?;
            (c, true)
        }
    };

    let branch = repo
        .branch(name, &commit, false)
        .map_err(|e| format!("create branch {name}: {e}"))?;
    let branch_ref = branch.into_reference();

    let mut opts = git2::WorktreeAddOptions::new();
    opts.reference(Some(&branch_ref));
    let result = repo.worktree(name, &path, Some(&opts));

    if let Err(e) = result {
        if let Ok(mut b) = repo.find_branch(name, git2::BranchType::Local) {
            let _ = b.delete();
        }
        return Err(format!("worktree add: {e}"));
    }

    Ok(WorktreeCreated {
        path,
        name: name.to_string(),
        branch: name.to_string(),
        used_head_fallback: used_fallback,
    })
}

/// Create a worktree from a workspace via git2 and return the resolved fields.
/// DB-free: caller (Electron) supplies parent path/settings and owns the
/// `directories` row + event.
pub fn create_workspace_worktree_git(
    state: &impl WorktreeHost,
    parent_path: &str,
    default_base_ref: Option<&str>,
    parent_dir_id: &str,
    branch_input: &str,
) -> Result<WorktreeGitResult, String> {
    let dir_settings = DirectorySettings {
        default_base_ref: default_base_ref.map(str::to_string),
    };

    let repo = git2::Repository::discover(parent_path)
        .map_err(|e| format!("not a git repo: {e}"))?;
    let repo_root = repo
        .workdir()
        .map(|p| p.to_string_lossy().trim_end_matches('/').to_string())
        .ok_or_else(|| "bare repo".to_string())?;

    let worktrees_root_override = state.settings().get().worktrees_root;
    let root = resolve_root(state.internal_data_dir(), worktrees_root_override.as_deref());
    fs::create_dir_all(root.join(parent_dir_id))
        .map_err(|e| format!("create worktrees dir: {e}"))?;

    let base = resolve_base_ref(&repo, &dir_settings);
    let taken = taken_worktree_names(&root, parent_dir_id, &repo);
    let name = if branch_input.trim().is_empty() {
        pick_pool_name(&taken)
    } else {
        pick_branch_name_from_slug(&slugify(branch_input), &taken)
    };
    let created = create(&repo, &root, parent_dir_id, &name, &base)?;

    Ok(WorktreeGitResult {
        path: created.path.to_string_lossy().into_owned(),
        branch: created.branch,
        repo_root,
    })
}

/// Remove a worktree workspace via git2 (prune + on-disk rm + branch delete).
/// DB-free: caller supplies parent + worktree paths and owns the row delete +
/// resource eviction + event.
pub fn remove_workspace_worktree_git(
    parent_path: &str,
    dir_path: &str,
    force: bool,
) -> Result<(), String> {
    let repo = git2::Repository::discover(parent_path)
        .map_err(|e| format!("parent not a git repo: {e}"))?;
    // The worktree name == leaf dir name (Phase 7 derives both from the same slug).
    let name = Path::new(dir_path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "worktree path has no leaf".to_string())?;

    // Capture the worktree's current branch before tearing it down — the
    // branch may have been renamed since creation, so it won't always match
    // the worktree leaf name.
    let branch_name: Option<String> = repo.find_worktree(&name).ok().and_then(|wt| {
        let wt_repo = git2::Repository::open_from_worktree(&wt).ok()?;
        let head = wt_repo.head().ok()?;
        head.shorthand().map(|s| s.to_string())
    });

    // Remove on-disk working tree first so libgit2 stops considering the
    // worktree "valid" — then prune cleans the .git/worktrees/<name> metadata.
    if Path::new(dir_path).exists() {
        let _ = fs::remove_dir_all(dir_path);
    }
    if let Ok(wt) = repo.find_worktree(&name) {
        let mut prune_opts = git2::WorktreePruneOptions::new();
        prune_opts.valid(true).locked(force).working_tree(true);
        wt.prune(Some(&mut prune_opts))
            .map_err(|e| format!("prune worktree: {e}"))?;
    }
    if let Some(bn) = branch_name {
        if let Ok(mut b) = repo.find_branch(&bn, git2::BranchType::Local) {
            let _ = b.delete();
        }
    }
    Ok(())
}

/// Rename a worktree workspace's git branch via git2 and return the resolved
/// new branch slug. The worktree's on-disk path / git-worktree name stay put —
/// only the branch ref moves. DB-free: caller owns the row rename + event.
pub fn rename_workspace_worktree_branch_git(
    parent_path: &str,
    dir_path: &str,
    new_branch_input: &str,
) -> Result<String, String> {
    let repo = git2::Repository::discover(parent_path)
        .map_err(|e| format!("parent not a git repo: {e}"))?;

    let leaf = Path::new(dir_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "worktree path has no leaf".to_string())?
        .to_string();
    let wt = repo.find_worktree(&leaf)
        .map_err(|e| format!("find worktree: {e}"))?;
    let wt_repo = git2::Repository::open_from_worktree(&wt)
        .map_err(|e| format!("open worktree: {e}"))?;
    let head = wt_repo.head().map_err(|e| format!("head: {e}"))?;
    let current_branch = head.shorthand()
        .ok_or_else(|| "worktree HEAD not on a branch".to_string())?
        .to_string();

    let new_branch = slugify(new_branch_input);
    if new_branch.is_empty() {
        return Err("invalid branch name".to_string());
    }
    if new_branch == current_branch {
        return Ok(current_branch);
    }
    if repo.find_branch(&new_branch, git2::BranchType::Local).is_ok() {
        return Err(format!("branch '{}' already exists", new_branch));
    }

    let mut br = repo.find_branch(&current_branch, git2::BranchType::Local)
        .map_err(|e| format!("find branch '{current_branch}': {e}"))?;
    br.rename(&new_branch, false)
        .map_err(|e| format!("rename branch: {e}"))?;

    Ok(new_branch)
}

/// Prune a worktree by name from the parent repo, then `rm -rf` any leftover
/// directory. Called on agent delete.
pub fn prune(repo: &git2::Repository, name: &str, path: &Path) -> Result<(), String> {
    if let Ok(wt) = repo.find_worktree(name) {
        let mut prune_opts = git2::WorktreePruneOptions::new();
        prune_opts.locked(true).working_tree(true);
        let _ = wt.prune(Some(&mut prune_opts));
    }
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}
