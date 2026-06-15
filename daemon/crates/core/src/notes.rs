//! Shared notes file ops — used by BOTH the `verne mcp` stdio server and the
//! host Tauri commands, so slugging, path confinement, and title derivation live
//! in ONE place and can't drift between the two processes.
//!
//! Notes are markdown files (one `<slug>.md` per pad) under a per-workspace
//! dir (`paths::notes_dir`). YAML frontmatter stores document metadata such
//! as the title; readers and editors receive the markdown body without it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub slug: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub slug: String,
    pub title: String,
    /// Markdown body with frontmatter removed.
    pub body: String,
}

/// Lowercase, dash-separated, alphanumeric-only slug. Strips path separators and
/// dots, so it is inherently traversal-safe. Empty input → "untitled".
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in input.trim().chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_dash = false;
        } else if !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() {
        "untitled".to_string()
    } else {
        s
    }
}

/// Resolve `name` (slug or title) to a confined `<dir>/<slug>.md` path. `name` is
/// slugified first, so separators/`..` cannot escape; the parent==dir check is a
/// defensive belt.
fn path_for(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let slug = slugify(name);
    let p = dir.join(format!("{slug}.md"));
    if p.parent() != Some(dir) {
        return Err("invalid note name".into());
    }
    Ok(p)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// Atomic overwrite: write to a unique temp file, then rename over the target.
/// Rename is atomic on the same filesystem, so a concurrent reader never sees a
/// torn/empty note and a crash mid-write can't corrupt the existing one.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("pad"),
        std::process::id(),
        n
    ));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

fn split_frontmatter(content: &str) -> (&str, &str) {
    let (rest, opening_len, closing) = if let Some(rest) = content.strip_prefix("---\n") {
        (rest, 4, "\n---\n")
    } else if let Some(rest) = content.strip_prefix("---\r\n") {
        (rest, 5, "\r\n---\r\n")
    } else {
        return ("", content);
    };
    let Some(end) = rest.find(closing) else {
        return ("", content);
    };
    let prefix_len = opening_len + end + closing.len();
    (&content[..prefix_len], &content[prefix_len..])
}

fn frontmatter_title(prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        return None;
    }
    for line in prefix.lines().skip(1) {
        let Some(value) = line.strip_prefix("title:") else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        if value.starts_with('"') {
            if let Ok(title) = serde_json::from_str::<String>(value) {
                return Some(title);
            }
        }
        return Some(value.trim_matches('\'').to_string());
    }
    None
}

fn frontmatter_for(title: &str) -> String {
    format!(
        "---\ntitle: {}\n---\n",
        serde_json::to_string(title).unwrap_or_else(|_| "\"Untitled\"".to_string())
    )
}

