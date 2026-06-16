use std::path::PathBuf;

use serde::Deserialize;

use crate::protocol::{methods, Request, Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceParams {
    workspace_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace_root: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameParams {
    workspace_root: String,
    slug: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlugParams {
    workspace_root: String,
    slug: String,
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        methods::NOTES_DIR_PATH
            | methods::NOTES_LIST
            | methods::NOTES_CREATE
            | methods::NOTES_RENAME
            | methods::NOTES_DELETE
    )
}

pub async fn dispatch(req: Request) -> Response {
    match req.method.as_str() {
        methods::NOTES_DIR_PATH => dir_path(req).await,
        methods::NOTES_LIST => list(req).await,
        methods::NOTES_CREATE => create(req).await,
        methods::NOTES_RENAME => rename(req).await,
        methods::NOTES_DELETE => delete(req).await,
        _ => Response::err(req.id, format!("unknown notes method: {}", req.method)),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, Response> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| Response::err(req.id, format!("bad {} params: {e}", req.method)))
}

fn notes_dir_for(workspace_root: &str) -> PathBuf {
    crate::paths::notes_dir(workspace_root)
}

async fn dir_path(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<WorkspaceParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let dir = notes_dir_for(&params.workspace_root);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("notes dir task failed: {e}"));
    result_to_response(id, result)
}

async fn list(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<WorkspaceParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        crate::notes::list(&notes_dir_for(&params.workspace_root))
    })
    .await
    .map_err(|e| format!("notes list task failed: {e}"));
    result_to_response(id, result)
}

async fn create(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<CreateParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<crate::notes::NoteMeta, String> {
        let dir = notes_dir_for(&params.workspace_root);
        let slug = crate::notes::create(&dir, &params.title, "")?;
        Ok(crate::notes::NoteMeta {
            slug,
            title: params.title,
        })
    })
    .await
    .map_err(|e| format!("notes create task failed: {e}"));
    result_to_response(id, result)
}

async fn rename(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<RenameParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        crate::notes::rename(
            &notes_dir_for(&params.workspace_root),
            &params.slug,
            &params.title,
        )
    })
    .await
    .map_err(|e| format!("notes rename task failed: {e}"));
    result_to_response(id, result)
}

async fn delete(req: Request) -> Response {
    let id = req.id;
    let params = match parse_params::<SlugParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        crate::notes::delete(&notes_dir_for(&params.workspace_root), &params.slug)
    })
    .await
    .map_err(|e| format!("notes delete task failed: {e}"));
    match result {
        Ok(Ok(())) => Response::ok(id, serde_json::Value::Null),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

fn result_to_response<T: serde::Serialize>(
    id: u64,
    result: Result<Result<T, String>, String>,
) -> Response {
    match result {
        Ok(Ok(v)) => Response::ok(id, serde_json::to_value(v).unwrap()),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn request(id: u64, method: &str, params: serde_json::Value) -> Request {
        Request {
            id,
            method: method.to_string(),
            params,
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvOverride {
        key: &'static str,
        old_value: Option<std::ffi::OsString>,
    }

    impl EnvOverride {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let old_value = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old_value }
        }
    }

    impl Drop for EnvOverride {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[tokio::test]
    async fn dispatch_create_list_rename_delete_round_trip() {
        let _guard = env_lock().lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let _env = EnvOverride::set("VERNE_INTERNAL_DATA_DIR", tmp.path().join("internal"));
        let workspace_root = tmp.path().join("workspace");
        let params = |extra: serde_json::Value| {
            let mut obj = extra.as_object().cloned().unwrap_or_default();
            obj.insert(
                "workspaceRoot".to_string(),
                serde_json::Value::String(workspace_root.to_string_lossy().into_owned()),
            );
            serde_json::Value::Object(obj)
        };

        let created = dispatch(request(
            1,
            methods::NOTES_CREATE,
            params(serde_json::json!({ "title": "Daily Notes" })),
        ))
        .await;
        assert!(created.error.is_none(), "{created:?}");
        assert_eq!(created.result.unwrap()["slug"], "daily-notes");

        let listed = dispatch(request(
            2,
            methods::NOTES_LIST,
            params(serde_json::json!({})),
        ))
        .await;
        let notes = listed.result.unwrap().as_array().cloned().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["title"], "Daily Notes");

        let renamed = dispatch(request(
            3,
            methods::NOTES_RENAME,
            params(serde_json::json!({ "slug": "daily-notes", "title": "Standup" })),
        ))
        .await;
        assert!(renamed.error.is_none(), "{renamed:?}");
        assert_eq!(renamed.result.unwrap()["slug"], "standup");

        let deleted = dispatch(request(
            4,
            methods::NOTES_DELETE,
            params(serde_json::json!({ "slug": "standup" })),
        ))
        .await;
        assert!(deleted.error.is_none(), "{deleted:?}");

        let listed = dispatch(request(
            5,
            methods::NOTES_LIST,
            params(serde_json::json!({})),
        ))
        .await;
        assert!(listed.result.unwrap().as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dispatch_rejects_bad_params() {
        let resp = dispatch(request(9, methods::NOTES_CREATE, serde_json::json!({}))).await;
        assert_eq!(resp.id, 9);
        assert!(resp
            .error
            .unwrap()
            .message
            .contains("bad notes_create params"));
    }
}
