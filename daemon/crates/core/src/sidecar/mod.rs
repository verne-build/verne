//! The `verne-sidecar` process — owns everything that isn't a live PTY: SQLite
//! DB, git + git workers, shadow git, the hook server, file index/search, file
//! and directory watchers, worktrees, settings, notes, MCP registration.
//! Spawned by Electron and torn down with it; freely restartable. The daemon's
//! live PTYs are unaffected by a sidecar restart.

use std::sync::Arc;

pub mod dispatch;

/// Run the sidecar: DB + hooks + the full non-PTY RPC surface on the sidecar
/// socket. No WS server, no PTYs — those belong to the daemon.
pub fn run() {
    env_logger::init();
    let internal_dir = crate::paths::internal_data_dir();
    let user_dir = crate::paths::user_data_dir();
    std::fs::create_dir_all(&internal_dir).expect("internal data dir");
    std::fs::create_dir_all(&user_dir).expect("user data dir");

    {
        let legacy = internal_dir.join("scratchpads");
        let current = internal_dir.join("notes");
        if legacy.is_dir() && !current.exists() {
            if let Err(e) = std::fs::rename(&legacy, &current) {
                log::warn!("notes dir migration (scratchpads→notes) failed: {e}");
            } else {
                log::info!("migrated notes storage dir scratchpads→notes");
            }
        }
    }

    if let Err(e) = crate::daemon::lifecycle::acquire_sidecar_lock() {
        eprintln!("verne-sidecar: {e}");
        std::process::exit(1);
    }

    // Release builds get a minimal launchd PATH; resolve the user's login PATH
    // so shelled-out git/agent tooling behaves like a normal terminal.
    #[cfg(not(debug_assertions))]
    {
        let p = crate::services::session_manager::shell_path();
        if !p.is_empty() {
            std::env::set_var("PATH", p);
        }
    }

    let ws_port: u16 = crate::paths::ws_port();
    // The sidecar no longer opens verne.db — Electron owns it (single writer,
    // via node:sqlite). DB-backed RPCs are shadowed by Electron native handlers;
    // the sidecar serves only DB-free work (git, file index/watch, shadow, …).

    let home_dir = dirs::home_dir().expect("home dir");
    // VERNE_RESOURCE_DIR (set by the Electron supervisor) points bundled assets
    // (LSP servers, notification.mp3) at the app resources dir in packaged
    // builds; fall back to internal_dir.
    let resource_dir = std::env::var_os("VERNE_RESOURCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| internal_dir.clone());

    let app_state = Arc::new(crate::state::AppState::new(
        ws_port,
        resource_dir,
        internal_dir.clone(),
        home_dir,
        None,
    ));

    // Seed the legacy `emitter` slot with a Daemon emitter so code paths that
    // read `state.emitter.lock()` route through the sidecar event bus.
    {
        let em = crate::emitter::Emitter::daemon(app_state.event_bus.clone());
        *app_state.emitter.lock().unwrap() = Some(em);
    }

    log::info!("verne-sidecar starting at {}", internal_dir.display());

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // Hook server startup moved to the daemon (slice 4). Electron writes
        // notify.sh and installs agent hooks using the daemon's port + secret.

        let bus = app_state.event_bus.clone();
        crate::rpc_serve::serve(
            crate::paths::sidecar_socket_path(),
            app_state,
            bus,
            crate::daemon::rpc_server::dispatch_boxed,
        )
        .await;
    });
}
