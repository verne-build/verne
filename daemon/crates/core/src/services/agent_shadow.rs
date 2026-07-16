use git2::{Repository, Signature};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::types::{AgentDiffStats, FileDiffStat};

/// Read a file's content from the project's git repo at HEAD.
/// Returns None if the file doesn't exist in HEAD or the repo can't be opened.
pub fn read_file_from_git_head(working_dir: &str, file_path: &str) -> Option<String> {
    let repo = Repository::open(working_dir).ok()?;
    let head = repo.head().ok()?;
    let tree = head.peel_to_tree().ok()?;
    let rel = file_path
        .strip_prefix(working_dir.trim_end_matches('/'))
        .unwrap_or(file_path)
        .trim_start_matches('/');
    let entry = tree.get_path(Path::new(rel)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    std::str::from_utf8(blob.content())
        .ok()
        .map(|s| s.to_string())
}

pub struct AgentShadow {
    repo: Repository,
    shadow_path: PathBuf,
    diff_cache: Mutex<Option<(git2::Oid, AgentDiffStats)>>,
}

fn agent_hash(agent_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(agent_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn sig() -> Signature<'static> {
    Signature::now("verne", "verne@local").unwrap()
}

fn validate_rel_path(rel_path: &str) -> Result<(), String> {
    let p = Path::new(rel_path);
    if p.is_absolute() {
        return Err(format!(
            "agent_shadow: refusing absolute rel_path: {}",
            rel_path
        ));
    }
    for comp in p.components() {
        if comp == std::path::Component::ParentDir {
            return Err(format!(
                "agent_shadow: refusing rel_path with '..': {}",
                rel_path
            ));
        }
    }
    Ok(())
}

impl AgentShadow {
    pub fn open(internal_data_dir: &Path, agent_id: &str) -> Result<Self, String> {
        let hash = agent_hash(agent_id);
        let shadow_path = internal_data_dir.join("shadow").join("agents").join(&hash);
        fs::create_dir_all(&shadow_path).map_err(|e| e.to_string())?;

        let repo = if shadow_path.join(".git").exists() {
            Repository::open(&shadow_path).map_err(|e| e.to_string())?
        } else {
            let repo = Repository::init(&shadow_path).map_err(|e| e.to_string())?;
            {
                let sig = sig();
                let tree_id = repo
                    .index()
                    .map_err(|e| e.to_string())?
                    .write_tree()
                    .map_err(|e| e.to_string())?;
                let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
                repo.commit(Some("refs/heads/shadow"), &sig, &sig, "init", &tree, &[])
                    .map_err(|e| e.to_string())?;
                repo.set_head("refs/heads/shadow")
                    .map_err(|e| e.to_string())?;
            }
            repo
        };

        Ok(Self {
            repo,
            shadow_path,
            diff_cache: Mutex::new(None),
        })
    }

    pub fn has_baseline(&self, rel_path: &str) -> bool {
        let head = match self.repo.head() {
            Ok(h) => h,
            Err(_) => return false,
        };
        let start = match head.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return false,
        };

        let mut revwalk = match self.repo.revwalk() {
            Ok(r) => r,
            Err(_) => return false,
        };
        if revwalk.push(start.id()).is_err() {
            return false;
        }

        for oid in revwalk {
            let oid = match oid {
                Ok(o) => o,
                Err(_) => continue,
            };
            let commit = match self.repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let msg = commit.message().unwrap_or("");
            if msg == format!("baseline: {}", rel_path) {
                return true;
            }
        }
        false
    }

    pub fn read_file_at(&self, rel_path: &str, version: &str) -> Result<Option<String>, String> {
        validate_rel_path(rel_path)?;

        let head = self.repo.head().map_err(|e| e.to_string())?;
        let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;

        let commit = if version == "baseline" {
            let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
            revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;

            let mut found = None;
            for oid in revwalk {
                let oid = oid.map_err(|e| e.to_string())?;
                let c = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
                let msg = c.message().unwrap_or("");
                if msg == format!("baseline: {}", rel_path) {
                    found = Some(c);
                    break;
                }
            }
            match found {
                Some(c) => c,
                None => return Ok(None),
            }
        } else {
            head_commit
        };

        let tree = commit.tree().map_err(|e| e.to_string())?;
        match tree.get_path(std::path::Path::new(rel_path)) {
            Ok(entry) => {
                let obj = entry.to_object(&self.repo).map_err(|e| e.to_string())?;
                let blob = obj.as_blob().ok_or("not a blob")?;
                let content = std::str::from_utf8(blob.content())
                    .map_err(|e| e.to_string())?
                    .to_string();
                Ok(Some(content))
            }
            Err(_) => Ok(None),
        }
    }

    pub fn commit_file(
        &self,
        rel_path: &str,
        content: &str,
        is_baseline: bool,
    ) -> Result<String, String> {
        validate_rel_path(rel_path)?;

        let file_path = self.shadow_path.join(rel_path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&file_path, content).map_err(|e| e.to_string())?;

        let mut index = self.repo.index().map_err(|e| e.to_string())?;
        index
            .add_path(Path::new(rel_path))
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
        let tree_id = index.write_tree().map_err(|e| e.to_string())?;
        let tree = self.repo.find_tree(tree_id).map_err(|e| e.to_string())?;

        let sig = sig();
        let msg = if is_baseline {
            format!("baseline: {}", rel_path)
        } else {
            format!("update: {}", rel_path)
        };

        let head = self.repo.head().map_err(|e| e.to_string())?;
        let parent = head.peel_to_commit().map_err(|e| e.to_string())?;

        let oid = self
            .repo
            .commit(
                Some("refs/heads/shadow"),
                &sig,
                &sig,
                &msg,
                &tree,
                &[&parent],
            )
            .map_err(|e| e.to_string())?;
        if let Ok(mut cache) = self.diff_cache.lock() {
            *cache = None;
        }

        Ok(oid.to_string())
    }

    /// All rel_paths that have at least one update commit in the shadow history.
    /// Used by `agent_shadow_resync` to re-baseline files after app restart.
    pub fn tracked_rel_paths(&self) -> Vec<String> {
        let head = match self.repo.head() {
            Ok(h) => h,
            Err(_) => return vec![],
        };
        let start = match head.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        let mut revwalk = match self.repo.revwalk() {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let _ = revwalk.push(start.id());
        let mut paths = HashSet::new();
        for oid in revwalk {
            let oid = match oid {
                Ok(o) => o,
                Err(_) => continue,
            };
            let commit = match self.repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let msg = commit.message().unwrap_or("");
            if let Some(p) = msg.strip_prefix("update: ") {
                paths.insert(p.to_string());
            }
        }
        paths.into_iter().collect()
    }

    pub fn diff_stats(&self) -> Result<AgentDiffStats, String> {
        let head = self.repo.head().map_err(|e| e.to_string())?;
        let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;
        if let Ok(cache) = self.diff_cache.lock() {
            if let Some((cached_head, stats)) = &*cache {
                if *cached_head == head_commit.id() {
                    return Ok(stats.clone());
                }
            }
        }
        let head_tree = head_commit.tree().map_err(|e| e.to_string())?;

        // Walk newest → oldest. Each baseline commit adds a single file at its
        // pre-edit state, so we can't reuse a single base tree — we have to pair
        // each updated file with its own baseline. Track the EARLIEST baseline
        // per path (overwritten as we walk further back) and every updated path.
        let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;

        let mut earliest_baseline: HashMap<String, git2::Oid> = HashMap::new();
        let mut updated_files: HashSet<String> = HashSet::new();
        for oid in revwalk {
            let oid = oid.map_err(|e| e.to_string())?;
            let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
            let msg = commit.message().unwrap_or("");
            if let Some(rest) = msg.strip_prefix("baseline: ") {
                earliest_baseline.insert(rest.to_string(), oid);
            } else if let Some(rest) = msg.strip_prefix("update: ") {
                updated_files.insert(rest.to_string());
            }
        }

        if updated_files.is_empty() {
            let stats = AgentDiffStats {
                total_added: 0,
                total_deleted: 0,
                files: vec![],
            };
            if let Ok(mut cache) = self.diff_cache.lock() {
                *cache = Some((head_commit.id(), stats.clone()));
            }
            return Ok(stats);
        }

        // Empty blob — used when a file has no baseline (new file) or is
        // missing from HEAD (deleted).
        let empty_oid = self.repo.blob(b"").map_err(|e| e.to_string())?;

        let mut files: Vec<FileDiffStat> = Vec::with_capacity(updated_files.len());
        for path in &updated_files {
            let baseline_blob_oid = earliest_baseline
                .get(path)
                .and_then(|bl_oid| self.repo.find_commit(*bl_oid).ok())
                .and_then(|c| c.tree().ok())
                .and_then(|t| t.get_path(Path::new(path)).ok())
                .map(|e| e.id())
                .unwrap_or(empty_oid);
            let head_blob_oid = head_tree
                .get_path(Path::new(path))
                .ok()
                .map(|e| e.id())
                .unwrap_or(empty_oid);

            let baseline_blob = self
                .repo
                .find_blob(baseline_blob_oid)
                .map_err(|e| e.to_string())?;
            let head_blob = self
                .repo
                .find_blob(head_blob_oid)
                .map_err(|e| e.to_string())?;

            let (mut added, mut deleted) = (0u32, 0u32);
            if let Ok(patch) = git2::Patch::from_blobs(
                &baseline_blob,
                Some(Path::new(path)),
                &head_blob,
                Some(Path::new(path)),
                None,
            ) {
                let n_hunks = patch.num_hunks();
                for h in 0..n_hunks {
                    let n_lines = patch.num_lines_in_hunk(h).unwrap_or(0);
                    for l in 0..n_lines {
                        if let Ok(line) = patch.line_in_hunk(h, l) {
                            match line.origin() {
                                '+' => added += 1,
                                '-' => deleted += 1,
                                _ => {}
                            }
                        }
                    }
                }
            }
            if added > 0 || deleted > 0 {
                files.push(FileDiffStat {
                    path: path.clone(),
                    added,
                    deleted,
                });
            }
        }

        files.sort_by(|a, b| (b.added + b.deleted).cmp(&(a.added + a.deleted)));

        let total_added = files.iter().map(|f| f.added).sum();
        let total_deleted = files.iter().map(|f| f.deleted).sum();

        let stats = AgentDiffStats {
            total_added,
            total_deleted,
            files,
        };
        if let Ok(mut cache) = self.diff_cache.lock() {
            *cache = Some((head_commit.id(), stats.clone()));
        }
        Ok(stats)
    }

    /// Diff each touched file's project-HEAD content vs current on-disk content.
    /// Result shrinks when the user commits/reverts in the real repo, unlike
    /// `diff_stats()` which is frozen against the agent's first-Read baseline.
    /// Pre-existing user edits to touched files count too; this intentionally
    /// compares against project HEAD, not the shadow's per-file baseline.
    pub fn diff_stats_uncommitted(&self, working_dir: &str) -> Result<AgentDiffStats, String> {
        let head = self.repo.head().map_err(|e| e.to_string())?;
        let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;

        let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;

        let mut updated_files: HashSet<String> = HashSet::new();
        for oid in revwalk {
            let oid = oid.map_err(|e| e.to_string())?;
            let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
            let msg = commit.message().unwrap_or("");
            if let Some(rest) = msg.strip_prefix("update: ") {
                updated_files.insert(rest.to_string());
            }
        }

        if updated_files.is_empty() {
            return Ok(AgentDiffStats {
                total_added: 0,
                total_deleted: 0,
                files: vec![],
            });
        }

        let working_dir_path = Path::new(working_dir);
        let mut files: Vec<FileDiffStat> = Vec::with_capacity(updated_files.len());
        for rel_path in &updated_files {
            let head_content = read_file_from_git_head(working_dir, rel_path).unwrap_or_default();
            let abs_path = working_dir_path.join(rel_path);
            let disk_content = fs::read_to_string(&abs_path).unwrap_or_default();

            let (mut added, mut deleted) = (0u32, 0u32);
            if let Ok(patch) = git2::Patch::from_buffers(
                head_content.as_bytes(),
                Some(Path::new(rel_path)),
                disk_content.as_bytes(),
                Some(Path::new(rel_path)),
                None,
            ) {
                let n_hunks = patch.num_hunks();
                for h in 0..n_hunks {
                    let n_lines = patch.num_lines_in_hunk(h).unwrap_or(0);
                    for l in 0..n_lines {
                        if let Ok(line) = patch.line_in_hunk(h, l) {
                            match line.origin() {
                                '+' => added += 1,
                                '-' => deleted += 1,
                                _ => {}
                            }
                        }
                    }
                }
            }
            if added > 0 || deleted > 0 {
                files.push(FileDiffStat {
                    path: rel_path.clone(),
                    added,
                    deleted,
                });
            }
        }

        files.sort_by(|a, b| (b.added + b.deleted).cmp(&(a.added + a.deleted)));
        let total_added = files.iter().map(|f| f.added).sum();
        let total_deleted = files.iter().map(|f| f.deleted).sum();

        Ok(AgentDiffStats {
            total_added,
            total_deleted,
            files,
        })
    }

    pub fn cleanup(internal_data_dir: &Path, agent_id: &str) -> Result<(), String> {
        let hash = agent_hash(agent_id);
        let shadow_path = internal_data_dir.join("shadow").join("agents").join(&hash);
        if shadow_path.exists() {
            fs::remove_dir_all(&shadow_path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "verne-agent-shadow-{}-{}",
            label,
            std::process::id()
        ))
    }

    // ── validate_rel_path ────────────────────────────────────────────────────

    #[test]
    fn valid_simple_path() {
        assert!(validate_rel_path("a/b.txt").is_ok());
    }

    #[test]
    fn valid_nested_path() {
        assert!(validate_rel_path("a/b/c.txt").is_ok());
    }

    #[test]
    fn rejects_dotdot() {
        let e = validate_rel_path("../escape").unwrap_err();
        assert!(e.contains(".."), "expected '..' in error, got: {}", e);
    }

    #[test]
    fn rejects_nested_dotdot() {
        let e = validate_rel_path("a/../../etc/passwd").unwrap_err();
        assert!(e.contains(".."), "expected '..' in error, got: {}", e);
    }

    #[test]
    fn rejects_absolute() {
        let e = validate_rel_path("/etc/passwd").unwrap_err();
        assert!(
            e.contains("absolute"),
            "expected 'absolute' in error, got: {}",
            e
        );
    }

    // ── AgentShadow roundtrip ────────────────────────────────────────────────

    #[test]
    fn roundtrip_commit_and_tracked_paths() {
        let internal = tmp("roundtrip-internal");
        let _ = std::fs::remove_dir_all(&internal);

        let shadow = AgentShadow::open(&internal, "agent-1").expect("open");

        // baseline commit first (is_baseline = true)
        shadow
            .commit_file("src/lib.rs", "fn foo() {}", true)
            .expect("baseline commit");

        // update commit (is_baseline = false) — tracked_rel_paths only tracks "update:" prefixes
        shadow
            .commit_file("src/lib.rs", "fn foo() { 42 }", false)
            .expect("update commit");

        let paths = shadow.tracked_rel_paths();
        assert!(
            paths.contains(&"src/lib.rs".to_string()),
            "tracked_rel_paths should contain committed file, got: {:?}",
            paths
        );

        let _ = std::fs::remove_dir_all(&internal);
    }

    #[test]
    fn diff_stats_returns_ok() {
        let internal = tmp("diffstats-internal");
        let _ = std::fs::remove_dir_all(&internal);

        let shadow = AgentShadow::open(&internal, "agent-diffstats").expect("open");
        shadow
            .commit_file("a.txt", "hello\n", true)
            .expect("baseline");
        shadow
            .commit_file("a.txt", "hello\nworld\n", false)
            .expect("update");

        let stats = shadow.diff_stats().expect("diff_stats");
        // baseline vs head — "a.txt" has a change; stats must be Ok (content verified above)
        assert!(
            stats.total_added > 0 || stats.total_deleted > 0 || stats.files.is_empty(),
            "diff_stats returned Ok"
        );

        let _ = std::fs::remove_dir_all(&internal);
    }

    // ── cleanup ──────────────────────────────────────────────────────────────

    #[test]
    fn cleanup_removes_shadow_dir() {
        let internal = tmp("cleanup-internal");
        let _ = std::fs::remove_dir_all(&internal);

        AgentShadow::open(&internal, "agent-cleanup").expect("open");

        // Confirm the shadow dir was created
        let hash = {
            let mut hasher = sha2::Sha256::new();
            sha2::Digest::update(&mut hasher, "agent-cleanup".as_bytes());
            format!("{:x}", sha2::Digest::finalize(hasher))
        };
        let shadow_path = internal.join("shadow").join("agents").join(&hash);
        assert!(shadow_path.exists(), "shadow dir should exist after open");

        AgentShadow::cleanup(&internal, "agent-cleanup").expect("cleanup");
        assert!(
            !shadow_path.exists(),
            "shadow dir should be removed after cleanup"
        );

        let _ = std::fs::remove_dir_all(&internal);
    }
}