fn set_frontmatter_title(content: &str, title: &str) -> String {
    let (prefix, body) = split_frontmatter(content);
    if prefix.is_empty() {
        return format!("{}{body}", frontmatter_for(title));
    }
    let encoded = serde_json::to_string(title).unwrap_or_else(|_| "\"Untitled\"".to_string());
    let mut found = false;
    let mut lines = Vec::new();
    for line in prefix.trim_end_matches('\n').lines() {
        if line.starts_with("title:") {
            lines.push(format!("title: {encoded}"));
            found = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.insert(lines.len().saturating_sub(1), format!("title: {encoded}"));
    }
    format!("{}\n{body}", lines.join("\n"))
}

/// Display title: frontmatter title → first H1 → first non-empty body line → slug.
fn derive_title(slug: &str, content: &str) -> String {
    let (prefix, body) = split_frontmatter(content);
    if let Some(title) = frontmatter_title(prefix) {
        return title;
    }
    for line in body.lines() {
        if let Some(h) = line.trim().strip_prefix("# ") {
            let h = h.trim();
            if !h.is_empty() {
                return h.to_string();
            }
        }
    }
    for line in body.lines() {
        let t = line.trim();
        if !t.is_empty() {
            let stripped = t.trim_start_matches('#').trim();
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    slug.to_string()
}

/// Initial content for a new pad stores its title as metadata, independently of
/// the markdown body's first line.
fn build_content(title: &str, body: &str) -> String {
    format!("{}{}", frontmatter_for(title), body)
}

// --- operations ---

pub fn list(dir: &Path) -> Result<Vec<NoteMeta>, String> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        out.push(NoteMeta {
            title: derive_title(&slug, &content),
            slug,
        });
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

pub fn read(dir: &Path, name: &str) -> Result<NoteContent, String> {
    let p = path_for(dir, name)?;
    let content = fs::read_to_string(&p).map_err(|_| "note not found".to_string())?;
    let slug = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string();
    Ok(NoteContent {
        title: derive_title(&slug, &content),
        slug,
        body: split_frontmatter(&content).1.to_string(),
    })
}

pub fn exists(dir: &Path, name: &str) -> bool {
    path_for(dir, name).map(|p| p.exists()).unwrap_or(false)
}

/// Create a new pad; dedupes the slug against existing files. Returns the slug.
pub fn create(dir: &Path, title: &str, body: &str) -> Result<String, String> {
    ensure_dir(dir)?;
    let base = slugify(title);
    let mut slug = base.clone();
    let mut n = 2;
    while dir.join(format!("{slug}.md")).exists() {
        slug = format!("{base}-{n}");
        n += 1;
    }
    write_atomic(&dir.join(format!("{slug}.md")), &build_content(title, body))?;
    Ok(slug)
}

/// Overwrite (or create) the pad addressed by `name` with full markdown content.
/// Used by the MCP `write` tool. Returns the slug.
pub fn write_body(dir: &Path, name: &str, content: &str) -> Result<String, String> {
    ensure_dir(dir)?;
    let p = path_for(dir, name)?;
    let slug = slugify(name);
    let next = if p.exists() {
        let current = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        let (prefix, _) = split_frontmatter(&current);
        if prefix.is_empty() {
            build_content(&derive_title(&slug, &current), content)
        } else {
            format!("{prefix}{content}")
        }
    } else {
        build_content(name, content)
    };
    write_atomic(&p, &next)?;
    Ok(slug)
}

/// Append text to a pad (blank-line separated); creates it if missing. Used by the
/// MCP `append` tool. For an existing pad this is an `O_APPEND` write (atomic, no
/// read-modify-write) so a concurrent writer's content can't be lost.
pub fn append(dir: &Path, name: &str, text: &str) -> Result<String, String> {
    ensure_dir(dir)?;
    let p = path_for(dir, name)?;
    if !p.exists() {
        write_atomic(&p, &build_content(name, text))?;
        return Ok(slugify(name));
    }
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    write!(f, "\n\n{text}").map_err(|e| e.to_string())?;
    Ok(slugify(name))
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let p = path_for(dir, name)?;
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn rename(dir: &Path, name: &str, title: &str) -> Result<NoteMeta, String> {
    ensure_dir(dir)?;
    let old_path = path_for(dir, name)?;
    let old_slug = old_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string();
    let base = slugify(title);
    let mut slug = base.clone();
    let mut n = 2;
    while slug != old_slug && dir.join(format!("{slug}.md")).exists() {
        slug = format!("{base}-{n}");
        n += 1;
    }
    let content = fs::read_to_string(&old_path).map_err(|_| "note not found".to_string())?;
    let new_path = dir.join(format!("{slug}.md"));
    write_atomic(&new_path, &set_frontmatter_title(&content, title))?;
    if new_path != old_path {
        fs::remove_file(&old_path).map_err(|e| e.to_string())?;
    }
    Ok(NoteMeta {
        slug,
        title: title.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_strips_traversal_and_separators() {
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(slugify("My Notes!"), "my-notes");
        assert_eq!(slugify("  "), "untitled");
        assert_eq!(slugify("already-a-slug"), "already-a-slug");
    }

    #[test]
    fn title_from_h1_then_line_then_slug() {
        assert_eq!(
            derive_title("foo", "---\ntitle: \"Metadata title\"\n---\n# Heading\n"),
            "Metadata title"
        );
        assert_eq!(
            derive_title("foo", "# Meeting notes\n\nbody"),
            "Meeting notes"
        );
        assert_eq!(derive_title("foo", "just text\nmore"), "just text");
        assert_eq!(derive_title("foo", "   \n\n"), "foo");
    }

    #[test]
    fn create_dedupes_and_confines() {
        let tmp = std::env::temp_dir().join(format!("verne-sp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let a = create(&tmp, "Notes", "").unwrap();
        let b = create(&tmp, "Notes", "").unwrap();
        assert_eq!(a, "notes");
        assert_eq!(b, "notes-2");
        // new pad renders its title via frontmatter
        assert_eq!(read(&tmp, "notes").unwrap().title, "Notes");
        assert_eq!(read(&tmp, "notes").unwrap().body, "");
        // traversal name resolves inside dir
        let p = path_for(&tmp, "../escape").unwrap();
        assert_eq!(p.parent(), Some(tmp.as_path()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn append_creates_then_appends() {
        let tmp = std::env::temp_dir().join(format!("verne-sp-app-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let slug = append(&tmp, "Log", "first").unwrap();
        append(&tmp, &slug, "second").unwrap();
        let c = read(&tmp, &slug).unwrap();
        assert_eq!(c.body, "first\n\nsecond");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_and_rename_preserve_frontmatter_and_hide_it_from_readers() {
        let tmp = std::env::temp_dir().join(format!("verne-sp-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        create(&tmp, "Old title", "body").unwrap();
        let path = tmp.join("old-title.md");
        let original = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            original.replacen(
                "title: \"Old title\"\n",
                "title: \"Old title\"\ntags:\n  - work\n",
                1,
            ),
        )
        .unwrap();
        write_body(&tmp, "old-title", "updated").unwrap();
        let renamed = rename(&tmp, "old-title", "New title").unwrap();
        assert_eq!(renamed.slug, "new-title");
        assert_eq!(read(&tmp, "new-title").unwrap().body, "updated");
        let disk = fs::read_to_string(tmp.join("new-title.md")).unwrap();
        assert!(disk.contains("title: \"New title\""));
        assert!(disk.contains("tags:\n  - work"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn concurrent_appends_lose_nothing_and_leave_no_temp_files() {
        use std::sync::Arc;
        let tmp =
            Arc::new(std::env::temp_dir().join(format!("verne-sp-conc-{}", std::process::id())));
        let _ = fs::remove_dir_all(&*tmp);
        create(&tmp, "Log", "start").unwrap();
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let d = Arc::clone(&tmp);
                std::thread::spawn(move || append(&d, "log", &format!("line{i}")).unwrap())
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let c = read(&tmp, "log").unwrap();
        for i in 0..16 {
            assert!(c.body.contains(&format!("line{i}")), "lost line{i}");
        }
        let leftovers: Vec<_> = fs::read_dir(&*tmp)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
        let _ = fs::remove_dir_all(&*tmp);
    }
}
