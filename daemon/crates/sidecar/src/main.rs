//! `verne-sidecar` — the heavy, Electron-lifecycle process: DB, git, shadow
//! git, hooks, file search/watch, worktrees, settings, notes. Spawned
//! by Electron and torn down with it; freely restartable without killing PTYs.
fn main() {
    verne_core::raise_fd_limit();
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--server") {
        // Repoint ~/.local/bin/verne[-dev] at THIS sidecar binary so the agent MCP
        // registration (verne_binary() → that symlink → `<bin> mcp`) resolves to the
        // running install. Done here, not in the daemon: only the sidecar serves the
        // `mcp` subcommand, and current_exe() is the sidecar in this branch. Runs on
        // every GUI launch (sidecar is tied to the Electron lifecycle) — newest wins.
        // Best-effort: a failure must not block startup.
        match verne_core::paths::ensure_cli_symlink() {
            Ok(link) => eprintln!("verne-sidecar: cli symlink → {}", link.display()),
            Err(e) => eprintln!("verne-sidecar: cli symlink refresh failed: {e}"),
        }
        verne_core::sidecar::run();
        return;
    }
    eprintln!("usage: verne-sidecar --server");
    std::process::exit(2);
}
