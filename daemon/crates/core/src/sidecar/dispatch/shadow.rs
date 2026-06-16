use std::sync::Arc;

use serde::Deserialize;

use crate::protocol::{methods, Request, Response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirRelParams {
    dir: String,
    rel_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentParams {
    dir: String,
    rel_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    dir: String,
    rel_path: String,
    disk_content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadAtParams {
    dir: String,
    rel_path: String,
    oid: String,
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        methods::SHADOW_COMMIT
            | methods::SHADOW_READ
            | methods::SHADOW_READ_WITH_BASELINE
            | methods::SHADOW_DIFF
            | methods::SHADOW_HISTORY
            | methods::SHADOW_READ_AT
            | methods::SHADOW_ON_SAVED
            | methods::SHADOW_REMOVE
    )
}

pub async fn dispatch(req: Request, state: Arc<crate::state::AppState>) -> Response {
    match req.method.as_str() {
        methods::SHADOW_COMMIT => commit(req, state).await,
        methods::SHADOW_READ => read(req, state).await,
        methods::SHADOW_READ_WITH_BASELINE => read_with_baseline(req, state).await,
        methods::SHADOW_DIFF => diff(req, state).await,
        methods::SHADOW_HISTORY => history(req, state).await,
        methods::SHADOW_READ_AT => read_at(req, state).await,
        methods::SHADOW_ON_SAVED => on_saved(req, state).await,
        methods::SHADOW_REMOVE => remove(req, state).await,
        _ => Response::err(req.id, format!("unknown shadow method: {}", req.method)),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, Response> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| Response::err(req.id, format!("bad {} params: {e}", req.method)))
}

async fn commit(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<ContentParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.commit_file(&params.rel_path, &params.content)
        })
    })
    .await
    .map_err(|e| format!("shadow commit task failed: {e}"));
    string_result_to_response(id, result)
}

async fn read(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirRelParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            Ok(tree.read_file(&params.rel_path))
        })
    })
    .await
    .map_err(|e| format!("shadow read task failed: {e}"));
    value_result_to_response(id, result)
}

async fn read_with_baseline(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirRelParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.read_file_with_baseline(&params.rel_path)
        })
    })
    .await
    .map_err(|e| format!("shadow read baseline task failed: {e}"));
    value_result_to_response(id, result)
}

async fn diff(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DiffParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.diff_file(&params.rel_path, &params.disk_content)
        })
    })
    .await
    .map_err(|e| format!("shadow diff task failed: {e}"));
    value_result_to_response(id, result)
}

async fn history(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirRelParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.file_history(&params.rel_path)
        })
    })
    .await
    .map_err(|e| format!("shadow history task failed: {e}"));
    value_result_to_response(id, result)
}

async fn read_at(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<ReadAtParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.read_at_commit(&params.rel_path, &params.oid)
        })
    })
    .await
    .map_err(|e| format!("shadow read-at task failed: {e}"));
    string_result_to_response(id, result)
}

async fn on_saved(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<ContentParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.on_file_saved(&params.rel_path, &params.content)
        })
    })
    .await
    .map_err(|e| format!("shadow saved task failed: {e}"));
    unit_result_to_response(id, result)
}

async fn remove(req: Request, state: Arc<crate::state::AppState>) -> Response {
    let id = req.id;
    let params = match parse_params::<DirRelParams>(&req) {
        Ok(params) => params,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        shadow_with_tree(&state, &params.dir, |tree| {
            tree.remove_file(&params.rel_path)
        })
    })
    .await
    .map_err(|e| format!("shadow remove task failed: {e}"));
    unit_result_to_response(id, result)
}

fn string_result_to_response(id: u64, result: Result<Result<String, String>, String>) -> Response {
    match result {
        Ok(Ok(v)) => Response::ok(id, serde_json::Value::String(v)),
        Ok(Err(e)) => Response::err(id, e),
        Err(e) => Response::err(id, e),
    }
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

fn shadow_with_tree<T, F>(state: &crate::state::AppState, dir: &str, f: F) -> Result<T, String>
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
mod tests {
    use super::*;

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
    fn handles_shadow_methods_only() {
        assert!(handles(methods::SHADOW_COMMIT));
        assert!(handles(methods::SHADOW_REMOVE));
        assert!(!handles(methods::WATCH_FILE));
    }

    #[tokio::test]
    async fn dispatch_commit_read_remove_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let internal = tmp.path().join("internal");
        std::fs::create_dir_all(&workspace).unwrap();
        let state = Arc::new(crate::state::AppState::new(
            0,
            std::path::PathBuf::new(),
            internal,
            tmp.path().join("home"),
            None,
        ));
        let params = |extra: serde_json::Value| {
            let mut obj = extra.as_object().cloned().unwrap_or_default();
            obj.insert(
                "dir".to_string(),
                serde_json::Value::String(workspace.to_string_lossy().into_owned()),
            );
            obj.insert(
                "relPath".to_string(),
                serde_json::Value::String("notes/today.md".to_string()),
            );
            serde_json::Value::Object(obj)
        };

        let committed = dispatch(
            request(
                1,
                methods::SHADOW_COMMIT,
                params(serde_json::json!({ "content": "hello" })),
            ),
            Arc::clone(&state),
        )
        .await;
        assert!(committed.error.is_none(), "{committed:?}");
        assert!(committed.result.unwrap().as_str().is_some());

        let read = dispatch(
            request(2, methods::SHADOW_READ, params(serde_json::json!({}))),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(read.result.unwrap(), serde_json::json!("hello"));

        let removed = dispatch(
            request(3, methods::SHADOW_REMOVE, params(serde_json::json!({}))),
            Arc::clone(&state),
        )
        .await;
        assert!(removed.error.is_none(), "{removed:?}");

        let read = dispatch(
            request(4, methods::SHADOW_READ, params(serde_json::json!({}))),
            state,
        )
        .await;
        assert_eq!(read.result.unwrap(), serde_json::Value::Null);
    }

    #[tokio::test]
    async fn dispatch_rejects_bad_params() {
        let resp = dispatch(
            request(9, methods::SHADOW_COMMIT, serde_json::json!({})),
            test_state(),
        )
        .await;
        assert_eq!(resp.id, 9);
        assert!(resp
            .error
            .unwrap()
            .message
            .contains("bad shadow_commit params"));
    }
}
