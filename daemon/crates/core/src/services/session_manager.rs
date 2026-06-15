use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::broadcast;

use crate::services::grid_protocol::GridDelta;
use crate::services::terminal_emulator::TerminalEmulator;

/// Minimum gap between grid-delta sends. A burst (program dumping output)
/// coalesces to at most one delta per this interval; a lone post-idle keystroke
/// is NOT delayed by it (it wakes the coalescer and is sent before the sleep).
/// ~8ms ≈ 125Hz ceiling, comfortably under the client's rAF paint cadence.
const MIN_FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Idle wake cadence: with no damage signaled the coalescer still wakes this
/// often to notice its session was dropped (its `Weak` emulator stops upgrading)
/// and exit — so a dead session leaks the thread for at most this long.
const LIVENESS_TICK: Duration = Duration::from_millis(1000);

/// Cross-thread "the emulator changed" signal. The PTY reader sets it after
/// feeding each chunk; the coalescer blocks on it so a keystroke's echo is
/// drained the instant it lands instead of waiting out a fixed poll tick.
struct DamageSignal {
    dirty: Mutex<bool>,
    cv: Condvar,
}

impl DamageSignal {
    fn new() -> Self {
        Self {
            dirty: Mutex::new(false),
            cv: Condvar::new(),
        }
    }

    /// Mark damage and wake the coalescer (if it's waiting).
    fn notify(&self) {
        if let Ok(mut d) = self.dirty.lock() {
            *d = true;
            self.cv.notify_one();
        }
    }

    /// Block until damage is signaled (consuming it) or `timeout` elapses.
    fn wait(&self, timeout: Duration) {
        if let Ok(mut d) = self.dirty.lock() {
            if !*d {
                d = self
                    .cv
                    .wait_timeout(d, timeout)
                    .map(|(g, _)| g)
                    .unwrap_or_else(|e| e.into_inner().0);
            }
            *d = false;
        }
    }
}

/// Spawn the per-session grid coalescer: blocks on `signal` (set by the reader
/// after each PTY chunk) and drains the emulator's accumulated damage into one
/// `GridDelta` for any connected grid (canvas) clients, then enforces a minimum
/// gap so a flood coalesces. Gated on `receiver_count()` so it costs ~nothing
/// while only the byte (xterm) path is in use. Holds a `Weak` to the emulator so
/// it exits once the session is dropped (no explicit stop signal needed).
fn spawn_grid_coalescer(
    emulator: &Arc<Mutex<TerminalEmulator>>,
    grid_tx: broadcast::Sender<Arc<GridDelta>>,
    signal: Arc<DamageSignal>,
) {
    let emu_weak = Arc::downgrade(emulator);
    std::thread::spawn(move || loop {
        signal.wait(LIVENESS_TICK);
        let Some(emu) = emu_weak.upgrade() else { break };
        if grid_tx.receiver_count() > 0 {
            let delta = emu.lock().ok().and_then(|mut e| e.take_delta());
            if let Some(d) = delta {
                let _ = grid_tx.send(Arc::new(d));
            }
        }
        // Bound the send rate so a burst coalesces. This sleep runs AFTER the
        // send above, so the keystroke that woke an idle coalescer already went
        // out with no added wait — only a follow-up within the window is delayed.
        std::thread::sleep(MIN_FLUSH_INTERVAL);
    });
}

/// Server-side emulator scrollback (lines). Comfortably exceeds the client
/// xterm's 2000-line buffer so reattach snapshots aren't truncated.
const EMULATOR_SCROLLBACK: usize = 5000;

/// Number of trailing lines retained for state detection.
const TAIL_CAPACITY: usize = 120;

/// Ring buffer of the last `capacity` lines of PTY output (ANSI-stripped),
/// kept alongside the scrollback so the detection loop can snapshot the
/// terminal tail without intercepting it from the renderer.
pub struct TailBuffer {
    lines: VecDeque<String>,
    current: String,
    capacity: usize,
}

impl TailBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            current: String::new(),
            capacity,
        }
    }

    pub fn push_bytes(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data);
        let stripped = strip_ansi(&text);
        for ch in stripped.chars() {
            match ch {
                '\n' => {
                    let line = std::mem::take(&mut self.current);
                    self.lines.push_back(line);
                    if self.lines.len() > self.capacity {
                        self.lines.pop_front();
                    }
                }
                '\r' => {
                    self.current.clear();
                }
                c if c == '\u{0008}' || c == '\u{007F}' => {
                    self.current.pop();
                }
                c => self.current.push(c),
            }
        }
    }

    /// Joined snapshot of retained lines + the in-progress current line.
    pub fn snapshot(&self) -> String {
        let mut s = String::new();
        for (i, l) in self.lines.iter().enumerate() {
            if i > 0 {
                s.push('\n');
            }
            s.push_str(l);
        }
        if !self.lines.is_empty() {
            s.push('\n');
        }
        s.push_str(&self.current);
        s
    }
}

