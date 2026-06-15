pub mod paths;
pub mod protocol;
pub mod daemon;
pub mod sidecar;
pub mod db;
pub mod emitter;
pub mod rpc_serve;
pub mod notes;
pub mod services;
pub mod settings;
pub mod state;
pub mod types;

/// Bump RLIMIT_NOFILE soft limit. macOS launches GUI/forked processes with a
/// 256-fd soft cap (`launchctl limit maxfiles`); with file watchers, PTYs,
/// sockets, kqueue, db, etc this is easy to exhaust → openpty()/git open return
/// EMFILE. Hard limit on macOS is "unlimited", so raise to a fixed ceiling.
///
/// macOS gotcha: `setrlimit(NOFILE)` returns EINVAL if rlim_cur exceeds
/// `kern.maxfilesperproc`, and the failure is otherwise silent — so we clamp to
/// that kernel cap and back off until a value sticks rather than blindly asking
/// for a number the kernel rejects (which would leave the low default in place).
pub fn raise_fd_limit() {
    #[cfg(unix)]
    unsafe {
        let mut rl: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) != 0 {
            return;
        }

        let mut want: libc::rlim_t = 65536;

        #[cfg(target_os = "macos")]
        {
            let mut cap: libc::c_int = 0;
            let mut sz = std::mem::size_of::<libc::c_int>();
            if libc::sysctlbyname(
                b"kern.maxfilesperproc\0".as_ptr() as *const libc::c_char,
                &mut cap as *mut _ as *mut libc::c_void,
                &mut sz,
                std::ptr::null_mut(),
                0,
            ) == 0
                && cap > 0
            {
                want = want.min(cap as libc::rlim_t);
            }
        }
        if rl.rlim_max != libc::RLIM_INFINITY {
            want = want.min(rl.rlim_max);
        }
        if want <= rl.rlim_cur {
            return; // already at or above target
        }

        // Back off until one sticks — kernels can reject specific values.
        let mut cur = want;
        loop {
            let new = libc::rlimit { rlim_cur: cur, rlim_max: rl.rlim_max };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &new) == 0 {
                eprintln!("raise_fd_limit: RLIMIT_NOFILE soft limit → {cur}");
                return;
            }
            if cur <= rl.rlim_cur.saturating_add(1024) {
                eprintln!(
                    "raise_fd_limit: could not raise RLIMIT_NOFILE above {}",
                    rl.rlim_cur
                );
                return;
            }
            cur /= 2;
        }
    }
}
