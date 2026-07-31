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
    // Generated strategies: the title comes from Electron main, which shells out
    // to the agent CLI. Emitting a hook title here would flash the raw prompt
    // before the generated one lands — the exact behaviour this replaces.
    if matches!(
        config.strategy,
        TitleStrategy::Generated | TitleStrategy::GeneratedThenHookPrompt
    ) {
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

/// True when this agent's manifest asks for a generated title AND this event is
/// one of its declared prompt events.
fn wants_generated_title(agent_type: &str, event: &str) -> bool {
    use crate::services::agent_status::manifest::TitleStrategy;
    let config = crate::services::agent_status::manifest::title_config(agent_type);
    matches!(
        config.strategy,
        TitleStrategy::Generated | TitleStrategy::GeneratedThenHookPrompt
    ) && config.prompt_events.iter().any(|candidate| candidate == event)
}

/// The prompt text to summarize: RAW and untruncated (unlike a title, the
/// generator wants the whole request). Trimmed only.
fn hook_prompt_text(agent_type: &str, payload: &serde_json::Value) -> Option<String> {
    let config = crate::services::agent_status::manifest::title_config(agent_type);
    for path in &config.prompt_fields {
        if let Some(value) = value_at_path(payload, path).and_then(value_to_title) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// The title to use if generation fails. Computed HERE, with the manifest's own
/// normalize_title + max_length, so Electron main never reimplements truncation
/// in TypeScript and the two can't drift. None under bare `Generated`.
fn generated_fallback_title(
    agent_type: &str,
    event: &str,
    payload: &serde_json::Value,
) -> Option<String> {
    use crate::services::agent_status::manifest::TitleStrategy;
    let config = crate::services::agent_status::manifest::title_config(agent_type);
    if config.strategy != TitleStrategy::GeneratedThenHookPrompt {
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

/// The agent binary path the hook resolved in its own environment. Empty string
/// and absent header both mean "unknown" — main then falls back to its own
/// layered resolution.
fn header_agent_bin(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("x-verne-agent-bin")
        .cloned()
        .filter(|s| !s.is_empty())
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
    let agent_bin = header_agent_bin(&headers);

    let payload: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);

    // A nested agent (`claude` shelling out to `codex exec`) inherits
    // VERNE_TAB_ID and posts hooks tagged with the owner's tab. Drop the whole
    // request — state, title and file-ops all belong to the owner.
    if let Some(tab_id) = tab_id_header.as_deref() {
        if is_nested_agent(&sessions, tab_id, &agent_type) {
            log::info!("[hook] event={event} tab={tab_id} agent={agent_type} — nested agent, dropping");
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
            return;
        }
    }

    // A subagent of the tab's own agent. Same binary, same tab, same session id
    // — only `agent_id` separates them — so `is_nested_agent` (which keys off
    // agent TYPE) cannot see it. Its lifecycle is not the tab's: a codex
    // subagent's permission request must not block the tab, a claude
    // background agent's tool calls must not drag it back to working after the
    // turn ended, and neither one's prompt may retitle it. File-ops still
    // apply: the edits are real and land in the tab's worktree.
    let subagent = hook_subagent_id(&agent_type, &payload);
    if let Some(path) = subagent.as_deref() {
        log::info!("[hook] event={event} agent={agent_type} subagent={path} — state/title skipped");
    }

    // Tab-keyed routing
    if !event.is_empty() && subagent.is_none() {
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
                        if screen_contradicts_block(&sessions, &tab, &agent_type) {
                            log::info!(
                                "[hook] blocked dropped tab={tab} agent={agent_type} — screen shows the agent still running"
                            );
                            return;
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

    // Generated titles: hand the raw prompt to Electron main, which owns the
    // subprocess + the DB. Tab-keyed, so a hook with no X-Verne-Tab-Id is dropped.
    if let Some(tab_id) = tab_id_header.as_deref().filter(|s| !s.is_empty()) {
        if subagent.is_none() && wants_generated_title(&agent_type, &event) {
            if let Some(prompt) = hook_prompt_text(&agent_type, &payload) {
                event_bus.emit(
                    "agent-title-requested",
                    serde_json::json!({
                        "tabId": tab_id,
                        "agentType": agent_type,
                        "agentBin": agent_bin,
                        "prompt": prompt,
                        "fallbackTitle": generated_fallback_title(&agent_type, &event, &payload),
                    }),
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

fn is_nested_agent(
    sessions: &Arc<Mutex<SessionManager>>,
    tab_id: &str,
    agent_type: &str,
) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    sessions
        .lock()
        .ok()
        .and_then(|manager| {
            let session = manager.get_session_by_agent(tab_id)?;
            let engine = session.agent_status.lock().ok()?;
            Some(engine.hook_is_nested(agent_type, now))
        })
        .unwrap_or(false)
}

/// The subagent this hook came from, or None for the tab's own agent.
///
/// Both agents that spawn subagents carry `agent_id`, but with different
/// conventions, so the reading is per-agent — a generic one would misfire:
///
/// - **codex** addresses agents by canonical path: the main agent is `/root`,
///   the ones it spawns `/root/<task>` (deeper again for their own children).
///   The field is optional on the tool/permission events (omitted for the main
///   agent) but REQUIRED on `Stop`/`Subagent*`, where the main agent reports
///   `/root` — so presence alone would misread every main-agent `Stop`.
/// - **claude** omits the field entirely for its main loop, on every event
///   including `Stop`, and sets it (plus `agent_type`) only on events sourced
///   from a subagent. Presence is the whole signal.
///
/// It is the only discriminator either one gives us: subagents run the same
/// binary, inherit `VERNE_TAB_ID`, and report the parent's `session_id`.
///
/// Dropping their state is safe in both. No subagent-sourced event maps to
/// `blocked` for claude, so no real block can be hidden; and for a foreground
/// subagent the main agent's own `PreToolUse`/`PostToolUse` on the spawning
/// tool already latch the tab working until its `Stop`.
fn hook_subagent_id(agent_type: &str, payload: &serde_json::Value) -> Option<String> {
    let raw = payload.get("agent_id")?.as_str()?.trim();
    let id = raw.trim_end_matches('/');
    if id.is_empty() {
        return None;
    }
    match agent_type {
        "codex" => (id != "/root" && id != "root").then(|| id.to_string()),
        "claude" => Some(id.to_string()),
        _ => None,
    }
}

/// The screen contradicts a pending hook Blocked: a live interrupt affordance
/// (or the auto-review banner) and no rendered prompt. Codex fires
/// PermissionRequest even when nothing is asked of the user — an automated
/// reviewer (`approvals_reviewer`) resolves it, and its subagents fire it on
/// the parent's tab — so the debounce expires and a spurious Blocked (plus its
/// notification) commits. A genuine block always renders a prompt, and the
/// screen path in `AgentStatusEngine::observe` commits Blocked on its own if
/// one appears later, so requiring one here costs nothing.
fn screen_contradicts_block(
    sessions: &Arc<Mutex<SessionManager>>,
    tab_id: &str,
    agent_type: &str,
) -> bool {
    sessions
        .lock()
        .ok()
        .and_then(|manager| {
            let session = manager.get_session_by_agent(tab_id)?;
            let screen = session.emulator.lock().ok()?.screen_text();
            let detection = crate::services::agent_registry::detect(agent_type, &screen);
            Some(
                (detection.visible_working || detection.review_in_progress)
                    && !detection.visible_blocker,
            )
        })
        .unwrap_or(false)
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
    fn codex_main_agent_payloads_are_not_subagents() {
        // Tool/permission events omit agent_id for the main agent; Stop and
        // Subagent* require it and the main agent reports `/root`.
        for payload in [
            serde_json::json!({}),
            serde_json::json!({ "agent_id": "/root" }),
            serde_json::json!({ "agent_id": "/root/" }),
            serde_json::json!({ "agent_id": "" }),
        ] {
            assert_eq!(hook_subagent_id("codex", &payload), None, "{payload}");
        }
    }

    #[test]
    fn codex_subagent_payloads_report_their_path() {
        assert_eq!(
            hook_subagent_id(
                "codex",
                &serde_json::json!({ "agent_id": "/root/task3_verification" })
            )
            .as_deref(),
            Some("/root/task3_verification")
        );
        // Grandchildren nest deeper.
        assert_eq!(
            hook_subagent_id("codex", &serde_json::json!({ "agent_id": "/root/task1/task_3" }))
                .as_deref(),
            Some("/root/task1/task_3")
        );
    }

    #[test]
    fn claude_main_agent_payloads_omit_agent_id() {
        // Captured from a live session: every main-loop event, Stop included,
        // arrives without agent_id.
        let stop = serde_json::json!({
            "session_id": "a4951a38-0000-4000-8000-000000000000",
            "hook_event_name": "Stop",
            "stop_hook_active": false,
            "background_tasks": [{ "id": "aae9889c073c1ec70", "type": "subagent" }],
        });
        assert_eq!(hook_subagent_id("claude", &stop), None);
    }

    #[test]
    fn claude_background_agent_hooks_are_subagents() {
        // The tool calls a background agent keeps making after the main turn's
        // Stop — these would otherwise drag the tab back to working.
        let payload = serde_json::json!({
            "session_id": "a4951a38-0000-4000-8000-000000000000",
            "hook_event_name": "PreToolUse",
            "agent_id": "aae9889c073c1ec70",
            "agent_type": "general-purpose",
            "tool_name": "Bash",
        });
        assert_eq!(
            hook_subagent_id("claude", &payload).as_deref(),
            Some("aae9889c073c1ec70")
        );
    }

    #[test]
    fn agents_without_a_subagent_convention_are_never_filtered() {
        let payload = serde_json::json!({ "agent_id": "whatever" });
        assert_eq!(hook_subagent_id("grok", &payload), None);
    }

    #[test]
    fn extracts_codex_prompt_title() {
        // codex now uses generated_then_hook_prompt strategy, so hook_display_title
        // returns None — the title comes from Electron main instead.
        let payload = serde_json::json!({
            "prompt": "  create   a docs page\nabout Verne  "
        });
        assert_eq!(hook_display_title("codex", "UserPromptSubmit", &payload), None);
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

    #[test]
    fn generated_strategy_suppresses_hook_title() {
        // codex declares generated_then_hook_prompt, so the raw prompt must NOT
        // become the live title — main supplies the title instead.
        let payload = serde_json::json!({ "prompt": "add a retry to the uploader" });
        assert_eq!(hook_display_title("codex", "UserPromptSubmit", &payload), None);
    }

    #[test]
    fn generated_fallback_title_is_normalized_for_then_hook_prompt() {
        // codex = generated_then_hook_prompt, so the fallback is the same
        // normalized string hook_prompt would have produced.
        let payload = serde_json::json!({ "prompt": "  add   a retry\nto the uploader " });
        assert_eq!(
            generated_fallback_title("codex", "UserPromptSubmit", &payload).as_deref(),
            Some("add a retry to the uploader"),
        );
    }

    #[test]
    fn hook_prompt_text_is_raw_and_untruncated() {
        // The generator wants the WHOLE prompt, not the 120-char title form.
        let long = "x".repeat(400);
        let payload = serde_json::json!({ "prompt": long.clone() });
        assert_eq!(hook_prompt_text("codex", &payload).as_deref(), Some(long.as_str()));
    }

    #[test]
    fn wants_generated_title_only_for_declared_events_and_agents() {
        assert!(wants_generated_title("codex", "UserPromptSubmit"));
        assert!(!wants_generated_title("codex", "PostToolUse"));
        // claude is strategy = "osc" — must not opt in.
        assert!(!wants_generated_title("claude", "UserPromptSubmit"));
    }

    #[test]
    fn header_agent_bin_treats_absent_and_empty_alike() {
        let mut headers = std::collections::HashMap::new();
        assert_eq!(header_agent_bin(&headers), None);
        headers.insert("x-verne-agent-bin".to_string(), String::new());
        assert_eq!(header_agent_bin(&headers), None);
        headers.insert(
            "x-verne-agent-bin".to_string(),
            "/Users/me/.local/bin/codex".to_string(),
        );
        assert_eq!(header_agent_bin(&headers).as_deref(), Some("/Users/me/.local/bin/codex"));
    }
}
