use std::fs;
use std::path::PathBuf;

/// Daemon single-instance lock (`verne.pid`). SIGTERM cleanup removes the pid
/// file only; hooks are owned by Electron (slice 4).
pub fn acquire_single_instance_lock() -> Result<(), String> {
    acquire_lock(crate::paths::pid_file_path())
}

/// Sidecar single-instance lock (`verne-sidecar.pid`). Hook uninstall on SIGTERM
/// is handled by Electron's before-quit (slice 4).
pub fn acquire_sidecar_lock() -> Result<(), String> {
    acquire_lock(crate::paths::sidecar_pid_file_path())
}

fn acquire_lock(pid_path: PathBuf) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(&pid_path) {
        if let Ok(pid) = existing.trim().parse::<i32>() {
            if process_alive(pid) {
                return Err(format!("already running (pid {pid})"));
            }
        }
    }

    let me = std::process::id();
    fs::write(&pid_path, me.to_string()).map_err(|e| e.to_string())?;

    let pid_path_cleanup = pid_path.clone();
    let _ = ctrlc::set_handler(move || {
        let _ = fs::remove_file(&pid_path_cleanup);
        std::process::exit(0);
    });

    Ok(())
}

fn process_alive(pid: i32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid), None).is_ok()
}
