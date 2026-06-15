//! Sidecar-side tab helpers. Slice 5: Electron owns the tab DB rows (node:sqlite)
//! and orchestrates the lifecycle; the only DB-free piece that stays here is
//! agent-shadow teardown on close (`agent_shadow_cleanup` → `cleanup_agent_shadow`).
//! The live-PTY half lives in the daemon (`daemon::tab_pty`).

use std::sync::Arc;

use crate::state::AppState;

/// Evict the per-tab agent shadow: drop the in-memory entry (holds an open
/// git2::Repository) and remove its on-disk shadow tree. agent_shadows is keyed
/// by agent_id == tab_id. DB-free — slice 5b's Electron `tabs_close` deletes the
/// row itself, then forwards `agent_shadow_cleanup` here for this teardown.
pub fn cleanup_agent_shadow(state: &Arc<AppState>, id: &str) {
    if let Ok(mut shadows) = state.agent_shadows.lock() {
        shadows.remove(id);
    }
    if let Err(e) =
        crate::services::agent_shadow::AgentShadow::cleanup(&state.internal_data_dir, id)
    {
        log::warn!("[tabs] agent shadow cleanup failed for {id}: {e}");
    }
}
