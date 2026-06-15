use std::fs;
use std::path::{Path, PathBuf};

use git2::{DiffOptions, ObjectType, Repository, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize, Clone)]
pub struct ShadowCommit {
    pub oid: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub content: String,
}

const BASELINE_TAG: &str = "baseline:";

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReadResult {
    pub content: String,
    pub baseline_hash: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn extract_baseline(message: &str) -> String {
    for token in message.split_whitespace().rev() {
        if let Some(hex) = token.strip_prefix(BASELINE_TAG) {
            return hex.to_string();
        }
    }
    String::new()
}

pub struct ShadowTree {
    repo: Repository,
    dir_path: PathBuf,
    shadow_path: PathBuf,
}

fn dir_hash(dir_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(dir_path.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn sig() -> Signature<'static> {
    Signature::now("verne", "verne@local").unwrap()
}

fn validate_rel_path(rel_path: &str) -> Result<(), String> {
    let p = Path::new(rel_path);
    if p.is_absolute() {
        return Err(format!(
            "shadow_tree: refusing absolute rel_path: {}",
            rel_path
        ));
    }
    // Block path traversal
    for comp in p.components() {
        if comp == std::path::Component::ParentDir {
            return Err(format!(
                "shadow_tree: refusing rel_path with '..': {}",
                rel_path
            ));
        }
    }
    Ok(())
}

impl ShadowTree {
    pub fn open(internal_data_dir: &Path, dir_path: &Path) -> Result<Self, String> {
        let hash = dir_hash(dir_path);
        let shadow_path = internal_data_dir.join("shadow").join(&hash);
        fs::create_dir_all(&shadow_path).map_err(|e| e.to_string())?;

        let repo = if shadow_path.join(".git").exists() {
            Repository::open(&shadow_path).map_err(|e| e.to_string())?
        } else {
            let repo = Repository::init(&shadow_path).map_err(|e| e.to_string())?;
            // Create initial empty commit on "shadow" branch
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
            dir_path: dir_path.to_path_buf(),
            shadow_path,
        })
    }

    pub fn commit_file(&self, rel_path: &str, content: &str) -> Result<String, String> {
        validate_rel_path(rel_path)?;
        // Write file to shadow working tree
        let file_path = self.shadow_path.join(rel_path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&file_path, content).map_err(|e| e.to_string())?;

        // Stage + commit
        let mut index = self.repo.index().map_err(|e| e.to_string())?;
        index
            .add_path(Path::new(rel_path))
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
        let tree_id = index.write_tree().map_err(|e| e.to_string())?;
        let tree = self.repo.find_tree(tree_id).map_err(|e| e.to_string())?;

        // Compute baseline = sha256 of current disk content (or empty if disk read fails).
        let baseline_hex = match fs::read(self.dir_path.join(rel_path)) {
            Ok(bytes) => sha256_hex(&bytes),
            Err(_) => String::new(),
        };

        let sig = sig();
        let ts = chrono::Utc::now().timestamp();
        let msg = format!("shadow: {} {} {}{}", rel_path, ts, BASELINE_TAG, baseline_hex);

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

        Ok(oid.to_string())
    }

    pub fn read_file(&self, rel_path: &str) -> Option<String> {
        if validate_rel_path(rel_path).is_err() {
            return None;
        }
        let file_path = self.shadow_path.join(rel_path);
        fs::read_to_string(file_path).ok()
    }

    pub fn read_file_with_baseline(&self, rel_path: &str) -> Result<Option<ShadowReadResult>, String> {
        validate_rel_path(rel_path)?;
        let content = match self.read_file(rel_path) {
            Some(c) => c,
            None => return Ok(None),
        };

        let head = match self.repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(Some(ShadowReadResult { content, baseline_hash: String::new() })),
        };
        let start = head.peel_to_commit().map_err(|e| e.to_string())?;

        let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(start.id()).map_err(|e| e.to_string())?;

        let needle = format!("shadow: {} ", rel_path);
        for oid in revwalk {
            let oid = oid.map_err(|e| e.to_string())?;
            let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
            let msg = commit.message().unwrap_or("");
            if msg.contains(&needle) {
                return Ok(Some(ShadowReadResult {
                    content,
                    baseline_hash: extract_baseline(msg),
                }));
            }
        }

        Ok(Some(ShadowReadResult { content, baseline_hash: String::new() }))
    }

    pub fn diff_file(&self, rel_path: &str, disk_content: &str) -> Result<Vec<DiffHunk>, String> {
        validate_rel_path(rel_path)?;
        let shadow_content = self.read_file(rel_path).unwrap_or_default();
        if shadow_content.is_empty() && disk_content.is_empty() {
            return Ok(vec![]);
        }

        // Write both contents as blobs to odb, then diff_blobs
        let odb = self.repo.odb().map_err(|e| e.to_string())?;
        let old_oid = odb
            .write(ObjectType::Blob, shadow_content.as_bytes())
            .map_err(|e| e.to_string())?;
        let new_oid = odb
            .write(ObjectType::Blob, disk_content.as_bytes())
            .map_err(|e| e.to_string())?;
        let old_blob = self.repo.find_blob(old_oid).map_err(|e| e.to_string())?;
        let new_blob = self.repo.find_blob(new_oid).map_err(|e| e.to_string())?;

        let mut hunks = Vec::new();
        let mut opts = DiffOptions::new();

        self.repo
            .diff_blobs(
                Some(&old_blob),
                None,
                Some(&new_blob),
                None,
                Some(&mut opts),
                None,
                None,
                Some(&mut |_delta, hunk| {
                    hunks.push(DiffHunk {
                        old_start: hunk.old_start(),
                        old_lines: hunk.old_lines(),
                        new_start: hunk.new_start(),
                        new_lines: hunk.new_lines(),
                        content: String::new(),
                    });
                    true
                }),
                None,
            )
            .map_err(|e| e.to_string())?;

        Ok(hunks)
    }

    pub fn file_history(&self, rel_path: &str) -> Result<Vec<ShadowCommit>, String> {
        validate_rel_path(rel_path)?;
        let mut results = Vec::new();
        let head = match self.repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(results),
        };
        let start = head.peel_to_commit().map_err(|e| e.to_string())?;

        let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(start.id()).map_err(|e| e.to_string())?;

        for oid in revwalk {
            let oid = oid.map_err(|e| e.to_string())?;
            let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
            let msg = commit.message().unwrap_or("").to_string();

            // Filter: only commits touching this file
            if msg.contains(&format!("shadow: {}", rel_path)) {
                results.push(ShadowCommit {
                    oid: oid.to_string(),
                    message: msg,
                    timestamp: commit.time().seconds(),
                });
            }
        }
        Ok(results)
    }

    pub fn read_at_commit(&self, rel_path: &str, oid_str: &str) -> Result<String, String> {
        validate_rel_path(rel_path)?;
        let oid = git2::Oid::from_str(oid_str).map_err(|e| e.to_string())?;
        let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
        let tree = commit.tree().map_err(|e| e.to_string())?;
        let entry = tree
            .get_path(Path::new(rel_path))
            .map_err(|e| e.to_string())?;
        let blob = self.repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
        String::from_utf8(blob.content().to_vec()).map_err(|e| e.to_string())
    }

    pub fn on_file_saved(&self, rel_path: &str, _content: &str) -> Result<(), String> {
        validate_rel_path(rel_path)?;

        // Saved files no longer need a shadow working-tree copy. Leaving the
        // copy behind makes future opens treat stale editor recovery as dirty.
        let file_path = self.shadow_path.join(rel_path);
        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| e.to_string())?;
        }

        let mut index = self.repo.index().map_err(|e| e.to_string())?;
        let _ = index.remove_path(Path::new(rel_path));
        index.write().map_err(|e| e.to_string())?;
        let tree_id = index.write_tree().map_err(|e| e.to_string())?;
        let tree = self.repo.find_tree(tree_id).map_err(|e| e.to_string())?;

        // Orphan commit (no parents) clears stale history while preserving any
        // other files still present in the shadow index.
        let sig = sig();
        let ts = chrono::Utc::now().timestamp();
        let msg = format!("shadow: {} {} (saved)", rel_path, ts);

        let oid = self
            .repo
            .commit(None, &sig, &sig, &msg, &tree, &[])
            .map_err(|e| e.to_string())?;

        // Point shadow branch to this orphan commit
        self.repo
            .reference(
                "refs/heads/shadow",
                oid,
                true,
                "on_file_saved: reset to orphan",
            )
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn remove_file(&self, rel_path: &str) -> Result<(), String> {
        validate_rel_path(rel_path)?;
        // Remove from working tree
        let file_path = self.shadow_path.join(rel_path);
        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| e.to_string())?;
        }

        // Remove from index
        let mut index = self.repo.index().map_err(|e| e.to_string())?;
        let _ = index.remove_path(Path::new(rel_path));
        index.write().map_err(|e| e.to_string())?;

        Ok(())
    }

    #[allow(dead_code)]
    pub fn gc(&self) -> Result<(), String> {
        // Best-effort: git2's packwriter API is limited, skip for now.
        // Shadow repos are small; gc can be added later via shelling out to `git gc`.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("verne-shadow-tree-{}-{}", label, std::process::id()))
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

    // ── ShadowTree roundtrip ─────────────────────────────────────────────────

    #[test]
    fn roundtrip_commit_and_read() {
        let internal = tmp("roundtrip-internal");
        let project = tmp("roundtrip-project");
        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();

        let st = ShadowTree::open(&internal, &project).expect("open");
        let oid = st.commit_file("foo.txt", "hello").expect("commit");
        assert!(!oid.is_empty());
        assert_eq!(st.read_file("foo.txt"), Some("hello".to_string()));

        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn diff_detects_change() {
        let internal = tmp("diff-change-internal");
        let project = tmp("diff-change-project");
        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();

        let st = ShadowTree::open(&internal, &project).expect("open");
        st.commit_file("foo.txt", "line1\n").expect("commit");

        let hunks = st
            .diff_file("foo.txt", "line1\nline2\n")
            .expect("diff");
        assert!(!hunks.is_empty(), "expected non-empty diff hunks");

        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn diff_identical_is_empty() {
        let internal = tmp("diff-same-internal");
        let project = tmp("diff-same-project");
        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();

        let st = ShadowTree::open(&internal, &project).expect("open");
        st.commit_file("foo.txt", "line1\n").expect("commit");

        let hunks = st.diff_file("foo.txt", "line1\n").expect("diff");
        assert!(hunks.is_empty(), "expected empty diff for identical content");

        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn read_invalid_path_returns_none() {
        let internal = tmp("read-invalid-internal");
        let project = tmp("read-invalid-project");
        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();

        let st = ShadowTree::open(&internal, &project).expect("open");
        assert_eq!(st.read_file("../x"), None);

        let _ = std::fs::remove_dir_all(&internal);
        let _ = std::fs::remove_dir_all(&project);
    }
}
