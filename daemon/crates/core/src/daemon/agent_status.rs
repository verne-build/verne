//! Daemon-owned agent identity and effective-state observation loop.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::services::agent_status::{AgentDetection, AgentObservation, EffectiveAgentStatus};
use crate::services::session_manager::SessionManager;
use crate::state::EventBus;

const POLL_MS: u64 = 1_000;

pub fn start(sessions: Arc<Mutex<SessionManager>>, event_bus: Arc<EventBus>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(POLL_MS));
        loop {
            interval.tick().await;
            let changes = observe_all(&sessions);
            for (tab_id, status, foreground_command) in changes {
                publish(&event_bus, &tab_id, &status, foreground_command.as_deref());
            }
        }
    });
}

fn observe_all(
    sessions: &Arc<Mutex<SessionManager>>,
) -> Vec<(String, EffectiveAgentStatus, Option<String>)> {
    let Ok(manager) = sessions.lock() else {
        return vec![];
    };
    let mut changes = Vec::new();
    for tab_id in manager.list_agent_ids() {
        let Some(session) = manager.get_session_by_agent(&tab_id) else {
            continue;
        };
        if tab_id.starts_with("raw:") {
            continue;
        }
        let fg_pgrp = session
            .pty_master_fd()
            .and_then(crate::services::pgrp::foreground_pgrp);
        let processes = fg_pgrp
            .map(crate::services::pgrp::foreground_processes)
            .unwrap_or_default();
        let process_agent_type = processes.iter().find_map(|p| {
            identify_process(
                &p.name,
                p.argv0.as_deref(),
                p.argv.as_deref().unwrap_or_default(),
            )
        });
        // The foreground pgrp resolved to real process(es) and none is an agent
        // — the login shell, or whatever the user ran after quitting the agent.
        // (Empty processes = pgrp couldn't be resolved this tick; stay sticky
        // rather than clearing on a transient read failure.)
        let foreign_in_foreground = !processes.is_empty() && process_agent_type.is_none();
        let screen = session
            .emulator
            .lock()
            .ok()
            .map(|e| e.screen_text())
            .unwrap_or_default();
        let screen_agent_type = identify_screen(&screen);
        let existing_type = session
            .agent_status
            .lock()
            .ok()
            .and_then(|g| g.snapshot().agent_type);
        let current_type = process_agent_type
            .as_deref()
            .or(screen_agent_type.as_deref())
            .or(existing_type.as_deref())
            .map(str::to_string);
        let detection = current_type
            .as_deref()
            .map(|agent_type| detect(agent_type, &screen))
            .unwrap_or_default();
        let now = chrono::Utc::now().timestamp_millis();
        let observation = AgentObservation {
            process_agent_type,
            screen_agent_type,
            foreign_in_foreground,
            detection,
            input_sequence: session.input_sequence.load(Ordering::Relaxed),
            output_sequence: session.output_sequence.load(Ordering::Relaxed),
            resize_sequence: session.resize_sequence.load(Ordering::Relaxed),
            last_input_at: session.last_input_at(),
            last_output_at: session.last_output_at(),
            last_interrupt_at: session.last_interrupt_at(),
            observed_at: now,
        };
        let change = session
            .agent_status
            .lock()
            .ok()
            .and_then(|mut engine| engine.observe(observation));
        if let Some(status) = change {
            let foreground = if status.agent_type.is_none() {
                foreground_command(fg_pgrp, &processes)
            } else {
                None
            };
            changes.push((tab_id, status, foreground));
        }
    }
    changes
}

pub fn publish(
    event_bus: &EventBus,
    tab_id: &str,
    status: &EffectiveAgentStatus,
    foreground_command: Option<&str>,
) {
    event_bus.emit(
        "tab-updated",
        serde_json::json!({
            "tabId": tab_id,
            "agentType": status.agent_type,
            "agentState": status.agent_state,
            "revision": status.revision,
            "source": status.source,
            "changedAt": status.changed_at,
            "lastAgentSessionId": status.session_id,
            "displayTitle": status.display_title,
            "foregroundCommand": foreground_command,
        }),
    );
}

fn identify_process(name: &str, argv0: Option<&str>, argv: &[String]) -> Option<String> {
    identify_token(name)
        .or_else(|| argv0.and_then(identify_token))
        .or_else(|| argv.iter().find_map(|token| identify_token(token)))
        .map(str::to_string)
}

fn identify_token(token: &str) -> Option<&'static str> {
    crate::services::agent_registry::identify_token(token).map(|agent| agent.key)
}

fn identify_screen(screen: &str) -> Option<String> {
    crate::services::agent_registry::identify_screen(screen).map(|agent| agent.key.to_string())
}

fn detect(agent_type: &str, screen: &str) -> AgentDetection {
    crate::services::agent_registry::detect(agent_type, screen)
}

fn foreground_command(
    pgrp: Option<i32>,
    processes: &[crate::services::pgrp::ForegroundProcess],
) -> Option<String> {
    let process = pgrp
        .and_then(|pid| processes.iter().find(|p| p.pid == pid as u32))
        .or_else(|| processes.first())?;
    Some(
        process
            .argv0
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&process.name)
            .rsplit('/')
            .next()
            .unwrap_or(&process.name)
            .to_ascii_lowercase(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_extended_provider_registry() {
        assert_eq!(identify_token("/usr/local/bin/opencode"), Some("opencode"));
        assert_eq!(identify_token("cursor-agent"), Some("cursor"));
        assert_eq!(identify_token("agy"), Some("antigravity"));
        assert_eq!(identify_token("kimi-code"), Some("kimi"));
        assert_eq!(identify_token("hermes-agent"), Some("hermes"));
        assert_eq!(identify_token("qoderclicn"), Some("qodercli"));
    }
}
