//! The lean `verne` daemon — owns live PTY sessions, agent status, and the
//! WebSocket streaming bridge. Detached from Electron; survives app
//! restarts. Everything else (DB, git, hooks, search, watchers, shadow, …) lives
//! in the sidecar. The `rpc_server` / `tabs` modules here host the *sidecar's*
//! dispatch + DB tab logic (kept in this crate so paths resolve); the daemon
//! process itself uses `rpc_daemon`.

pub mod rpc_server; // sidecar dispatch (full surface)
pub mod rpc_daemon; // daemon dispatch (PTY/detect)
pub mod lifecycle;
pub mod tabs; // sidecar tab row logic
pub mod tab_pty; // daemon PTY spawn/kill
pub mod hook_receiver; // daemon hook HTTP listener
pub mod agent_status; // daemon-owned identity/state engine

/// Run the lean daemon: WS terminal bridge, hooks, status, and PTY RPC.
/// It stays DB-free; Electron persists presentation snapshots only.
pub fn run() {
    env_logger::init();
    let internal_dir = crate::paths::internal_data_dir();
    std::fs::create_dir_all(&internal_dir).expect("internal data dir");

    if let Err(e) = lifecycle::acquire_single_instance_lock() {
        eprintln!("verne daemon: {e}");
        std::process::exit(1);
    }

    // Release builds get a minimal launchd PATH; resolve the user's login PATH
    // so spawned shells behave like a normal terminal.
    #[cfg(not(debug_assertions))]
    {
        let p = crate::services::session_manager::shell_path();
        if !p.is_empty() {
            std::env::set_var("PATH", p);
        }
    }

    let ws_port: u16 = crate::paths::ws_port();
    let state = std::sync::Arc::new(crate::state::DaemonState::new(ws_port));

    log::info!("verne daemon starting (ws port {ws_port})");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // WS server (terminal I/O). Bind BEFORE the RPC socket so a port
        // conflict (another daemon owns the port) exits up front rather than
        // leaving a daemon whose RPC works but whose terminals are dead.
        {
            let sessions = std::sync::Arc::clone(&state.sessions);
            let listener = crate::services::ws_server::bind_ws(ws_port).await;
            tokio::spawn(async move {
                crate::services::ws_server::serve_ws(listener, sessions).await;
            });
        }

        // Hook HTTP receiver. Bind before the RPC serve so the port is stored
        // in DaemonState before Electron can call `__get_hook_config`.
        {
            let secret = state.hook_secret.lock().map(|g| g.clone()).unwrap_or_default();
            let desired = crate::paths::hook_port();
            let port = crate::daemon::hook_receiver::start(
                std::sync::Arc::clone(&state.sessions),
                std::sync::Arc::clone(&state.event_bus),
                secret,
                desired,
            )
            .await;
            state.hook_port.store(port, std::sync::atomic::Ordering::Relaxed);
        }

        crate::daemon::agent_status::start(
            std::sync::Arc::clone(&state.sessions),
            std::sync::Arc::clone(&state.event_bus),
        );

        // RPC server (blocks). Agent detection runs inside this persistent
        // daemon so Electron restarts cannot reset authority.
        let bus = state.event_bus.clone();
        crate::rpc_serve::serve(
            crate::paths::socket_path(),
            state,
            bus,
            rpc_daemon::dispatch,
        )
        .await;
    });
}
