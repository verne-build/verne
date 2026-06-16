use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;

use crate::protocol::{methods, Request, Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentParams {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirParams {
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasteParams {
    source: String,
    target_dir: String,
    #[serde(default)]
    cut: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameParams {
    old_path: String,
    new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesParams {
    dir: String,
    query: String,
    #[serde(default)]
    recent_files: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchContentParams {
    dir: String,
    query: String,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    include: String,
    #[serde(default)]
    exclude: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialParams {
    partial: String,
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        methods::READ_FILE
            | methods::WRITE_FILE
            | methods::CREATE_FILE
            | methods::CREATE_DIR
            | methods::LIST_TREE
            | methods::GET_FILE_MTIME
            | methods::PASTE_PATH
            | methods::FIND_PROJECT_ICON
            | methods::RENAME_PATH
            | methods::FILE_EXISTS
            | methods::SEARCH_FILES
            | methods::SEARCH_CONTENT
            | methods::LIST_DIRECTORY_PATHS
            | methods::PREWARM_FILE_INDEX
    )
}

pub async fn dispatch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    match req.method.as_str() {
        methods::READ_FILE => read_file(req).await,
        methods::WRITE_FILE => write_file(req, state).await,
        methods::CREATE_FILE => create_file(req).await,
        methods::CREATE_DIR => create_dir(req).await,
        methods::LIST_TREE => list_tree(req, state).await,
        methods::GET_FILE_MTIME => get_file_mtime(req).await,
        methods::PASTE_PATH => paste_path(req).await,
        methods::FIND_PROJECT_ICON => find_project_icon(req).await,
        methods::RENAME_PATH => rename_path(req).await,
        methods::FILE_EXISTS => file_exists(req).await,
        methods::SEARCH_FILES => search_files(req, state).await,
        methods::SEARCH_CONTENT => search_content(req, state).await,
        methods::LIST_DIRECTORY_PATHS => list_directory_paths(req, state).await,
        methods::PREWARM_FILE_INDEX => prewarm_file_index(req, state).await,
        _ => Response::err(
            req.id,
            format!("unknown file/search method: {}", req.method),
        ),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, Response> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| Response::err(req.id, format!("bad {} params: {e}", req.method)))
}

async fn read_file(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let language = detect_language(&params.path);
        let content = std::fs::read_to_string(&params.path).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "content": content, "language": language }))
    })
    .await
    .map_err(|e| format!("read_file task failed: {e}"));
    value_result_to_response(id, result)
}

async fn write_file(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<ContentParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let settings = Arc::clone(&state.settings);
    let event_bus = Arc::clone(&state.event_bus);
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        std::fs::write(&params.path, &params.content).map_err(|e| e.to_string())?;
        if std::path::Path::new(&params.path) == crate::settings::settings_path() {
            settings.invalidate();
            event_bus.emit("settings-changed", serde_json::Value::Null);
        }
        let mtime = std::fs::metadata(&params.path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Ok(serde_json::json!({ "ok": true, "mtime": mtime }))
    })
    .await
    .map_err(|e| format!("write_file task failed: {e}"));
    value_result_to_response(id, result)
}

async fn create_file(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let p = std::path::Path::new(&params.path);
        if p.exists() {
            return Err("File already exists".to_string());
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(p, "").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("create_file task failed: {e}"));
    unit_result_to_response(id, result)
}

async fn create_dir(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let p = std::path::Path::new(&params.path);
        if p.exists() {
            return Err("Directory already exists".to_string());
        }
        std::fs::create_dir_all(p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("create_dir task failed: {e}"));
    unit_result_to_response(id, result)
}

async fn list_tree(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || list_tree_impl(&state, &params.dir))
        .await
        .map_err(|e| format!("list_tree task failed: {e}"));
    value_result_to_response(id, result)
}

async fn get_file_mtime(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let mtime = std::fs::metadata(&params.path)
            .map_err(|e| e.to_string())?
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        Ok(serde_json::json!({ "mtime": mtime }))
    })
    .await
    .map_err(|e| format!("get_file_mtime task failed: {e}"));
    value_result_to_response(id, result)
}

async fn paste_path(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PasteParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        paste_path_impl(&params.source, &params.target_dir, params.cut)
    })
    .await
    .map_err(|e| format!("paste_path task failed: {e}"));
    value_result_to_response(id, result)
}

async fn find_project_icon(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<DirParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result =
        tokio::task::spawn_blocking(move || Ok::<_, String>(find_project_icon_impl(&params.dir)))
            .await
            .map_err(|e| format!("find_project_icon task failed: {e}"));
    value_result_to_response(id, result)
}

