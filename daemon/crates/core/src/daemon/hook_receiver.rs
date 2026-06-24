//! Daemon-side HTTP hook receiver. Listens for hook events from agents running
//! in PTY tabs, updates per-tab agent state (in-memory), and emits events to
//! the renderer via the event bus. File-op snapshotting is delegated to the
//! sidecar via the `agent-hook-fileops` event (Electron forwards it).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::services::session_manager::SessionManager;
use crate::state::EventBus;

/// Per-tab generation counter for debouncing transient "blocked" states. Agents
/// with auto tool-approval (codex, antigravity) fire a pre-tool/permission hook
/// even when the tool is auto-approved, so a naive mapping flashes "blocked"
/// before the immediate completion event. A blocked event arms a delayed commit;
/// any newer event for the tab bumps the generation and cancels it.
static BLOCK_GEN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
const BLOCK_DEBOUNCE_MS: u64 = 700;

fn block_gen() -> &'static Mutex<HashMap<String, u64>> {
    BLOCK_GEN.get_or_init(|| Mutex::new(HashMap::new()))
}
/// Bump and return the tab's generation. Called for every hook event so a pending
/// debounced "blocked" is invalidated by whatever event comes next.
fn bump_block_gen(tab_id: &str) -> u64 {
    let mut m = block_gen().lock().unwrap();
    let g = m.entry(tab_id.to_string()).or_insert(0);
    *g += 1;
    *g
}
fn current_block_gen(tab_id: &str) -> u64 {
    block_gen().lock().unwrap().get(tab_id).copied().unwrap_or(0)
}
/// Agents whose "blocked" is debounced (auto tool-approval can fire a permission
/// hook that's instantly superseded by completion).
fn debounce_blocked(agent_type: &str) -> bool {
    matches!(agent_type, "codex" | "antigravity")
}

/// Map a hook event + payload to an agent state string.
fn hook_to_state(event_type: &str, approval_required: bool) -> Option<&'static str> {
    crate::services::hook_server::hook_to_state(event_type, approval_required)
}

fn is_user_prompt_submit(event_type: &str) -> bool {
    matches!(
        event_type,
        "UserPromptSubmit" | "userPromptSubmit" | "userPromptSubmitted"
    )
}

static FALLBACK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn parse_state(state: Option<&str>) -> Option<crate::services::detect::AgentState> {
    use crate::services::detect::AgentState;
    match state {
        Some("working") => Some(AgentState::Working),
        Some("blocked") => Some(AgentState::Blocked),
        Some("idle") => Some(AgentState::Idle),
        Some("unknown") => Some(AgentState::Unknown),
        _ => None,
    }
}

fn hook_display_title(agent_type: &str, event: &str, payload: &serde_json::Value) -> Option<String> {
    use crate::services::agent_status::manifest::TitleStrategy;

    let config = crate::services::agent_status::manifest::title_config(agent_type);
    if config.strategy == TitleStrategy::Osc {
        return None;
    }
    if !config.prompt_events.iter().any(|candidate| candidate == event) {
        return None;
    }
    for path in &config.prompt_fields {
        if let Some(value) = value_at_path(payload, path).and_then(value_to_title) {
            return normalize_title(&value, config.max_length);
        }
    }
    None
}

fn value_at_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for part in path.split('.') {
        if part.is_empty() {
            return None;
        }
        current = current.get(part)?;
    }
    Some(current)
}

fn value_to_title(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(object) = value.as_object() {
        for key in ["prompt", "text", "content", "message", "input"] {
            if let Some(text) = object.get(key).and_then(value_to_title) {
                return Some(text);
            }
        }
    }
    if let Some(array) = value.as_array() {
        for item in array {
            if let Some(text) = value_to_title(item) {
                return Some(text);
            }
        }
    }
    None
}

fn normalize_title(value: &str, max_length: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let max = max_length.max(8);
    let mut out = String::new();
    for ch in normalized.chars().take(max) {
        out.push(ch);
    }
    if normalized.chars().count() > max {
        while out.ends_with(char::is_whitespace) {
            out.pop();
        }
        out.push_str("...");
    }
    Some(out)
}