/// Minimal ANSI stripper: drops CSI (`ESC [ … letter`), OSC (`ESC ] … BEL/ST`),
/// and single-char ESC sequences. Designed to be cheap, not exhaustive — the
/// detection loop tolerates leftover noise.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{001B}' {
            match chars.next() {
                Some('[') => {
                    // CSI: read until final byte (0x40..=0x7E)
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if matches!(nc, '\u{0040}'..='\u{007E}') {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: terminate on BEL or ESC \
                    while let Some(&nc) = chars.peek() {
                        if nc == '\u{0007}' {
                            chars.next();
                            break;
                        }
                        if nc == '\u{001B}' {
                            chars.next();
                            if matches!(chars.peek(), Some('\\')) {
                                chars.next();
                            }
                            break;
                        }
                        chars.next();
                    }
                }
                Some(_) => {} // single-char ESC sequence, swallow next char
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tail_tests {
    use super::*;

    #[test]
    fn keeps_last_n_lines() {
        let mut t = TailBuffer::new(2);
        t.push_bytes(b"one\ntwo\nthree\n");
        assert_eq!(t.snapshot(), "two\nthree\n");
    }

    #[test]
    fn strips_csi_color_codes() {
        let mut t = TailBuffer::new(4);
        t.push_bytes(b"\x1b[31mred\x1b[0m\n");
        assert_eq!(t.snapshot(), "red\n");
    }

    #[test]
    fn handles_backspace() {
        let mut t = TailBuffer::new(2);
        t.push_bytes(b"abc\x08d");
        assert_eq!(t.snapshot(), "abd");
    }

    #[test]
    fn carriage_return_resets_current_line() {
        let mut t = TailBuffer::new(2);
        t.push_bytes(b"hello\rworld");
        assert_eq!(t.snapshot(), "world");
    }
}

/// Get the user's real shell PATH.
/// Bundled macOS apps launched from Finder get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
/// missing node/bun/claude/codex etc. needed for MCP servers + agent detection. We probe
/// the login+interactive shell and union it with the inherited PATH and well-known install
/// dirs so resolution succeeds regardless of where a CLI lives. Cached (OnceLock).
pub fn shell_path() -> String {
    static SHELL_PATH: OnceLock<String> = OnceLock::new();
    SHELL_PATH.get_or_init(compute_shell_path).clone()
}

fn compute_shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    merge_paths(probe_shell_path(&shell).as_deref())
}

/// Run the user's shell as **interactive + login** (`-ilc`) so it sources BOTH
/// `.zprofile`/`.zlogin` AND `.zshrc` — login-only (`-l`) misses `.zshrc`, where
/// nvm/pnpm/homebrew/`~/.local/bin` typically land, which is why a CLI that works
/// in the terminal shows "not detected" in the bundled app. Sentinel-delimited so
/// prompt/MOTD chatter from rc files is discarded; timed out so a slow/hanging rc
/// can't wedge the first caller.
fn probe_shell_path(shell: &str) -> Option<String> {
    use std::sync::mpsc;
    const MARK: &str = "__VERNE_PATH__";
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
    let shell = shell.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(&shell)
            .args(["-ilc", &script])
            .output();
        let _ = tx.send(out);
    });
    let out = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .ok()?
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let value = s.split(MARK).nth(1)?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Union of (probed shell PATH) ∪ (inherited PATH) ∪ (well-known install dirs),
/// order-preserving + de-duped. The fallback dirs catch CLIs even when the shell
/// probe fails (e.g. a non-standard `$SHELL` or a hung rc file).
fn merge_paths(probed: Option<&str>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        for d in raw.split(':') {
            if !d.is_empty() && seen.insert(d.to_string()) {
                dirs.push(d.to_string());
            }
        }
    };
    if let Some(p) = probed {
        push(p);
    }
    if let Ok(p) = std::env::var("PATH") {
        push(&p);
    }
    if let Some(home) = dirs::home_dir() {
        for sub in [
            ".local/bin",
            ".claude/local",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
        ] {
            push(&home.join(sub).to_string_lossy());
        }
    }
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(d);
    }
    dirs.join(":")
}

fn apply_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()),
    );
    cmd.env(
        "LC_CTYPE",
        std::env::var("LC_CTYPE")
            .or_else(|_| std::env::var("LC_ALL"))
            .unwrap_or_else(|_| "en_US.UTF-8".to_string()),
    );
}

