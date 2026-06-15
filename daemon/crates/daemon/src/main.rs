//! `verne` — the lean, persistent daemon: PTY terminal sessions + WebSocket
//! streaming only. Detached from Electron; survives app restarts. Everything
//! else Rust used to do now lives in the `verne-sidecar` binary.
fn main() {
    verne_core::raise_fd_limit();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--server") {
        verne_core::daemon::run();
        return;
    }
    eprintln!("usage: verne --server");
    std::process::exit(2);
}
