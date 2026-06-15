//! Lean daemon RPC dispatch: PTY sessions + detection only. Operates on
//! `DaemonState` (sessions + ws_port + event_bus) — no DB, no hooks, no git.
//! Everything else is served by the sidecar (`crate::daemon::rpc_server`).

use std::sync::Arc;

use crate::protocol::{methods, Request, Response};
use crate::rpc_serve::BoxFut;
use crate::state::DaemonState;
use crate::types::TabSpawnPlan;

fn s(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Parse `#rrggbb` (or `rrggbb`) into an RGB triple.
fn parse_hex(v: Option<&serde_json::Value>) -> Option<(u8, u8, u8)> {
    let s = v.and_then(|x| x.as_str())?;
    let h = s.strip_prefix('#').unwrap_or(s);
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

pub fn dispatch(req: Request, state: Arc<DaemonState>) -> BoxFut {
    Box::pin(dispatch_impl(req, state))
}

async fn dispatch_impl(req: Request, state: Arc<DaemonState>) -> Response {
    match req.method.as_str() {
        "ping" => Response::ok(req.id, serde_json::json!("pong")),
        "__shutdown" => {
            log::info!("daemon shutdown requested");
            let _ = std::fs::remove_file(crate::paths::pid_file_path());
            let resp = Response::ok(req.id, serde_json::Value::Null);
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                std::process::exit(0);
            });
            resp
        }
        m if m == methods::GET_WS_PORT => Response::ok(req.id, serde_json::json!(state.ws_port)),

        // Push the client's active theme colors so terminal color queries (OSC
        // 10/11/12, indexed) are answered with the real theme. Sets the global
        // default for future emulators AND updates all live sessions.
        "terminal_set_colors" => {
            use crate::services::terminal_emulator::{set_global_terminal_colors, TermColors};
            let p = &req.params;
            let mut colors = TermColors::DARK;
            if let Some(fg) = parse_hex(p.get("fg")) { colors.fg = fg; }
            if let Some(bg) = parse_hex(p.get("bg")) { colors.bg = bg; }
            if let Some(cur) = parse_hex(p.get("cursor")) { colors.cursor = cur; }
            if let Some(arr) = p.get("ansi").and_then(|v| v.as_array()) {
                for (i, v) in arr.iter().take(16).enumerate() {
                    if let Some(rgb) = parse_hex(Some(v)) { colors.ansi[i] = rgb; }
                }
            }
            set_global_terminal_colors(colors);
            if let Ok(sessions) = state.sessions.lock() {
                sessions.set_all_terminal_colors(colors);
            }
            Response::ok(req.id, serde_json::json!(true))
        }

        // Default cursor style (user preference); apps' DECSCUSR still wins.
        "terminal_set_cursor" => {
            use crate::services::terminal_emulator::{
                cursor_shape_from_str, set_global_terminal_cursor,
            };
            let shape = cursor_shape_from_str(req.params["shape"].as_str().unwrap_or("block"));
            let blink = req.params["blink"].as_bool().unwrap_or(false);
            set_global_terminal_cursor(shape, blink);
            if let Ok(sessions) = state.sessions.lock() {
                sessions.set_all_terminal_cursor(shape, blink);
            }
            Response::ok(req.id, serde_json::json!(true))
        }

        m if m == methods::GET_DAEMON_DIAGNOSTICS => {
            let result: Result<crate::types::DaemonDiagnostics, String> = (|| {
                let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                let active_sessions = sessions.session_count();
                // No DB here — label defaults to the tab id; Electron enriches
                // from the sidecar's tab list if it wants display names.
                let tab_child_pids = sessions
                    .tab_child_pids()
                    .into_iter()
                    .map(|(id, pid)| crate::types::TabChildPid { label: id.clone(), tab_id: id, pid })
                    .collect();
                Ok(crate::types::DaemonDiagnostics {
                    daemon_pid: std::process::id(),
                    tab_child_pids,
                    agent_count: 0,
                    active_sessions,
                    file_watchers: 0,
                    directory_watchers: 0,
                    git_watchers: 0,
                    cached_file_indexes: 0,
                    cached_file_paths: 0,
                    source_control_visible: false,
                })
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }

        m if m == methods::CREATE_TERMINAL => {
            let working_dir = s(req.params.get("workingDir"));
            let cols = req.params.get("cols").and_then(|v| v.as_u64()).map(|n| n as u16);
            let rows = req.params.get("rows").and_then(|v| v.as_u64()).map(|n| n as u16);
            let result: Result<String, String> = (|| {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
                let (session_id, session) = crate::services::session_manager::create_raw_session(
                    "term",
                    &shell,
                    &["-l"],
                    &working_dir,
                    cols.unwrap_or(80),
                    rows.unwrap_or(24),
                )?;
                let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                sessions.insert_session(session);
                Ok(session_id)
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::String(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == methods::KILL_TERMINAL => {
            let session_id = s(req.params.get("sessionId"));
            let result: Result<bool, String> = (|| {
                let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                Ok(sessions.stop_session(&session_id))
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::Value::Bool(v)),
                Err(e) => Response::err(req.id, e),
            }
        }

        m if m == methods::TAB_SPAWN => {
            let plan: TabSpawnPlan = match req.params.get("plan")
                .cloned()
                .ok_or_else(|| "missing plan".to_string())
                .and_then(|v| serde_json::from_value(v).map_err(|e| format!("bad plan: {e}")))
            {
                Ok(p) => p,
                Err(e) => return Response::err(req.id, e),
            };
            match crate::daemon::tab_pty::spawn_tab_pty(&state.sessions, &state.event_bus, plan) {
                Ok(sid) => Response::ok(req.id, serde_json::Value::String(sid)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == methods::TAB_KILL => {
            let tab_id = s(req.params.get("tabId"));
            match crate::daemon::tab_pty::kill_tab_pty(&state.sessions, &tab_id) {
                Ok(v) => Response::ok(req.id, serde_json::Value::Bool(v)),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == methods::TAB_RESIZE => {
            // Resize a backgrounded tab's PTY (agent_id == tab_id) so its size
            // tracks the viewport while its grid WS is disconnected; on
            // reactivation the size already matches and the TUI needn't redraw.
            let tab_id = s(req.params.get("tabId"));
            let cols = req.params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = req.params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            let found = (|| -> Option<bool> {
                let sessions = state.sessions.lock().ok()?;
                let session = sessions.get_session_by_agent(&tab_id)?;
                session.resize(cols, rows);
                Some(true)
            })()
            .unwrap_or(false);
            Response::ok(req.id, serde_json::Value::Bool(found))
        }
        m if m == methods::LIST_LIVE_TAB_IDS => {
            let result: Result<Vec<String>, String> = (|| {
                let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                Ok(sessions.list_agent_ids())
            })();
            match result {
                Ok(v) => Response::ok(req.id, serde_json::to_value(v).unwrap()),
                Err(e) => Response::err(req.id, e),
            }
        }
        m if m == methods::TABS_HAS_RUNNING_CHILD => {
            let id = s(req.params.get("id"));
            let has_child = (|| -> Option<bool> {
                let sessions = state.sessions.lock().ok()?;
                let session = sessions.get_session_by_agent(&id)?;
                let fd = session.pty_master_fd()?;
                let pg = crate::services::pgrp::foreground_pgrp(fd)?;
                let child = session.child_pid? as i32;
                Some(pg != child)
            })().unwrap_or(false);
            Response::ok(req.id, serde_json::Value::Bool(has_child))
        }

        m if m == methods::GET_HOOK_CONFIG => {
            use crate::services::agent_registry::{HookIntegration, AGENTS};
            let port = state.hook_port.load(std::sync::atomic::Ordering::Relaxed);
            let secret = state.hook_secret.lock().map(|g| g.clone()).unwrap_or_default();
            let integrations: Vec<serde_json::Value> = AGENTS
                .iter()
                .filter(|agent| agent.hooks != HookIntegration::None)
                .map(|agent| {
                    let kind = match agent.hooks {
                        HookIntegration::FullLifecycle => "fullLifecycle",
                        HookIntegration::Identity => "identity",
                        HookIntegration::None => "none",
                    };
                    serde_json::json!({ "key": agent.key, "kind": kind })
                })
                .collect();
            Response::ok(
                req.id,
                serde_json::json!({ "port": port, "secret": secret, "integrations": integrations }),
            )
        }

        m if m == methods::GET_AGENT_STATES => {
            let result: Result<serde_json::Value, String> = (|| {
                let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                let states: Vec<_> = sessions.effective_agent_states().into_iter().map(|(tab_id, status, title)| {
                    serde_json::json!({
                        "tabId": tab_id,
                        "agentState": status.agent_state,
                        "agentType": status.agent_type,
                        "revision": status.revision,
                        "source": status.source,
                        "changedAt": status.changed_at,
                        "lastAgentSessionId": status.session_id,
                        "title": title,
                    })
                }).collect();
                Ok(serde_json::json!(states))
            })();
            match result {
                Ok(v) => Response::ok(req.id, v),
                Err(e) => Response::err(req.id, e),
            }
        }

        m if m == methods::EXPLAIN_DETECTION => {
            #[derive(serde::Deserialize)]
            struct Params {
                key: String,
                screen: String,
            }
            match serde_json::from_value::<Params>(req.params.clone()) {
                Ok(p) => {
                    let explain =
                        crate::services::agent_status::manifest::explain(&p.key, &p.screen);
                    Response::ok(
                        req.id,
                        crate::services::agent_status::manifest::explain_to_json(&explain),
                    )
                }
                Err(e) => Response::err(req.id, format!("invalid params: {e}")),
            }
        }

        other => Response::err(req.id, format!("unknown daemon method: {other}")),
    }
}