/// Start the daemon hook HTTP server. Binds `desired_port` (falls back to
/// ephemeral if taken) and returns the actual port. Spawns a background task;
/// the future resolves once the listener is bound.
pub async fn start(
    sessions: Arc<Mutex<SessionManager>>,
    event_bus: Arc<EventBus>,
    secret: String,
    desired_port: u16,
) -> u16 {
    let listener = match TcpListener::bind(("127.0.0.1", desired_port)).await {
        Ok(l) => l,
        Err(e) if desired_port != 0 => {
            log::warn!("hook port {desired_port} taken ({e}); using ephemeral port");
            TcpListener::bind("127.0.0.1:0")
                .await
                .expect("hook server bind ephemeral")
        }
        Err(e) => panic!("hook server bind: {e}"),
    };
    let port = listener.local_addr().expect("hook local_addr").port();
    log::info!("Daemon hook receiver on 127.0.0.1:{}", port);

    tokio::spawn(async move {
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[hook] accept error: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            };
            let sessions = sessions.clone();
            let event_bus = event_bus.clone();
            let secret = secret.clone();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    handle_connection(&mut stream, sessions, event_bus, secret),
                )
                .await;
            });
        }
    });

    port
}

async fn handle_connection(
    stream: &mut tokio::net::TcpStream,
    sessions: Arc<Mutex<SessionManager>>,
    event_bus: Arc<EventBus>,
    secret: String,
) {
    // Read until end-of-headers
    let mut accum: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end: usize;
    loop {
        let n = match stream.read(&mut tmp).await {
            Ok(n) if n > 0 => n,
            _ => return,
        };
        accum.extend_from_slice(&tmp[..n]);
        if let Some(idx) = accum.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = idx + 4;
            break;
        }
        if accum.len() > 1_048_576 { return; } // 1 MB header cap
    }

    let head = String::from_utf8_lossy(&accum[..header_end]);
    if !head.starts_with("POST /hook") {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
        return;
    }

    // Parse headers (lowercase keys)
    let mut headers: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    // Secret check
    let presented = headers.get("x-verne-daemon-secret").map(|s| s.as_str()).unwrap_or("");
    if presented != secret {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        return;
    }

    // Read body up to Content-Length (cap 4 MB)
    const MAX_BODY: usize = 4 * 1024 * 1024;
    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_BODY);
    let mut body = accum[header_end..].to_vec();
    while body.len() < content_length {
        let n = match stream.read(&mut tmp).await {
            Ok(n) if n > 0 => n,
            _ => break,
        };
        body.extend_from_slice(&tmp[..n]);
    }
    if body.len() > content_length { body.truncate(content_length); }

    let event = headers.get("x-verne-event").cloned().unwrap_or_default();
    let agent_id = headers.get("x-verne-agent-id").cloned().unwrap_or_default();
    let agent_type = headers
        .get("x-verne-agent-type")
        .cloned()
        .unwrap_or_else(|| "claude".to_string());
    let tab_id_header = headers
        .get("x-verne-tab-id")
        .cloned()
        .filter(|s| !s.is_empty());
    let hook_source = headers
        .get("x-verne-source")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("hook:{agent_type}"));
    let hook_sequence = headers
        .get("x-verne-seq")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or_else(|| FALLBACK_SEQUENCE.fetch_add(1, Ordering::Relaxed));

    let payload: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);

    // Tab-keyed routing
    if !event.is_empty() {
        let session_id = payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let display_title = hook_display_title(&agent_type, &event, &payload);
        let user_prompt_submitted = is_user_prompt_submit(&event);
        let approval_required = payload
            .get("approval_required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        match tab_id_header.as_deref() {
            Some(tab_id) => {
                // Claude's Notification hook carries the reason in `message`:
                // "Claude needs your permission to use X" → blocked; the 60s
                // idle-prompt notification keeps the default idle mapping.
                let is_permission_notification = (event == "Notification"
                    || event == "notification")
                    && payload
                        .get("message")
                        .and_then(|v| v.as_str())
                        .is_some_and(|m| m.to_ascii_lowercase().contains("permission"));
                let mapped_state = if is_permission_notification {
                    Some("blocked")
                } else {
                    hook_to_state(&event, approval_required)
                };
                log::info!(
                    "[hook] event={} sid={} tab={} state={:?} source={} seq={}",
                    event, session_id, tab_id, mapped_state, hook_source, hook_sequence,
                );
                let gen = bump_block_gen(tab_id);
                if mapped_state == Some("blocked") && debounce_blocked(&agent_type) {
                    // Defer the blocked commit: only fire if no newer event arrives
                    // within the window. An auto-approved tool's completion event
                    // (→ working) bumps the generation and supersedes this.
                    let sessions = sessions.clone();
                    let event_bus = event_bus.clone();
                    let tab = tab_id.to_string();
                    let agent_type = agent_type.clone();
                    let session_id = session_id.clone();
                    let hook_source = hook_source.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(BLOCK_DEBOUNCE_MS)).await;
                        if current_block_gen(&tab) != gen {
                            return; // superseded by a newer event
                        }
                        apply_hook_report(
                            &sessions,
                            &event_bus,
                            &tab,
                            &agent_type,
                            &session_id,
                            None,
                            false,
                            &hook_source,
                            hook_sequence,
                            Some(crate::services::detect::AgentState::Blocked),
                        );
                    });
                } else {
                    apply_hook_report(
                        &sessions,
                        &event_bus,
                        tab_id,
                        &agent_type,
                        &session_id,
                        display_title,
                        user_prompt_submitted,
                        &hook_source,
                        hook_sequence,
                        parse_state(mapped_state),
                    );
                }
            }
            None => {
                eprintln!(
                    "[hook] event={} sid={} — no X-Verne-Tab-Id, dropping",
                    event, session_id,
                );
            }
        }
    }

    // File-op snapshotting: emit event for Electron to forward to sidecar
    let is_pre = event == "PreToolUse" || event == "preToolUse";
    let is_post = event == "PostToolUse" || event == "postToolUse";
    if (is_pre || is_post) && !agent_id.is_empty() {
        let tool_name = payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tool_input = payload
            .get("tool_input")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        event_bus.emit(
            "agent-hook-fileops",
            serde_json::json!({
                "agentId": agent_id,
                "agentType": agent_type,
                "event": event,
                "toolName": tool_name,
                "toolInput": tool_input,
            }),
        );
    }

    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
}

