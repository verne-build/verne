//! Daemon-side PTY half of tab lifecycle. Given a fully-resolved `TabSpawnPlan`
//! (built by the sidecar from the DB), spawn/track the tab's live shell session.
//! No DB access here — display labels for the `tab-bell` notification ride in on
//! the plan.

use std::sync::{Arc, Mutex};

use crate::services::session_manager::{self, SessionManager, StartSessionOpts};
use crate::state::EventBus;
use crate::types::{GridSnapshotDump, TabSpawnPlan};

/// Spawn (or reuse) the live PTY session for a tab, keyed by `tab_id`. Returns
/// the session id. Idempotent: if a live session already exists for the tab
/// (e.g. the renderer reattaching), its id is returned without spawning.
pub fn spawn_tab_pty(
    sessions: &Arc<Mutex<SessionManager>>,
    event_bus: &Arc<EventBus>,
    plan: TabSpawnPlan,
) -> Result<String, String> {
    {
        let sm = sessions.lock().map_err(|e| e.to_string())?;
        if let Some(s) = sm.get_session_by_agent(&plan.tab_id) {
            return Ok(s.id.clone());
        }
    }

    // Reject a multiline startup command before acquiring a spawn slot: an
    // invalid command must never leave a live orphan session behind.
    if let Some(command) = plan.startup_command.as_deref() {
        if command.contains('\n') || command.contains('\r') {
            return Err("startup_command must be single-line".to_string());
        }
    }

    let start_opts = StartSessionOpts {
        working_dir: plan.cwd.clone(),
        launch_command: plan.launch_command.clone(),
        startup_command: plan.startup_command.clone(),
        cols: 80,
        rows: 50,
        env: plan.env.clone(),
    };

    // Acquire a spawn slot WITHOUT holding the sessions lock — the wait must not
    // block other spawns from releasing their slots (deadlock otherwise).
    let spawn_slots = {
        let sm = sessions.lock().map_err(|e| e.to_string())?;
        sm.spawn_slots()
    };
    SessionManager::acquire_spawn_slot(&spawn_slots);

    let noop_resume: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {});

    let on_osc = {
        let event_bus = event_bus.clone();
        let tab_id = plan.tab_id.clone();
        let directory_name = plan.directory_name.clone();
        let tab_label = plan.tab_label.clone();
        move |_: String| {
            event_bus.emit(
                "tab-bell",
                serde_json::json!({
                    "tabId": tab_id,
                    "directoryName": directory_name,
                    "tabLabel": tab_label,
                }),
            );
        }
    };

    let on_title = {
        let event_bus = event_bus.clone();
        let tab_id = plan.tab_id.clone();
        move |title: String| {
            event_bus.emit(
                "tab-title",
                serde_json::json!({ "tabId": tab_id, "title": title }),
            );
        }
    };

    let sessions_exit = Arc::clone(sessions);
    let bus_exit = event_bus.clone();
    let tab_id_exit = plan.tab_id.clone();
    let exited_early = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let exited_flag = Arc::clone(&exited_early);

    let on_exit = move || {
        // PTY read loop ended: drop the dead session so get_session_by_agent
        // stops matching it (unblocks respawn), then tell the UI. If the child
        // died before `insert_session` below ran, this lookup finds nothing —
        // the flag lets the post-insert check catch that race.
        let sid = {
            let mut sm = sessions_exit.lock().unwrap_or_else(|p| p.into_inner());
            let sid = sm.get_session_by_agent(&tab_id_exit).map(|s| s.id.clone());
            if let Some(ref sid) = sid {
                sm.remove_session(sid);
            }
            exited_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            sid
        };
        if sid.is_some() {
            bus_exit.emit("tab-exited", serde_json::json!({ "tabId": tab_id_exit }));
        }
    };

    let create_result = session_manager::create_session(
        plan.tab_id.clone(),
        start_opts,
        |_data: Vec<u8>| {},
        on_osc,
        on_title,
        |_working: bool| {},
        || {},
        noop_resume,
        on_exit,
    );

    let (session_id, session) = match create_result {
        Ok(r) => r,
        Err(e) => {
            SessionManager::release_spawn_slot(&spawn_slots);
            return Err(e);
        }
    };

    // Recover from poison rather than propagating: the PTY is already live, so
    // dropping `session` here would leak the child process untracked.
    {
        let mut sm = sessions.lock().unwrap_or_else(|p| p.into_inner());
        sm.insert_session(session);

        // One-shot keystroke-style injection: written into the PTY after the
        // shell is up, so it runs inside the user's normal shell and the
        // shell survives once the injected command exits. Distinct from
        // `launch_command`, which replaces the shell's argv entirely.
        if let Some(command) = plan.startup_command.as_deref() {
            let write_result = sm
                .get_session_by_agent(&plan.tab_id)
                .ok_or_else(|| "spawned session was not registered".to_string())
                .and_then(|registered| registered.write(format!("{command}\n").as_bytes()));
            if let Err(e) = write_result {
                if let Some(sid) = sm.get_session_by_agent(&plan.tab_id).map(|s| s.id.clone()) {
                    sm.stop_session(&sid);
                }
                SessionManager::release_spawn_slot(&spawn_slots);
                return Err(e);
            }
        }
    }
    SessionManager::release_spawn_slot(&spawn_slots);

    // on_exit may have already fired before insert_session ran (child died
    // instantly, e.g. bad $SHELL) — its lookup found nothing to remove, so the
    // just-inserted session would otherwise be permanently stale. Catch that
    // race here; emit only if we actually found something, so a normal
    // exit-after-insert (already handled by on_exit) doesn't double-emit.
    if exited_early.load(std::sync::atomic::Ordering::SeqCst) {
        let sid = {
            let mut sm = sessions.lock().unwrap_or_else(|p| p.into_inner());
            let sid = sm.get_session_by_agent(&plan.tab_id).map(|s| s.id.clone());
            if let Some(ref sid) = sid {
                sm.remove_session(sid);
            }
            sid
        };
        if sid.is_some() {
            event_bus.emit("tab-exited", serde_json::json!({ "tabId": plan.tab_id }));
        }
    }

    Ok(session_id)
}