async fn rename_path(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<RenameParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        std::fs::rename(&params.old_path, &params.new_path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("rename_path task failed: {e}"));
    match result {
        Ok(Ok(())) => Response::ok(id, serde_json::json!(true)),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

async fn file_exists(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<PathParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        Ok::<_, String>(std::path::Path::new(&params.path).is_file())
    })
    .await
    .map_err(|e| format!("file_exists task failed: {e}"));
    value_result_to_response(id, result)
}

async fn search_files(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<SearchFilesParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let recency_map = parse_recent_files(&params.recent_files);
    let result = tokio::task::spawn_blocking(move || {
        search_files_impl(&state, &params.dir, &params.query, recency_map)
    })
    .await
    .map_err(|e| format!("search_files task failed: {e}"));
    value_result_to_response(id, result)
}

async fn search_content(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<SearchContentParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        search_content_impl(
            &state,
            &params.dir,
            &params.query,
            params.case_sensitive,
            &params.include,
            &params.exclude,
        )
    })
    .await
    .map_err(|e| format!("search_content task failed: {e}"));
    value_result_to_response(id, result)
}

async fn list_directory_paths(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<PartialParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result =
        tokio::task::spawn_blocking(move || list_directory_paths_impl(&state, &params.partial))
            .await
            .map_err(|e| format!("list_directory_paths task failed: {e}"));
    value_result_to_response(id, result)
}

async fn prewarm_file_index(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        let base = std::path::PathBuf::from(&params.dir);
        let exclude_key = state.file_exclude_cache_key();
        let mut cache = state.file_list_cache.lock().unwrap();
        if cache
            .get(&params.dir)
            .is_some_and(|c| c.exclude_key == exclude_key)
        {
            return Ok::<(), String>(());
        }
        let files = collect_files_app(&state, &params.dir, &base)?;
        insert_file_list_cache_app(&state, &mut cache, &params.dir, &exclude_key, files);
        Ok(())
    })
    .await
    .map_err(|e| format!("prewarm_file_index task failed: {e}"));
    unit_result_to_response(id, result)
}

