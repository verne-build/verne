//! Daemon-side PTY half of tab lifecycle. Given a fully-resolved `TabSpawnPlan`
//! (built by the sidecar from the DB), spawn/track the tab's live shell session.
//! No DB access here — display labels for the `tab-bell` notification ride in on
//! the plan.

use std::sync::{Arc, Mutex};

use crate::services::session_manager::{self, SessionManager, StartSessionOpts};
use crate::state::EventBus;
use crate::types::TabSpawnPlan;

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

    let start_opts = StartSessionOpts {
        working_dir: plan.cwd.clone(),
        resume: false,
        agent_session_id: plan.agent_session_id.clone(),
        cols: 80,
        rows: 50,
        skip_permissions: false,
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
            sid
        };
        exited_flag.store(true, std::sync::atomic::Ordering::SeqCst);
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