/// Max stdin write queue per session (2 MB safety cap)
const STDIN_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Extract an OSC 0 title from a PTY read chunk, reassembling a sequence split
/// across reads via `carry`. Returns the raw title (still including any status
/// glyph) when a complete `ESC ] 0 ; … (BEL|ST)` is seen. Idle/working is
/// derived by the caller from the returned title (`contains('✳')`).
fn osc0_title_from_chunk(data: &[u8], carry: &mut Vec<u8>) -> Option<String> {
    let mut buf = std::mem::take(carry);
    buf.extend_from_slice(data);

    // Parse from the LAST marker so the freshest title wins and a stale,
    // never-terminated marker earlier in the stream can't poison later reads.
    const MARKER: &[u8] = b"\x1b]0;";
    let start = buf.windows(MARKER.len()).rposition(|w| w == MARKER)?;
    let payload = &buf[start + MARKER.len()..];
    let end = payload
        .iter()
        .position(|&b| b == 0x07)
        .or_else(|| payload.windows(2).position(|w| w == b"\x1b\\"));
    match end {
        Some(e) => Some(String::from_utf8_lossy(&payload[..e]).into_owned()),
        None => {
            // Incomplete — stash from the marker for the next read (cap 4 KB).
            let tail = &buf[start..];
            if tail.len() <= 4096 {
                *carry = tail.to_vec();
            }
            None
        }
    }
}