fn value_result_to_response<T: serde::Serialize>(
    id: u64,
    result: Result<Result<T, String>, String>,
) -> Response {
    match result {
        Ok(Ok(v)) => Response::ok(id, serde_json::to_value(v).unwrap()),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

fn unit_result_to_response(id: u64, result: Result<Result<(), String>, String>) -> Response {
    match result {
        Ok(Ok(())) => Response::ok(id, serde_json::Value::Null),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

fn parse_recent_files(value: &serde_json::Value) -> HashMap<String, i64> {
    value
        .as_array()
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
        .unwrap_or_default()
}

/// Mirror of `commands/files.rs::read_file` language detection.
fn detect_language(path: &str) -> &'static str {
    use std::path::Path;
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let lang_map = [
        ("ts", "typescript"),
        ("tsx", "typescript"),
        ("mts", "typescript"),
        ("cts", "typescript"),
        ("js", "javascript"),
        ("mjs", "javascript"),
        ("cjs", "javascript"),
        ("jsx", "javascript"),
        ("vue", "vue"),
        ("json", "json"),
        ("jsonc", "jsonc"),
        ("md", "markdown"),
        ("css", "css"),
        ("html", "html"),
        ("htm", "html"),
        ("py", "python"),
        ("pyw", "python"),
        ("rs", "rust"),
        ("go", "go"),
        ("sh", "shell"),
        ("bash", "shell"),
        ("zsh", "shell"),
        ("yml", "yaml"),
        ("yaml", "yaml"),
        ("env", "dotenv"),
        ("toml", "toml"),
        ("sql", "sql"),
        ("graphql", "graphql"),
        ("gql", "graphql"),
        ("rb", "ruby"),
        ("xml", "xml"),
        ("svg", "xml"),
        ("xsl", "xml"),
        ("xsd", "xml"),
        ("plist", "xml"),
        ("php", "php"),
        ("scss", "scss"),
        ("less", "less"),
        ("dockerfile", "dockerfile"),
        ("c", "c"),
        ("h", "c"),
        ("cpp", "cpp"),
        ("cc", "cpp"),
        ("cxx", "cpp"),
        ("hpp", "cpp"),
        ("hxx", "cpp"),
        ("hh", "cpp"),
        ("java", "java"),
        ("cs", "csharp"),
        ("csx", "csharp"),
        ("swift", "swift"),
        ("lua", "lua"),
        ("ini", "ini"),
        ("cfg", "ini"),
        ("conf", "ini"),
        ("properties", "ini"),
        ("hbs", "handlebars"),
        ("handlebars", "handlebars"),
        ("pl", "perl"),
        ("pm", "perl"),
        ("ps1", "powershell"),
        ("psd1", "powershell"),
        ("psm1", "powershell"),
        ("r", "r"),
        ("m", "objective-c"),
        ("mm", "objective-c"),
        ("dart", "dart"),
        ("groovy", "groovy"),
        ("gradle", "groovy"),
        ("clj", "clojure"),
        ("cljs", "clojure"),
        ("edn", "clojure"),
        ("tex", "latex"),
        ("sty", "latex"),
        ("cls", "latex"),
        ("pug", "pug"),
        ("jade", "pug"),
        ("fs", "fsharp"),
        ("fsi", "fsharp"),
        ("fsx", "fsharp"),
        ("tpl", "smarty"),
        ("smarty", "smarty"),
    ];
    let file_name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
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
        lang_map
            .iter()
            .find(|(k, _)| *k == ext)
            .map(|(_, v)| *v)
            .unwrap_or("plaintext")
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
            return if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
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
        let stem = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = dest
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let parent = dest.parent().unwrap().to_path_buf();
        let mut i = 1u32;
        loop {
            let suffix = if i > 1 {
                format!(" {}", i)
            } else {
                String::new()
            };
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
        "public/favicon.svg",
        "favicon.svg",
        "static/favicon.svg",
        "public/apple-touch-icon.png",
        "apple-touch-icon.png",
        "public/favicon.png",
        "public/icon.png",
        "favicon.png",
        "app/icon.png",
        "src/app/icon.png",
        "src-tauri/icons/icon.png",
        "build/icon.png",
        "resources/icon.png",
        "web/favicon.png",
        "web/icons/Icon-192.png",
        "src/favicon.ico",
        "static/favicon.png",
        "src/images/icon.png",
        "assets/icon.png",
        "assets/favicon.png",
        "resources/images/favicon.ico",
        "app/assets/images/favicon.ico",
        "app/assets/images/favicon.png",
        "static/images/favicon.ico",
        "public/favicon.ico",
        "favicon.ico",
        "app/favicon.ico",
        "static/favicon.ico",
        "src/assets/icon.png",
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
                insert_file_list_cache_app(
                    state,
                    &mut cache,
                    dir,
                    &exclude_key,
                    Arc::clone(&files),
                );
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
                let recent = recency_map
                    .get(abs.to_string_lossy().as_ref())
                    .copied()
                    .unwrap_or(0);
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
    const IMAGE_EXTS: [&str; 9] = [
        "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "icns",
    ];

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
    let (start, end) = match_byte_offsets.first().copied().unwrap_or((0, 0));
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

fn ensure_content_picker(state: &crate::state::AppState, dir: &str) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use fff_search::file_picker::{FilePicker, FilePickerOptions};
    use fff_search::grep::{parse_grep_query, GrepMode, GrepSearchOptions, MAX_FFFILE_SIZE};
    use std::io::Write;

    fn request(id: u64, method: &str, params: serde_json::Value) -> Request {
        Request {
            id,
            method: method.to_string(),
            params,
        }
    }

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

    fn test_state_arc() -> Arc<crate::state::AppState> {
        Arc::new(test_state())
    }

    #[test]
    fn handles_file_search_methods_only() {
        assert!(handles(methods::READ_FILE));
        assert!(handles(methods::SEARCH_CONTENT));
        assert!(handles(methods::PREWARM_FILE_INDEX));
        assert!(!handles(methods::SHADOW_READ));
    }

    #[tokio::test]
    async fn dispatch_rejects_bad_params() {
        let resp = dispatch(
            request(9, methods::READ_FILE, serde_json::json!({})),
            test_state_arc(),
        )
        .await;
        assert_eq!(resp.id, 9);
        assert!(resp.error.unwrap().message.contains("bad read_file params"));
    }

    #[tokio::test]
    async fn dispatch_search_files_ignores_bad_recent_entries() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("alpha.txt");
        std::fs::write(&file, "alpha\n").unwrap();
        let resp = dispatch(
            request(
                10,
                methods::SEARCH_FILES,
                serde_json::json!({
                    "dir": dir.path().to_string_lossy(),
                    "query": "alpha",
                    "recentFiles": [["missing-date"], [file.to_string_lossy(), 123], "bad"]
                }),
            ),
            test_state_arc(),
        )
        .await;
        assert!(resp.error.is_none(), "{resp:?}");
        assert_eq!(resp.result.unwrap()["results"].as_array().unwrap().len(), 1);
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
        std::fs::write(
            dir.path().join("ignored").join("secret.txt"),
            "needle hidden",
        )
        .unwrap();

        let state = test_state();
        let dir_str = dir.path().to_str().unwrap();
        let out = search_content_impl(&state, dir_str, "needle", false, "", "").unwrap();
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["line"], 1);
        assert_eq!(results[1]["line"], 3);
        assert!(results[0]["match"]
            .as_str()
            .unwrap()
            .eq_ignore_ascii_case("needle"));
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