fn apply_hook_report(
    sessions: &Arc<Mutex<SessionManager>>,
    event_bus: &EventBus,
    tab_id: &str,
    agent_type: &str,
    session_id: &str,
    display_title: Option<String>,
    user_prompt_submitted: bool,
    source: &str,
    sequence: u64,
    state: Option<crate::services::detect::AgentState>,
) {
    let change = sessions.lock().ok().and_then(|manager| {
        let session = manager.get_session_by_agent(tab_id)?;
        let review_in_progress = state == Some(crate::services::detect::AgentState::Blocked)
            && session
                .emulator
                .lock()
                .ok()
                .map(|e| {
                    crate::services::agent_registry::detect(agent_type, &e.screen_text())
                        .review_in_progress
                })
                .unwrap_or(false);
        let mut engine = session.agent_status.lock().ok()?;
        let change = engine.apply_hook(crate::services::agent_status::HookReport {
            source: source.to_string(),
            sequence,
            agent_type: agent_type.to_string(),
            session_id: (!session_id.is_empty()).then(|| session_id.to_string()),
            display_title,
            state,
            authority: crate::services::agent_status::policy::hook_authority(agent_type),
            review_in_progress,
            user_prompt_submitted,
            observed_at: chrono::Utc::now().timestamp_millis(),
        });
        change
    });
    if let Some(status) = change {
        crate::daemon::agent_status::publish(event_bus, tab_id, &status, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_codex_prompt_title() {
        let payload = serde_json::json!({
            "prompt": "  create   a docs page\nabout Verne  "
        });
        assert_eq!(
            hook_display_title("codex", "UserPromptSubmit", &payload).as_deref(),
            Some("create a docs page about Verne")
        );
    }

    #[test]
    fn extracts_nested_message_title() {
        let payload = serde_json::json!({
            "message": { "text": "Summarize this project" }
        });
        assert_eq!(
            hook_display_title("opencode", "UserPromptSubmit", &payload).as_deref(),
            Some("Summarize this project")
        );
    }

    #[test]
    fn detects_prompt_submit_events() {
        assert!(is_user_prompt_submit("UserPromptSubmit"));
        assert!(is_user_prompt_submit("userPromptSubmit"));
        assert!(is_user_prompt_submit("userPromptSubmitted"));
        assert!(!is_user_prompt_submit("SessionStart"));
    }

    #[test]
    fn ignores_osc_only_agents() {
        let payload = serde_json::json!({ "prompt": "keep me out of the title" });
        assert_eq!(hook_display_title("claude", "UserPromptSubmit", &payload), None);
    }
}