/// Kill the live PTY session for a tab (looked up by agent_id == tab_id).
/// Returns true if a session was found and stopped.
pub fn kill_tab_pty(sessions: &Arc<Mutex<SessionManager>>, tab_id: &str) -> Result<bool, String> {
    let session_id = {
        let sm = sessions.lock().map_err(|e| e.to_string())?;
        sm.get_session_by_agent(tab_id).map(|s| s.id.clone())
    };
    if let Some(sid) = session_id {
        let mut sm = sessions.lock().map_err(|e| e.to_string())?;
        Ok(sm.stop_session(&sid))
    } else {
        Ok(false)
    }
}

/// Snapshot the live grid of a tab's PTY for archiving. Clones the emulator
/// `Arc` before releasing the session-manager lock so grid encoding never
/// holds both locks at once.
pub fn snapshot_tab_pty(
    sessions: &Arc<Mutex<SessionManager>>,
    tab_id: &str,
) -> Result<GridSnapshotDump, String> {
    let emulator = {
        let sm = sessions.lock().map_err(|e| e.to_string())?;
        sm.get_session_by_agent(tab_id)
            .map(|s| Arc::clone(&s.emulator))
            .ok_or_else(|| "session already exited; nothing to archive.".to_string())?
    };
    let dump = emulator.lock().map_err(|e| e.to_string())?.snapshot_dump();
    Ok(dump)
}

#[cfg(test)]
mod startup_command_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn base_plan(tab_id: &str, cwd: &str, startup_command: Option<String>) -> TabSpawnPlan {
        TabSpawnPlan {
            tab_id: tab_id.to_string(),
            cwd: cwd.to_string(),
            launch_command: None,
            env: Default::default(),
            startup_command,
            directory_name: None,
            tab_label: None,
        }
    }

    /// Poll the tab's tail buffer until `needle` appears or the timeout
    /// elapses. Returns the number of times `needle` occurs in the final
    /// snapshot.
    fn poll_tail_for(
        sessions: &Arc<Mutex<SessionManager>>,
        tab_id: &str,
        needle: &str,
        timeout: Duration,
    ) -> usize {
        let deadline = Instant::now() + timeout;
        loop {
            let count = {
                let sm = sessions.lock().unwrap();
                sm.get_session_by_agent(tab_id)
                    .map(|s| {
                        let tail = s.tail.lock().unwrap().snapshot();
                        tail.matches(needle).count()
                    })
                    .unwrap_or(0)
            };
            if count > 0 || Instant::now() >= deadline {
                return count;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn startup_command_is_injected_once() {
        let sessions = Arc::new(Mutex::new(SessionManager::new()));
        let bus = Arc::new(EventBus::new());
        let cwd = std::env::temp_dir().to_string_lossy().to_string();

        let with_cmd = base_plan(
            "startup-cmd-tab-1",
            &cwd,
            Some("printf '__VERNE_RESUMED__\\n'".to_string()),
        );
        let without_cmd = base_plan("startup-cmd-tab-2", &cwd, None);

        let r1 = spawn_tab_pty(&sessions, &bus, with_cmd.clone());
        let r2 = spawn_tab_pty(&sessions, &bus, without_cmd.clone());
        assert!(r1.is_ok(), "spawn with startup_command failed: {r1:?}");
        assert!(r2.is_ok(), "spawn without startup_command failed: {r2:?}");

        let count = poll_tail_for(
            &sessions,
            &with_cmd.tab_id,
            "__VERNE_RESUMED__",
            Duration::from_secs(2),
        );
        assert_eq!(count, 1, "expected marker exactly once");

        // Give the shell-only tab equal time to (not) produce the marker.
        let none_count = poll_tail_for(
            &sessions,
            &without_cmd.tab_id,
            "__VERNE_RESUMED__",
            Duration::from_millis(500),
        );
        assert_eq!(none_count, 0, "marker must never appear without startup_command");

        let _ = kill_tab_pty(&sessions, &with_cmd.tab_id);
        let _ = kill_tab_pty(&sessions, &without_cmd.tab_id);
    }

    #[test]
    fn multiline_startup_command_is_rejected_before_spawn() {
        let sessions = Arc::new(Mutex::new(SessionManager::new()));
        let bus = Arc::new(EventBus::new());
        let cwd = std::env::temp_dir().to_string_lossy().to_string();

        let plan = base_plan(
            "startup-cmd-tab-multiline",
            &cwd,
            Some("echo one\necho two".to_string()),
        );

        let result = spawn_tab_pty(&sessions, &bus, plan.clone());
        assert!(result.is_err(), "multiline startup_command must be rejected");

        // No session should have been spawned.
        let sm = sessions.lock().unwrap();
        assert!(sm.get_session_by_agent(&plan.tab_id).is_none());
    }
}
