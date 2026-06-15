//! Foreground-process identification for the detection loop. The prior
//! libproc-based approach was fooled by claude-code's `setproctitle`
//! (returned the version string).
//!
//! Key insight: `proc_bsdinfo.pbi_comm` (the kernel-tracked executable name)
//! is immune to `setproctitle`; `libproc::proc_pid::name` reads a *different*
//! field that IS settable. We read pbi_comm directly via `proc_pidinfo`.
//! We also read argv via `sysctl(KERN_PROCARGS2)` so we can identify agents
//! launched via wrappers (e.g. `node /path/to/claude-code/cli.js`).

use std::os::fd::RawFd;

#[derive(Debug)]
pub struct ForegroundProcess {
    pub pid: u32,
    /// Kernel-tracked executable basename (proc_bsdinfo.pbi_comm). 16-char limit.
    /// Not modified by setproctitle.
    pub name: String,
    /// argv[0] basename via sysctl. Reflects setproctitle (Node.js
    /// `process.title = "foo"` shows up here). Useful when present, but may
    /// be the wrong identity for self-renaming processes.
    pub argv0: Option<String>,
    /// Full argv vector from KERN_PROCARGS2.
    pub argv: Option<Vec<String>>,
}

/// `tcgetpgrp` on the PTY master fd → foreground process group ID. Cheaper
/// than walking proc_bsdinfo for the shell PID.
pub fn foreground_pgrp(master_fd: RawFd) -> Option<i32> {
    let pg = unsafe { libc::tcgetpgrp(master_fd) };
    if pg < 0 { None } else { Some(pg) }
}

/// Back-compat: collapse a single PID's identity into one string.
/// detection_loop.rs uses this as the FIRST signal; the richer
/// `foreground_processes` path is the FALLBACK when this returns no match.
#[cfg(target_os = "macos")]
pub fn process_name(pid: i32) -> Option<String> {
    bsdinfo(pid as u32).and_then(|info| comm_from_bsdinfo(&info))
}

/// Back-compat path-style identifier — argv0 from sysctl.
#[cfg(target_os = "macos")]
pub fn process_path(pid: i32) -> Option<String> {
    process_argv0_name(pid as u32)
}

#[cfg(not(target_os = "macos"))]
pub fn process_name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn process_path(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Enumerate every process in `pgrp_id` with its name + argv. Empty on
/// failure or non-macOS (Linux impl would walk /proc/<pid>/{comm,cmdline}).
#[cfg(target_os = "macos")]
pub fn foreground_processes(pgrp_id: i32) -> Vec<ForegroundProcess> {
    let mut out = Vec::new();
    for pid in pgrp_pids(pgrp_id as u32) {
        let Some(info) = bsdinfo(pid) else { continue };
        if info.pbi_pgid != pgrp_id as u32 { continue; }
        let Some(name) = comm_from_bsdinfo(&info) else { continue };
        let argv = process_argv(pid);
        out.push(ForegroundProcess {
            pid,
            name,
            argv0: process_argv0_name(pid),
            argv,
        });
    }
    out
}

#[cfg(not(target_os = "macos"))]
pub fn foreground_processes(_pgrp_id: i32) -> Vec<ForegroundProcess> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// macOS internals
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
const PROC_PGRP_ONLY: u32 = 2;

#[cfg(target_os = "macos")]
fn pgrp_pids(pgrp_id: u32) -> Vec<u32> {
    let mut capacity = 16usize;
    for _ in 0..8 {
        let mut pids = vec![0 as libc::pid_t; capacity];
        let buffer_bytes = pids.len() * std::mem::size_of::<libc::pid_t>();
        let returned_bytes = unsafe {
            libc::proc_listpids(
                PROC_PGRP_ONLY,
                pgrp_id,
                pids.as_mut_ptr() as *mut libc::c_void,
                buffer_bytes as libc::c_int,
            )
        };
        if returned_bytes <= 0 { return Vec::new(); }
        let returned_bytes = returned_bytes as usize;
        let count = returned_bytes / std::mem::size_of::<libc::pid_t>();
        if returned_bytes < buffer_bytes {
            return pids.into_iter().take(count).filter(|p| *p > 0).map(|p| p as u32).collect();
        }
        capacity = capacity.saturating_mul(2);
    }
    Vec::new()
}

#[cfg(target_os = "macos")]
fn bsdinfo(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    (ret == size).then_some(info)
}

#[cfg(target_os = "macos")]
fn comm_from_bsdinfo(info: &libc::proc_bsdinfo) -> Option<String> {
    let end = info.pbi_comm.iter().position(|&b| b == 0).unwrap_or(info.pbi_comm.len());
    if end == 0 { return None; }
    let bytes: Vec<u8> = info.pbi_comm[..end].iter().map(|&b| b as u8).collect();
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "macos")]
fn process_argv0_name(pid: u32) -> Option<String> {
    let buf = kern_procargs2(pid)?;
    if buf.len() < 4 { return None; }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 1 { return None; }
    let rest = &buf[4..];
    let exec_end = rest.iter().position(|&b| b == 0)?;
    let mut pos = exec_end;
    while pos < rest.len() && rest[pos] == 0 { pos += 1; }
    if pos >= rest.len() { return None; }
    let argv0_end = rest[pos..].iter().position(|&b| b == 0).unwrap_or(rest.len() - pos);
    let argv0 = std::str::from_utf8(&rest[pos..pos + argv0_end]).ok()?;
    if argv0.is_empty() { return None; }
    let basename = std::path::Path::new(argv0).file_name()?.to_str()?;
    let name = basename.strip_prefix('-').unwrap_or(basename);
    if name.is_empty() { return None; }
    Some(name.to_string())
}

#[cfg(target_os = "macos")]
fn process_argv(pid: u32) -> Option<Vec<String>> {
    let buf = kern_procargs2(pid)?;
    procargs2_argv(&buf)
}

#[cfg(target_os = "macos")]
fn procargs2_argv(buf: &[u8]) -> Option<Vec<String>> {
    if buf.len() < 4 { return None; }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 1 { return None; }
    let rest = &buf[4..];
    let exec_end = rest.iter().position(|&b| b == 0)?;
    let mut pos = exec_end;
    while pos < rest.len() && rest[pos] == 0 { pos += 1; }
    if pos >= rest.len() { return None; }
    let mut argv = Vec::with_capacity(argc as usize);
    let mut current = pos;
    for _ in 0..argc {
        if current >= rest.len() { return None; }
        let end = rest[current..]
            .iter()
            .position(|&b| b == 0)
            .map(|offset| current + offset)
            .unwrap_or(rest.len());
        if end == current { return None; }
        argv.push(String::from_utf8_lossy(&rest[current..end]).into_owned());
        current = end + 1;
    }
    Some(argv)
}

#[cfg(target_os = "macos")]
fn kern_procargs2(pid: u32) -> Option<Vec<u8>> {
    unsafe {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        let ret = libc::sysctl(
            mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0,
        );
        if ret != 0 || size == 0 { return None; }
        let mut buf = vec![0u8; size];
        let ret = libc::sysctl(
            mib.as_mut_ptr(), 3, buf.as_mut_ptr() as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0,
        );
        if ret != 0 { return None; }
        buf.truncate(size);
        Some(buf)
    }
}