/// Strip a leading status glyph (Claude's ✳ working indicator and friends)
/// plus surrounding whitespace, yielding a stable display name. None if empty.
fn clean_tab_title(raw: &str) -> Option<String> {
    const STATUS: &[char] = &['✳', '✶', '✷', '✻', '·', '*', '◍', '◎', '◉'];
    let trimmed = raw
        .trim()
        .trim_start_matches(|c: char| STATUS.contains(&c) || c.is_whitespace())
        .trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Detect Copilot CLI permission prompt in PTY output.
/// All Copilot approval prompts render a footer with "to navigate" + "to select".
fn is_permission_prompt(data: &[u8]) -> bool {
    if let Ok(text) = std::str::from_utf8(data) {
        text.contains("to navigate") && text.contains("to select")
    } else {
        false
    }
}

#[allow(dead_code)]
pub struct Session {
    pub id: String,
    pub agent_id: String,
    pub child_pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Raw PTY master FD captured at construction. Used by the detection loop
    /// to call `tcgetpgrp` and discover the foreground process group.
    master_fd: Option<RawFd>,
    /// Ring buffer of recent terminal output, ANSI-stripped. Detection loop
    /// snapshots this to feed the manifest detection engine
    /// (`agent_status::manifest::detect`).
    pub tail: Arc<Mutex<TailBuffer>>,
    /// Unix-millis timestamp of the most recent user write into the PTY.
    /// Lets detection_loop transition Blocked → Working as soon as the user
    /// responds to a permission prompt, instead of waiting for PostToolUse.
    pub last_input_at: Arc<std::sync::atomic::AtomicI64>,
    /// Monotonic count of user writes into the PTY. Status arbitration uses
    /// causality rather than timestamps alone so input echo/redraw is not
    /// mistaken for autonomous agent work.
    pub input_sequence: Arc<std::sync::atomic::AtomicU64>,
    /// Unix-millis of the most recent PTY output byte. A genuinely working agent
    /// always emits output (spinner redraws), so detection gates its idle
    /// recovery on output quiescence — a screen-parse regression alone can't
    /// flip a working tab.
    pub last_output_at: Arc<std::sync::atomic::AtomicI64>,
    /// Monotonic count of PTY output chunks.
    pub output_sequence: Arc<std::sync::atomic::AtomicU64>,
    /// Monotonic count of terminal resizes; resize redraw output is user-caused.
    pub resize_sequence: Arc<std::sync::atomic::AtomicU64>,
    /// Current PTY winsize packed as (cols << 16 | rows). `resize` skips the
    /// `TIOCSWINSZ` ioctl when the requested size already matches, because the
    /// kernel raises SIGWINCH on *every* ioctl call even when dimensions are
    /// unchanged — and a backgrounded TUI (Claude Code) re-emits its static
    /// banner on each spurious SIGWINCH (foreground tab mirrors its size onto
    /// background PTYs via `tabResize`). See plans/001.
    current_size: std::sync::atomic::AtomicU32,
    /// Unix-millis of the last interrupt-looking input (Ctrl+C / lone Esc) sent
    /// while the hook state was "working". Claude fires no Stop hook on
    /// interrupt; this lets detection recover faster after a user interrupt.
    pub last_interrupt_at: Arc<std::sync::atomic::AtomicI64>,
    /// Canonical identity/state authority for this PTY.
    pub agent_status: Arc<Mutex<crate::services::agent_status::AgentStatusEngine>>,
    /// Last OSC 0 title parsed off this PTY, cleaned. Written by the reader
    /// thread and returned with canonical hydration snapshots after app relaunch.
    pub last_osc_title: Arc<std::sync::RwLock<Option<String>>>,
    /// Server-authoritative terminal emulator fed every PTY byte. The reader
    /// thread feeds it and the grid coalescer broadcasts deltas under this lock,
    /// so a reattaching grid client's snapshot + delta subscription is a
    /// consistent cut (see `ws_server::handle_grid_connection`).
    pub emulator: Arc<Mutex<TerminalEmulator>>,
    /// Coalesced grid-delta broadcast for canvas (grid-protocol) clients. Fed by
    /// the per-session coalescer; subscribed by `ws_server`'s grid route.
    pub grid_tx: broadcast::Sender<Arc<GridDelta>>,
}

impl Session {
    #[inline]
    fn pack_size(cols: u16, rows: u16) -> u32 {
        ((cols as u32) << 16) | rows as u32
    }

    pub fn pty_master_fd(&self) -> Option<RawFd> {
        self.master_fd
    }

    pub fn last_input_at(&self) -> i64 {
        self.last_input_at
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn last_output_at(&self) -> i64 {
        self.last_output_at
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn last_interrupt_at(&self) -> i64 {
        self.last_interrupt_at
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn write(&self, data: &[u8]) {
        let now = chrono::Utc::now().timestamp_millis();
        self.last_input_at
            .store(now, std::sync::atomic::Ordering::Relaxed);
        self.input_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // Interrupt-looking input (Ctrl+C anywhere, or a lone Esc) to a tab the
        // hooks believe is working: record it so detection can recover the
        // stuck "working" state quickly (no Stop hook fires on interrupt).
        let looks_interrupt = data.contains(&0x03) || data == b"\x1b";
        if looks_interrupt {
            let working = self
                .agent_status
                .lock()
                .map(|g| g.snapshot().agent_state == crate::services::detect::AgentState::Working)
                .unwrap_or(false);
            if working {
                self.last_interrupt_at
                    .store(now, std::sync::atomic::Ordering::Relaxed);
            }
        }
        if data.len() > STDIN_MAX_BYTES {
            log::warn!(
                "stdin write too large ({}B), truncating to {}B",
                data.len(),
                STDIN_MAX_BYTES
            );
            if let Ok(mut w) = self.writer.lock() {
                let _ = w.write_all(&data[..STDIN_MAX_BYTES]);
            }
            return;
        }
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(data);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let packed = Session::pack_size(cols, rows);
        // Skip no-op resizes: TIOCSWINSZ raises SIGWINCH on every call even when
        // the size is unchanged, and a backgrounded TUI re-emits its banner on
        // each spurious SIGWINCH. swap returns the prior value; bail if identical.
        if self
            .current_size
            .swap(packed, std::sync::atomic::Ordering::Relaxed)
            == packed
        {
            return;
        }
        self.resize_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        if let Ok(mut tm) = self.emulator.lock() {
            tm.resize(rows, cols);
        }
    }

    pub fn terminate(&self) {
        // portable-pty's ProcessSignaller only sends SIGHUP to the immediate child PID,
        // leaving Claude CLI's subprocesses (MCP servers, tool subprocs) orphaned to launchd.
        // Negative PID = process group kill. The PTY child is a session leader (setsid in
        // portable-pty's pre_exec), so PGID == child PID and the whole tree dies with it.
        #[cfg(unix)]
        {
            if let Some(pid) = self.child_pid {
                let pgid = -(pid as i32);
                unsafe {
                    libc::kill(pgid, libc::SIGHUP);
                }
                std::thread::spawn(move || {
                    // Grace period for clean shutdown, then reap any survivors that
                    // ignored SIGHUP or escaped via their own setsid().
                    std::thread::sleep(Duration::from_millis(250));
                    // Only escalate if the original child is still alive. After
                    // SIGHUP it may have already exited and been reaped; the OS
                    // could then recycle its PID/PGID, and a blind SIGKILL to
                    // -pgid would hit an unrelated process group. `kill(pid, 0)`
                    // probes existence without signaling (ESRCH once gone).
                    let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
                    if alive {
                        unsafe {
                            libc::kill(pgid, libc::SIGKILL);
                        }
                    }
                });
                return;
            }
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

pub struct SessionManager {
    sessions: HashMap<String, Session>,
    pub active_spawns: Arc<AtomicUsize>,
}

const MAX_CONCURRENT_SPAWNS: usize = 3;

#[allow(dead_code)]
impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            active_spawns: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Clone the spawn-slot counter so callers can acquire/release a slot
    /// WITHOUT holding the SessionManager lock. Acquire blocks until a slot is
    /// free; holding the lock across that wait deadlocks, because in-flight
    /// spawns release their slot only after re-taking the same lock.
    pub fn spawn_slots(&self) -> Arc<AtomicUsize> {
        self.active_spawns.clone()
    }

    /// Block until a spawn slot is free, then atomically claim it. Lock-free
    /// (CAS) so the caller must NOT hold the SessionManager lock. Caller must
    /// pair every acquire with a `release_spawn_slot`.
    pub fn acquire_spawn_slot(slots: &AtomicUsize) {
        loop {
            let cur = slots.load(Ordering::Acquire);
            if cur < MAX_CONCURRENT_SPAWNS {
                if slots
                    .compare_exchange_weak(cur, cur + 1, Ordering::AcqRel, Ordering::Relaxed)
                    .is_ok()
                {
                    return;
                }
                // Lost the race against another acquirer; retry immediately.
            } else {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    pub fn release_spawn_slot(slots: &AtomicUsize) {
        slots.fetch_sub(1, Ordering::AcqRel);
    }

    pub fn get_session(&self, id: &str) -> Option<&Session> {
        self.sessions.get(id)
    }

    /// Apply a new terminal color table to every live session's emulator (theme
    /// change). New sessions pick up the global default at creation.
    pub fn set_all_terminal_colors(&self, colors: crate::services::terminal_emulator::TermColors) {
        for s in self.sessions.values() {
            if let Ok(e) = s.emulator.lock() {
                e.set_colors(colors);
            }
        }
    }

    /// Apply a new default cursor style to every live session's emulator.
    pub fn set_all_terminal_cursor(
        &self,
        shape: alacritty_terminal::vte::ansi::CursorShape,
        blink: bool,
    ) {
        for s in self.sessions.values() {
            if let Ok(mut e) = s.emulator.lock() {
                e.set_default_cursor_style(shape, blink);
            }
        }
    }

    pub fn get_session_by_agent(&self, agent_id: &str) -> Option<&Session> {
        self.sessions.values().find(|s| s.agent_id == agent_id)
    }

    pub fn stop_session(&mut self, session_id: &str) -> bool {
        if let Some(session) = self.sessions.remove(session_id) {
            session.terminate();
            true
        } else {
            false
        }
    }

    pub fn insert_session(&mut self, session: Session) {
        self.sessions.insert(session.id.clone(), session);
    }

    /// All distinct `agent_id`s currently mapped to live sessions. For
    /// terminal tabs, the agent_id is the tab_id.
    pub fn list_agent_ids(&self) -> Vec<String> {
        self.sessions.values().map(|s| s.agent_id.clone()).collect()
    }

    pub fn remove_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn session_count(&self) -> u32 {
        self.sessions.len() as u32
    }

    pub fn agent_child_pids(&self) -> std::collections::HashMap<String, u32> {
        self.sessions
            .values()
            .filter_map(|s| s.child_pid.map(|pid| (s.agent_id.clone(), pid)))
            .collect()
    }

    /// Canonical status snapshots for renderer hydration.
    pub fn effective_agent_states(
        &self,
    ) -> Vec<(
        String,
        crate::services::agent_status::EffectiveAgentStatus,
        Option<String>,
    )> {
        self.sessions
            .values()
            .map(|s| {
                let status = s
                    .agent_status
                    .lock()
                    .map(|g| g.snapshot())
                    .unwrap_or_default();
                let title = s.last_osc_title.read().ok().and_then(|g| g.clone());
                (s.agent_id.clone(), status, title)
            })
            .collect()
    }

    pub fn tab_child_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .values()
            .filter_map(|s| {
                s.child_pid.map(|pid| {
                    let key = s
                        .agent_id
                        .strip_prefix("raw:")
                        .unwrap_or(&s.agent_id)
                        .to_string();
                    (key, pid)
                })
            })
            .collect()
    }
}

pub struct StartSessionOpts {
    pub working_dir: String,
    pub resume: bool,
    pub agent_session_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub skip_permissions: bool,
    /// Extra env vars merged into the spawned child's environment. Phase 5
    /// uses this to preassign provider session ids (e.g. `CLAUDE_SESSION_ID`).
    pub env: HashMap<String, String>,
}

impl StartSessionOpts {
    /// Convenience for callers that don't need extra env.
    pub fn new(
        working_dir: String,
        resume: bool,
        agent_session_id: Option<String>,
        cols: u16,
        rows: u16,
        skip_permissions: bool,
    ) -> Self {
        Self {
            working_dir,
            resume,
            agent_session_id,
            cols,
            rows,
            skip_permissions,
            env: HashMap::new(),
        }
    }
}

/// Start a raw PTY session with a custom command. No Claude-specific logic.
pub fn create_raw_session(
    label: &str,
    command: &str,
    args: &[&str],
    working_dir: &str,
    cols: u16,
    rows: u16,
) -> Result<(String, Session), String> {
    let session_id = format!(
        "raw-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &label[..label.len().min(6)]
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(command);
    for a in args {
        cmd.arg(*a);
    }
    cmd.cwd(working_dir);

    let base_path = shell_path();
    let new_path = match dirs::home_dir() {
        Some(home) => format!("{}:{}", home.join(".local").join("bin").to_string_lossy(), base_path),
        None => base_path,
    };
    cmd.env("PATH", &new_path);
    apply_terminal_env(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    drop(pair.slave);

    let master = Arc::new(Mutex::new(pair.master));
    let master_fd = master.lock().unwrap().as_raw_fd();
    let writer = Arc::new(Mutex::new(
        master
            .lock()
            .unwrap()
            .take_writer()
            .map_err(|e| e.to_string())?,
    ));
    let mut reader = master
        .lock()
        .unwrap()
        .try_clone_reader()
        .map_err(|e| e.to_string())?;

    let tail = Arc::new(Mutex::new(TailBuffer::new(TAIL_CAPACITY)));
    let emulator = Arc::new(Mutex::new(TerminalEmulator::new(
        rows,
        cols,
        EMULATOR_SCROLLBACK,
    )));
    let (grid_tx, _) = broadcast::channel::<Arc<GridDelta>>(256);
    let last_output_at = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let output_sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let session = Session {
        id: session_id.clone(),
        agent_id: format!("raw:{}", label),
        child_pid,
        cols,
        rows,
        killer: killer.clone(),
        writer: writer.clone(),
        master: master.clone(),
        master_fd,
        tail: tail.clone(),
        last_input_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        input_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        last_output_at: last_output_at.clone(),
        output_sequence: output_sequence.clone(),
        resize_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        current_size: std::sync::atomic::AtomicU32::new(Session::pack_size(cols, rows)),
        last_interrupt_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        agent_status: Arc::new(Mutex::new(
            crate::services::agent_status::AgentStatusEngine::default(),
        )),
        // Raw sessions don't parse OSC titles.
        last_osc_title: Arc::new(std::sync::RwLock::new(None)),
        emulator: emulator.clone(),
        grid_tx: grid_tx.clone(),
    };

    let damage = Arc::new(DamageSignal::new());
    spawn_grid_coalescer(&emulator, grid_tx, damage.clone());

    let resp_writer = writer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    last_output_at.store(
                        chrono::Utc::now().timestamp_millis(),
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    output_sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if let Ok(mut t) = tail.lock() {
                        t.push_bytes(&data);
                    }
                    // The emulator is the reattach serialization point: feed it
                    // under its lock so the grid coalescer's snapshot + delta
                    // subscription is a consistent cut (see ws_server).
                    let mut responses = Vec::new();
                    if let Ok(mut tm) = emulator.lock() {
                        tm.process(&data);
                        responses = tm.take_responses();
                    }
                    damage.notify(); // wake the coalescer to drain this chunk now
                                     // Reply to terminal queries (DA/DSR/OSC color) back to the PTY.
                    if !responses.is_empty() {
                        if let Ok(mut w) = resp_writer.lock() {
                            let _ = w.write_all(&responses);
                        }
                    }
                }
            }
        }
    });

    let mut child = child;
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok((session_id, session))
}

/// Start a PTY session. Returns (session_id, broadcast_rx).
/// The caller is responsible for storing the session in SessionManager.
pub fn create_session(
    agent_id: String,
    opts: StartSessionOpts,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_osc_notification: impl Fn(String) + Send + 'static,
    on_title: impl Fn(String) + Send + 'static,
    on_working: impl Fn(bool) + Send + 'static,
    on_attention: impl Fn() + Send + 'static,
    on_resume_working: Arc<dyn Fn() + Send + Sync>,
    on_exit: impl Fn() + Send + 'static,
) -> Result<(String, Session), String> {
    let session_id = format!(
        "s-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        agent_id.chars().take(6).collect::<String>()
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: opts.rows,
            cols: opts.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Tabs always spawn the user's $SHELL. Agents run inside that shell (the
    // user launches them); detection identifies the running agent from the
    // process/screen, not from any pre-declared provider.
    let binary = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&binary);

    cmd.cwd(&opts.working_dir);

    // Common env — use login shell PATH so MCP servers can find node/bun/etc
    let base_path = shell_path();
    let new_path = match dirs::home_dir() {
        Some(home) => format!("{}:{}", home.join(".local").join("bin").to_string_lossy(), base_path),
        None => base_path,
    };
    cmd.env("PATH", &new_path);
    apply_terminal_env(&mut cmd);

    // VERNE_TAB_ID propagates from this PTY's shell into any agent the user
    // runs inside it (claude, codex, etc.). The hook script forwards it as
    // X-Verne-Tab-Id so hook_server can route to the right tab without the
    // session_id heuristic. Provider-launched tabs and shell-only tabs both
    // need this — for shell tabs it's the only deterministic link.
    cmd.env("VERNE_TAB_ID", &agent_id);

    // Phase 5: caller-supplied env (last write wins so it overrides provider defaults).
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let killer = Arc::new(Mutex::new(child.clone_killer()));

    // Drop slave after spawning
    drop(pair.slave);

    let master = Arc::new(Mutex::new(pair.master));
    let master_fd = master.lock().unwrap().as_raw_fd();
    let writer = Arc::new(Mutex::new(
        master
            .lock()
            .unwrap()
            .take_writer()
            .map_err(|e| e.to_string())?,
    ));
    let mut reader = master
        .lock()
        .unwrap()
        .try_clone_reader()
        .map_err(|e| e.to_string())?;

    let tail = Arc::new(Mutex::new(TailBuffer::new(TAIL_CAPACITY)));
    let last_output_at = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let output_sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_osc_title = Arc::new(std::sync::RwLock::new(None::<String>));
    let emulator = Arc::new(Mutex::new(TerminalEmulator::new(
        opts.rows,
        opts.cols,
        EMULATOR_SCROLLBACK,
    )));
    let (grid_tx, _) = broadcast::channel::<Arc<GridDelta>>(256);
    let session = Session {
        id: session_id.clone(),
        agent_id: agent_id.clone(),
        child_pid,
        cols: opts.cols,
        rows: opts.rows,
        killer: killer.clone(),
        writer: writer.clone(),
        master: master.clone(),
        master_fd,
        tail: tail.clone(),
        last_input_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        input_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        last_output_at: last_output_at.clone(),
        output_sequence: output_sequence.clone(),
        resize_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        current_size: std::sync::atomic::AtomicU32::new(Session::pack_size(
            opts.cols, opts.rows,
        )),
        last_interrupt_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        agent_status: Arc::new(Mutex::new(
            crate::services::agent_status::AgentStatusEngine::default(),
        )),
        last_osc_title: last_osc_title.clone(),
        emulator: emulator.clone(),
        grid_tx: grid_tx.clone(),
    };

    let damage = Arc::new(DamageSignal::new());
    spawn_grid_coalescer(&emulator, grid_tx, damage.clone());
    // OSC 0 / permission-prompt detection runs unconditionally now: tabs
    // always spawn the user's shell, but a `claude`/`codex`/`copilot` run inside
    // that shell still emits the same OSC 0 title or permission prompt. Cheap
    // substring scans; only Claude's ✳ title and Copilot's `to navigate`/`to
    // select` footer match.

    // Reader thread — forward PTY output to broadcast + scrollback buffer.
    // Batching happens on the frontend (useTerminal.ts) to coalesce xterm renders.
    let title_cache = last_osc_title;
    let resp_writer = writer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut saw_activity = false;
        let mut osc_carry: Vec<u8> = Vec::new();
        let mut last_title: Option<String> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Err(_) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    last_output_at.store(
                        chrono::Utc::now().timestamp_millis(),
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    output_sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                    // OSC 0 title (Claude et al.) — drives working/idle + bell
                    // and the live tab name.
                    if let Some(raw_title) = osc0_title_from_chunk(&data, &mut osc_carry) {
                        let is_idle = raw_title.contains('✳');
                        if is_idle {
                            on_working(false);
                            if saw_activity {
                                on_osc_notification(String::new());
                            }
                        } else {
                            saw_activity = true;
                            on_working(true);
                            on_resume_working();
                        }
                        if let Some(name) = clean_tab_title(&raw_title) {
                            if last_title.as_deref() != Some(name.as_str()) {
                                last_title = Some(name.clone());
                                if let Ok(mut g) = title_cache.write() {
                                    *g = Some(name.clone());
                                }
                                on_title(name);
                            }
                        }
                    } else if is_permission_prompt(&data) {
                        // Copilot permission prompt — attention signal
                        on_attention();
                    } else if data.len() > 20 {
                        saw_activity = true;
                    }

                    if let Ok(mut t) = tail.lock() {
                        t.push_bytes(&data);
                    }
                    // The emulator is the reattach serialization point: feed it
                    // under its lock so the grid coalescer's snapshot + delta
                    // subscription is a consistent cut.
                    let mut responses = Vec::new();
                    if let Ok(mut tm) = emulator.lock() {
                        tm.process(&data);
                        responses = tm.take_responses();
                    }
                    damage.notify(); // wake the coalescer to drain this chunk now
                    if !responses.is_empty() {
                        if let Ok(mut w) = resp_writer.lock() {
                            let _ = w.write_all(&responses);
                        }
                    }
                    on_data(data);
                }
            }
        }
        on_exit();
    });

    // Wait for child exit in background
    let mut child = child;
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok((session_id, session))
}

/// Write input to a session's PTY.
pub fn write_to_session(session: &Session, data: &[u8]) {
    session.write(data);
}

#[cfg(test)]
mod osc_title_tests {
    use super::*;

    #[test]
    fn extracts_title_bel_terminated() {
        let mut carry = Vec::new();
        assert_eq!(
            osc0_title_from_chunk(b"\x1b]0;Hello\x07", &mut carry),
            Some("Hello".to_string())
        );
        assert!(carry.is_empty());
    }

    #[test]
    fn extracts_title_st_terminated() {
        let mut carry = Vec::new();
        assert_eq!(
            osc0_title_from_chunk(b"\x1b]0;Hi\x1b\\", &mut carry),
            Some("Hi".to_string())
        );
    }

    #[test]
    fn returns_none_when_no_osc0() {
        let mut carry = Vec::new();
        assert_eq!(osc0_title_from_chunk(b"plain output", &mut carry), None);
        assert!(carry.is_empty());
    }

    #[test]
    fn reassembles_split_across_chunks() {
        let mut carry = Vec::new();
        assert_eq!(osc0_title_from_chunk(b"abc\x1b]0;Hel", &mut carry), None);
        assert!(!carry.is_empty()); // partial OSC stashed
        assert_eq!(
            osc0_title_from_chunk(b"lo\x07", &mut carry),
            Some("Hello".to_string())
        );
        assert!(carry.is_empty());
    }

    #[test]
    fn latest_title_wins_within_chunk() {
        // Two complete titles in one read → the freshest (last) is returned.
        let mut carry = Vec::new();
        assert_eq!(
            osc0_title_from_chunk(b"\x1b]0;old\x07\x1b]0;new\x07", &mut carry),
            Some("new".to_string())
        );
    }

    #[test]
    fn stale_unterminated_marker_does_not_poison_next_title() {
        // A prior `\x1b]0;` with no terminator must not corrupt a later real title.
        let mut carry = Vec::new();
        assert_eq!(
            osc0_title_from_chunk(b"\x1b]0;junk-no-end", &mut carry),
            None
        );
        assert!(!carry.is_empty());
        assert_eq!(
            osc0_title_from_chunk(b"\x1b]0;Real\x07", &mut carry),
            Some("Real".to_string())
        );
    }

    #[test]
    fn cleans_status_glyph_prefix() {
        assert_eq!(
            clean_tab_title("✳ Building widget"),
            Some("Building widget".to_string())
        );
        assert_eq!(clean_tab_title("   plain   "), Some("plain".to_string()));
        assert_eq!(clean_tab_title("✳"), None);
        assert_eq!(clean_tab_title(""), None);
    }

    #[test]
    fn idle_derived_from_star_glyph() {
        assert!("✳ working".contains('✳'));
        assert!(!"idle title".contains('✳'));
    }
}

#[cfg(test)]
mod resize_tests {
    use super::*;
    use std::sync::atomic::Ordering::Relaxed;

    #[test]
    fn same_size_resize_is_noop() {
        // Long-lived harmless child so the PTY master stays open.
        let (_id, session) =
            create_raw_session("rsztst", "sleep", &["30"], "/tmp", 80, 24).expect("spawn pty");

        // Same size as construction → no-op, must not bump resize_sequence.
        session.resize(80, 24);
        assert_eq!(session.resize_sequence.load(Relaxed), 0);

        // Genuine change → applies, bumps once.
        session.resize(100, 30);
        assert_eq!(session.resize_sequence.load(Relaxed), 1);

        // Repeat of the new size → no-op again, stays at 1.
        session.resize(100, 30);
        assert_eq!(session.resize_sequence.load(Relaxed), 1);

        session.terminate();
    }
}
