//! Server-authoritative terminal emulator.
//!
//! Feeds raw PTY bytes through an `alacritty_terminal` emulator so the daemon
//! holds the live grid + scrollback. On reattach we serialize this state to a
//! clean escape-sequence snapshot the client renders into a fresh xterm — no
//! duplicated scrollback, and history reflows at the client's current width
//! (we emit soft-wrapped rows as logical lines and let xterm re-wrap).

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, CursorStyle, NamedColor, Processor, Rgb};

use crate::services::grid_protocol::{
    flags as wf, GridDelta, GridSnapshot, RowRun, WireCell, WireColor, WireModes,
};

/// Terminal color table used to answer OSC 10/11/12 + indexed color queries.
/// The 16 ANSI colors + fg/bg/cursor come from the client's active theme (pushed
/// via `set_global_terminal_colors`); the 6×6×6 cube and grayscale ramp are
/// standard and computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermColors {
    pub fg: (u8, u8, u8),
    pub bg: (u8, u8, u8),
    pub cursor: (u8, u8, u8),
    pub ansi: [(u8, u8, u8); 16],
}

impl TermColors {
    /// Sensible dark defaults (used until the client pushes its real theme).
    pub const DARK: TermColors = TermColors {
        fg: (0xd8, 0xd8, 0xd8),
        bg: (0x1e, 0x1e, 0x1e),
        cursor: (0xd8, 0xd8, 0xd8),
        ansi: [
            (0x00, 0x00, 0x00), (0x80, 0x00, 0x00), (0x00, 0x80, 0x00), (0x80, 0x80, 0x00),
            (0x00, 0x00, 0x80), (0x80, 0x00, 0x80), (0x00, 0x80, 0x80), (0xc0, 0xc0, 0xc0),
            (0x80, 0x80, 0x80), (0xff, 0x00, 0x00), (0x00, 0xff, 0x00), (0xff, 0xff, 0x00),
            (0x00, 0x00, 0xff), (0xff, 0x00, 0xff), (0x00, 0xff, 0xff), (0xff, 0xff, 0xff),
        ],
    };

    /// RGB for a color-query index: 0-15 ANSI (themed), 16-231 cube, 232-255
    /// grayscale, 256 fg, 257 bg, 258 cursor.
    fn rgb_for(&self, index: usize) -> Rgb {
        let (r, g, b) = match index {
            0..=15 => self.ansi[index],
            16..=231 => {
                let n = (index - 16) as u8;
                let step = |x: u8| if x == 0 { 0 } else { 55 + 40 * x };
                (step(n / 36), step((n % 36) / 6), step(n % 6))
            }
            232..=255 => {
                let l = 8 + 10 * (index as u8 - 232);
                (l, l, l)
            }
            256 => self.fg,
            257 => self.bg,
            258 => self.cursor,
            _ => self.fg,
        };
        Rgb { r, g, b }
    }
}

/// Process-wide default colors for newly-created emulators. Set once at app
/// startup (and on theme change) before tabs spawn, so an app's very first OSC
/// query — which can precede any client websocket — is answered with the real
/// theme rather than the dark fallback.
static GLOBAL_COLORS: Mutex<TermColors> = Mutex::new(TermColors::DARK);

/// Update the default colors for future emulators (call before spawning tabs).
pub fn set_global_terminal_colors(c: TermColors) {
    *GLOBAL_COLORS.lock().unwrap() = c;
}

fn global_terminal_colors() -> TermColors {
    *GLOBAL_COLORS.lock().unwrap()
}

/// Process-wide default cursor (shape, blink) for new emulators, set from the
/// user's preference. An app's explicit DECSCUSR request still overrides it.
static GLOBAL_CURSOR: Mutex<(CursorShape, bool)> = Mutex::new((CursorShape::Block, false));

/// Map a wire shape string to a `CursorShape` (defaults to block).
pub fn cursor_shape_from_str(s: &str) -> CursorShape {
    match s {
        "beam" => CursorShape::Beam,
        "underline" => CursorShape::Underline,
        _ => CursorShape::Block,
    }
}

pub fn set_global_terminal_cursor(shape: CursorShape, blink: bool) {
    *GLOBAL_CURSOR.lock().unwrap() = (shape, blink);
}

fn global_terminal_cursor() -> (CursorShape, bool) {
    *GLOBAL_CURSOR.lock().unwrap()
}

/// Captures terminal→app replies (DA/DSR via `PtyWrite`, OSC 10/11/12 color
/// queries via `ColorRequest`, text-area size) that alacritty would otherwise
/// hand to a UI. We buffer them so the session can write them back to the PTY —
/// without this, apps that query the terminal (e.g. Codex probing the background
/// color via OSC 11 to pick its theme) get no answer and mis-render.
#[derive(Clone)]
struct ResponseCollector {
    out: Arc<Mutex<Vec<u8>>>,
    /// Current grid size, for `TextAreaSizeRequest` (CSI 14/16/18 t).
    size: Arc<Mutex<(u16, u16)>>,
    /// Color table for answering color queries (shared with the emulator).
    colors: Arc<Mutex<TermColors>>,
}

/// Replies the app hasn't drained yet are capped: a broken app looping color
/// queries must not grow the buffer unbounded. Drained every coalescer tick in
/// normal operation, so the cap only bites runaway loops.
const MAX_RESPONSE_BUF: usize = 64 * 1024;

impl ResponseCollector {
    fn new(size: Arc<Mutex<(u16, u16)>>, colors: Arc<Mutex<TermColors>>) -> Self {
        Self { out: Arc::new(Mutex::new(Vec::new())), size, colors }
    }

    fn push(&self, bytes: &[u8]) {
        let mut out = self.out.lock().unwrap();
        if out.len() + bytes.len() > MAX_RESPONSE_BUF {
            return; // drop: better than unbounded growth
        }
        out.extend_from_slice(bytes);
    }
}

impl EventListener for ResponseCollector {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => {
                self.push(text.as_bytes());
            }
            Event::ColorRequest(index, format) => {
                let rgb = self.colors.lock().unwrap().rgb_for(index);
                self.push(format(rgb).as_bytes());
            }
            Event::TextAreaSizeRequest(format) => {
                let (cols, rows) = *self.size.lock().unwrap();
                // Cell pixel size is client-side; report a typical 8x16 so the
                // pixel-dimension math the app does stays sane.
                let ws = WindowSize {
                    num_lines: rows,
                    num_cols: cols,
                    cell_width: 8,
                    cell_height: 16,
                };
                self.push(format(ws).as_bytes());
            }
            _ => {}
        }
    }
}

/// SGR base index (0-15) for the 16 ANSI named colors; `None` for everything
/// else (default fg/bg, dim/bright aliases, cursor).
fn ansi_index(n: NamedColor) -> Option<u8> {
    use NamedColor::*;
    Some(match n {
        Black => 0,
        Red => 1,
        Green => 2,
        Yellow => 3,
        Blue => 4,
        Magenta => 5,
        Cyan => 6,
        White => 7,
        BrightBlack => 8,
        BrightRed => 9,
        BrightGreen => 10,
        BrightYellow => 11,
        BrightBlue => 12,
        BrightMagenta => 13,
        BrightCyan => 14,
        BrightWhite => 15,
        // Dim variants map to their base ANSI index; the DIM flag (set in
        // cell_to_wire) carries the faintness so the client renders it dimmed.
        DimBlack => 0,
        DimRed => 1,
        DimGreen => 2,
        DimYellow => 3,
        DimBlue => 4,
        DimMagenta => 5,
        DimCyan => 6,
        DimWhite => 7,
        _ => return None,
    })
}

/// True for the faint (Dim*) named-color variants, whose faintness rides the
/// DIM flag on the wire (their base color comes from `ansi_index`).
fn is_dim_named(color: Color) -> bool {
    use NamedColor::*;
    matches!(
        color,
        Color::Named(
            DimBlack
                | DimRed
                | DimGreen
                | DimYellow
                | DimBlue
                | DimMagenta
                | DimCyan
                | DimWhite
                | DimForeground
        )
    )
}


/// A cell counts as a trailing blank (trimmable at line end) when it's a plain
/// space with default background and no visible attributes.
fn is_blank(cell: &Cell) -> bool {
    cell.c == ' '
        && matches!(cell.bg, Color::Named(NamedColor::Background))
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::UNDERLINE | Flags::STRIKEOUT)
}

fn trim_trailing_blanks(cells: &mut Vec<Cell>) {
    while cells.last().map(is_blank).unwrap_or(false) {
        cells.pop();
    }
}

/// A scrollback search hit: logical line, character column, character length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatch {
    pub line: usize,
    pub col: usize,
    pub len: usize,
}

pub struct TerminalEmulator {
    term: Term<ResponseCollector>,
    parser: Processor,
    cols: u16,
    rows: u16,
    emitted: u64,
    rev: u64,
    /// Set by `process`, cleared by `take_delta`. alacritty's `damage()` always
    /// re-reports the cursor line, so without this gate the coalescer would emit
    /// a delta every tick forever. We only emit when real output arrived.
    dirty: bool,
    /// Forces the next `take_delta` to emit a full frame even without terminal
    /// damage. Set when cursor style/blink changes so connected clients pick up
    /// the new cursor immediately (it rides the delta header), not on next output.
    pending_full: bool,
    /// Buffered terminal→app replies (shared with the `Term`'s listener); drained
    /// by `take_responses` and written back to the PTY by the session.
    responses: Arc<Mutex<Vec<u8>>>,
    /// Shared size handed to the listener for size queries.
    size: Arc<Mutex<(u16, u16)>>,
    /// Color table answering color queries (shared with the listener).
    colors: Arc<Mutex<TermColors>>,
    /// Current alacritty config (kept so we can tweak one field — the default
    /// cursor style — and re-apply via `set_options`).
    config: Config,
    /// Retained scrollback depth (visual rows). alacritty is run uncapped during
    /// a `process` so it can't self-evict mid-advance (which would lose the
    /// count); we trim back to this afterwards.
    scrollback_cap: usize,
    /// Visual rows evicted off the top of scrollback since creation, monotonic.
    /// A row's STABLE absolute id = `evicted + visual_index`. Clients key their
    /// history cache and scroll anchor by this so eviction (which shifts content
    /// under fixed visual indices) doesn't corrupt scrollback mid-stream.
    evicted: usize,
    /// Set when a `clear` (ESC[3J) arrived without its trailing ESC[2J in the
    /// same read. That ESC[2J re-pushes the visible screen into scrollback via
    /// alacritty's clear_viewport; if it lands in the NEXT read we must re-zero
    /// history then too. Carries the intent across the read boundary.
    clear_armed: bool,
}

impl TerminalEmulator {
    pub fn new(rows: u16, cols: u16, scrollback: usize) -> Self {
        let (cshape, cblink) = global_terminal_cursor();
        let config = Config {
            scrolling_history: scrollback,
            default_cursor_style: CursorStyle { shape: cshape, blinking: cblink },
            ..Default::default()
        };
        let term_size = TermSize::new(cols as usize, rows as usize);
        let size = Arc::new(Mutex::new((cols, rows)));
        let colors = Arc::new(Mutex::new(global_terminal_colors()));
        let listener = ResponseCollector::new(size.clone(), colors.clone());
        let responses = listener.out.clone();
        let term = Term::new(config.clone(), &term_size, listener);
        Self {
            term,
            parser: Processor::new(),
            cols,
            rows,
            emitted: 0,
            rev: 0,
            dirty: false,
            pending_full: false,
            responses,
            size,
            colors,
            config,
            scrollback_cap: scrollback,
            evicted: 0,
            clear_armed: false,
        }
    }

    /// Update the color table used to answer color queries (theme change).
    pub fn set_colors(&self, c: TermColors) {
        *self.colors.lock().unwrap() = c;
    }

    /// Set the fallback cursor style (user preference); apps' DECSCUSR wins.
    pub fn set_default_cursor_style(&mut self, shape: CursorShape, blink: bool) {
        self.config.default_cursor_style = CursorStyle { shape, blinking: blink };
        self.term.set_options(self.config.clone());
        // Push the change to connected clients on the next coalescer tick (the
        // new cursor rides the delta header) instead of waiting for output.
        self.pending_full = true;
        self.dirty = true;
    }

    pub fn process(&mut self, bytes: &[u8]) {
        // Resting history depth before this batch. A `clear` (ESC[3J →
        // clear_history) or RIS reset purges scrollback wholesale, which our
        // monotonic `evicted`/base model can't express (it only counts top
        // eviction). We zero history + force a full frame below so the client
        // rebuilds — a plain delta would leave it showing stale scrollback.
        let before_history = self.term.grid().history_size();
        // The reliable clear signal is the ESC[3J bytes themselves, NOT a net
        // history shrink: output bundled in the same read (or a small prior
        // scrollback) can mask the shrink. ESC[2J is `clear`'s trailing
        // erase-display, whose clear_viewport re-pushes the screen into history.
        let has_erase_saved = bytes.windows(4).any(|w| w == b"\x1b[3J");
        let has_erase_display = bytes.windows(4).any(|w| w == b"\x1b[2J");
        // Raise the scrollback limit past anything this batch can produce (≤ one
        // new line per byte) so alacritty can't silently evict — and lose the
        // count — mid-advance. Raising only sets a field; rows alloc lazily.
        self.term.grid_mut().update_history(self.scrollback_cap + bytes.len());
        self.parser.advance(&mut self.term, bytes);
        // Trim back to the cap, counting the rows dropped off the top. `evicted`
        // is the stable base clients add to a visual index for an absolute id.
        let over = self
            .term
            .grid()
            .history_size()
            .saturating_sub(self.scrollback_cap);
        if over > 0 {
            self.evicted += over;
            self.term.grid_mut().update_history(self.scrollback_cap);
        } else {
            // Lower the limit back to the resting cap (no rows to drop).
            self.term.grid_mut().update_history(self.scrollback_cap);
        }
        // Zero scrollback on a clear/reset so cleared content is fully gone,
        // dropping the screen alacritty's ESC[2J re-pushes:
        //  - `has_erase_saved`: this read carried ESC[3J → a clear.
        //  - net shrink: RIS reset (ESC c) wipes scrollback without ESC[3J.
        //  - `clear_armed`: a prior read had ESC[3J but not its ESC[2J; that
        //    re-push lands now, so re-zero.
        // Ctrl+L (ESC[2J alone, no ESC[3J) GROWS history, trips none of these,
        // and keeps its scrollback. Force a full frame so clients rebuild + drop
        // stale cache.
        let net_shrink = self.term.grid().history_size() < before_history;
        if has_erase_saved || net_shrink || self.clear_armed {
            self.term.grid_mut().clear_history();
            self.pending_full = true;
        }
        // Carry the clear intent to the next read only when the ESC[2J re-push
        // hasn't happened yet (ESC[3J seen without ESC[2J in this same read).
        self.clear_armed = has_erase_saved && !has_erase_display;
        self.emitted += bytes.len() as u64;
        self.dirty = true;
    }

    /// Visual rows evicted off the top of scrollback since creation (monotonic).
    /// A retained row's stable absolute id = `base() + its visual index`.
    pub fn base(&self) -> usize {
        self.evicted
    }

    /// Drain terminal→app replies accumulated since the last call. The session
    /// writes these back to the PTY so query-issuing apps get their answer.
    pub fn take_responses(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.responses.lock().unwrap())
    }

    /// Total bytes fed via `process` over this model's lifetime. Guarded by the
    /// model's own mutex, so a snapshot + this value read together are a
    /// consistent point in the stream for the reattach handshake.
    pub fn emitted(&self) -> u64 {
        self.emitted
    }

    /// Resize the emulator (mirrors a PTY winsize change). The grid reflows.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        *self.size.lock().unwrap() = (cols, rows);
        self.term.resize(TermSize::new(cols as usize, rows as usize));
    }

    /// Visible cursor position as `(line, column)`, 0-based.
    pub fn cursor(&self) -> (u16, u16) {
        let p = self.term.grid().cursor.point;
        (p.line.0.max(0) as u16, p.column.0 as u16)
    }

    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    /// Cursor shape (DECSCUSR) + blink as wire values. `HollowBlock` (alacritty's
    /// unfocused cursor) isn't reachable here — focus is a client concern, so the
    /// client renders hollow itself when blurred.
    fn cursor_style(&self) -> (&'static str, bool) {
        // DECTCEM (?25l): a program hides the cursor while drawing overlays (menus,
        // popups). `term.cursor_style()` ignores SHOW_CURSOR — only alacritty's
        // renderable-cursor path applies it — so check it here or the client paints
        // a stale block over the overlay.
        if !self.term.mode().contains(TermMode::SHOW_CURSOR) {
            return ("hidden", false);
        }
        let style = self.term.cursor_style();
        let shape = match style.shape {
            CursorShape::Block => "block",
            CursorShape::Beam => "beam",
            CursorShape::Underline => "underline",
            CursorShape::HollowBlock => "hollow",
            CursorShape::Hidden => "hidden",
        };
        (shape, style.blinking)
    }

    /// Current revision (bumped each emitted delta).
    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// Count of logical (unwrapped) lines in history + screen. (Search now works
    /// in visual-row space — see `search`/`grid_total_lines`.)
    pub fn total_logical_lines(&self) -> usize {
        self.logical_cell_lines().len()
    }

    /// Total VISUAL rows: scrollback history + the live screen. This is the
    /// scroll extent the client renders against (no client-side re-wrap, since
    /// the grid is already laid out at the client's width).
    pub fn grid_total_lines(&self) -> usize {
        self.rows as usize + self.term.grid().history_size()
    }

    /// Visual rows `[from, to)` where index 0 is the topmost scrollback row and
    /// the last `rows` indices are the live screen. Clamped to range. Each entry
    /// is `(cells, wrapped)` — cells are the grid width (wide-char spacers
    /// skipped), wrapped is true if the row soft-wraps into the next.
    pub fn visual_rows(&self, from: usize, to: usize) -> Vec<(Vec<WireCell>, bool)> {
        let total = self.grid_total_lines();
        let from = from.min(total);
        let to = to.min(total);
        if from >= to {
            return Vec::new();
        }
        let top = self.term.grid().topmost_line().0; // <= 0
        (from..to)
            .map(|i| {
                let l = top + i as i32;
                (self.wire_row(l), self.row_wrapped(l))
            })
            .collect()
    }

    /// Convert an alacritty cell to its wire representation.
    fn cell_to_wire(cell: &Cell) -> WireCell {
        let mut flags = 0u16;
        let f = cell.flags;
        if f.contains(Flags::BOLD) { flags |= wf::BOLD; }
        if f.contains(Flags::DIM) { flags |= wf::DIM; }
        if f.contains(Flags::ITALIC) { flags |= wf::ITALIC; }
        if f.contains(Flags::UNDERLINE) { flags |= wf::UNDERLINE; }
        if f.contains(Flags::DOUBLE_UNDERLINE) { flags |= wf::DOUBLE_UNDERLINE; }
        if f.contains(Flags::UNDERCURL) { flags |= wf::UNDERCURL; }
        if f.contains(Flags::DOTTED_UNDERLINE) { flags |= wf::DOTTED_UNDERLINE; }
        if f.contains(Flags::DASHED_UNDERLINE) { flags |= wf::DASHED_UNDERLINE; }
        if f.contains(Flags::INVERSE) { flags |= wf::INVERSE; }
        if f.contains(Flags::STRIKEOUT) { flags |= wf::STRIKEOUT; }
        if f.contains(Flags::HIDDEN) { flags |= wf::HIDDEN; }
        let wide = f.contains(Flags::WIDE_CHAR);
        if wide { flags |= wf::WIDE; }
        // Dim-named fg/bg carry their faintness via the DIM flag (their base
        // color is emitted by wire_color).
        if is_dim_named(cell.fg) || is_dim_named(cell.bg) { flags |= wf::DIM; }
        WireCell {
            ch: cell.c,
            fg: Self::wire_color(cell.fg),
            bg: Self::wire_color(cell.bg),
            flags,
            width: if wide { 2 } else { 1 },
            zerowidth: cell.zerowidth().map(|z| z.to_vec()).unwrap_or_default(),
            underline_color: cell.underline_color().map(Self::wire_color),
            hyperlink: cell.hyperlink().map(|h| h.uri().to_string()),
        }
    }

    fn wire_color(color: Color) -> WireColor {
        match color {
            Color::Named(NamedColor::Foreground) | Color::Named(NamedColor::Background) => {
                WireColor::Default
            }
            Color::Named(n) => match ansi_index(n) {
                Some(i) => WireColor::Indexed(i),
                None => WireColor::Default,
            },
            Color::Indexed(i) => WireColor::Indexed(i),
            Color::Spec(rgb) => WireColor::Rgb(rgb.r, rgb.g, rgb.b),
        }
    }

    fn wire_modes(&self) -> WireModes {
        let m = *self.term.mode();
        let mouse = m.contains(TermMode::MOUSE_REPORT_CLICK)
            || m.contains(TermMode::MOUSE_DRAG)
            || m.contains(TermMode::MOUSE_MOTION);
        WireModes {
            mouse_reporting: mouse,
            mouse_drag: m.contains(TermMode::MOUSE_DRAG),
            mouse_motion: m.contains(TermMode::MOUSE_MOTION),
            alt_screen: m.contains(TermMode::ALT_SCREEN),
            app_cursor: m.contains(TermMode::APP_CURSOR),
            bracketed_paste: m.contains(TermMode::BRACKETED_PASTE),
        }
    }

    /// True if grid line soft-wraps into the next (WRAPLINE on its last column).
    fn row_wrapped(&self, line: i32) -> bool {
        let grid = self.term.grid();
        let last = (self.cols as usize).saturating_sub(1);
        grid[Line(line)][Column(last)].flags.contains(Flags::WRAPLINE)
    }

    /// One wire cell per visible column for `line`, skipping wide spacers.
    fn wire_row(&self, line: i32) -> Vec<WireCell> {
        let grid = self.term.grid();
        let row = &grid[Line(line)];
        let mut cells = Vec::with_capacity(self.cols as usize);
        for col in 0..self.cols as usize {
            let cell = &row[Column(col)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            cells.push(Self::cell_to_wire(cell));
        }
        cells
    }

    /// Wire cells for `line` columns `[left, right]` inclusive, skipping wide
    /// spacers.
    fn wire_row_span(&self, line: i32, left: usize, right: usize) -> Vec<WireCell> {
        let grid = self.term.grid();
        let row = &grid[Line(line)];
        let last = (self.cols as usize).saturating_sub(1);
        let right = right.min(last);
        let mut cells = Vec::new();
        for col in left..=right {
            let cell = &row[Column(col)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            cells.push(Self::cell_to_wire(cell));
        }
        cells
    }

    /// Full visible-screen snapshot in wire form.
    pub fn viewport_snapshot(&self) -> GridSnapshot {
        let rows_cells: Vec<Vec<WireCell>> =
            (0..self.rows as i32).map(|l| self.wire_row(l)).collect();
        let rows_wrapped: Vec<bool> =
            (0..self.rows as i32).map(|l| self.row_wrapped(l)).collect();
        GridSnapshot {
            rev: self.rev,
            cols: self.cols,
            rows: self.rows,
            cursor: self.cursor(),
            modes: self.wire_modes(),
            total_lines: self.grid_total_lines(),
            base: self.evicted,
            cursor_shape: self.cursor_style().0,
            cursor_blink: self.cursor_style().1,
            rows_cells,
            rows_wrapped,
        }
    }

    /// Drain accumulated damage into a delta, or `None` if no output arrived
    /// since the last delta. Bumps `rev` only when a delta is produced. The
    /// server keeps the emulator at display_offset 0 (clients scroll locally),
    /// so damage lines are viewport-relative 0..rows.
    pub fn take_delta(&mut self) -> Option<GridDelta> {
        if !self.dirty && !self.pending_full {
            return None;
        }
        // Collect damage bounds to owned values FIRST so the `&mut term` borrow
        // from `damage()` ends before we read the grid via `wire_row*`.
        enum Kind {
            Full,
            Partial(Vec<(usize, usize, usize)>),
        }
        // A pending cursor-style change forces a full frame so the new cursor
        // reaches clients even with no terminal damage.
        let kind = if self.pending_full {
            Kind::Full
        } else {
            match self.term.damage() {
                TermDamage::Full => Kind::Full,
                TermDamage::Partial(iter) => {
                    Kind::Partial(iter.map(|b| (b.line, b.left, b.right)).collect())
                }
            }
        };
        self.term.reset_damage();
        self.dirty = false;
        self.pending_full = false;

        let runs: Vec<RowRun> = match kind {
            Kind::Full => (0..self.rows as i32)
                .map(|l| RowRun {
                    line: l as u16,
                    start_col: 0,
                    cells: self.wire_row(l),
                    wrapped: self.row_wrapped(l),
                })
                .collect(),
            Kind::Partial(list) => {
                let mut runs = Vec::new();
                for (line, left, right) in list {
                    if line >= self.rows as usize {
                        continue;
                    }
                    let l = line as i32;
                    let cells = self.wire_row_span(l, left, right);
                    runs.push(RowRun {
                        line: line as u16,
                        start_col: left as u16,
                        cells,
                        wrapped: self.row_wrapped(l),
                    });
                }
                runs
            }
        };

        if runs.is_empty() {
            return None;
        }
        self.rev += 1;
        let (cursor_shape, cursor_blink) = self.cursor_style();
        Some(GridDelta {
            rev: self.rev,
            cursor: self.cursor(),
            modes: self.wire_modes(),
            total_lines: self.grid_total_lines(),
            base: self.evicted,
            cursor_shape,
            cursor_blink,
            runs,
        })
    }

    /// Logical (unwrapped) lines `[from, to)` as wire cells, clamped to range.
    /// Reuses `logical_cell_lines` (history + screen, WRAPLINE rejoined) so
    /// callers can re-wrap at any client width.
    pub fn history_lines(&self, from: usize, to: usize) -> Vec<Vec<WireCell>> {
        let all = self.logical_cell_lines();
        let from = from.min(all.len());
        let to = to.min(all.len());
        if from >= to {
            return Vec::new();
        }
        all[from..to]
            .iter()
            .map(|cells| cells.iter().map(Self::cell_to_wire).collect())
            .collect()
    }

    /// Substring search over the full scrollback + screen in VISUAL-row space —
    /// the same space the client renders and scrolls in (see `grid_total_lines` /
    /// `visual_rows`). Returns up to `limit` matches as (visual row, visual column,
    /// char len), so each match lines up with the rendered cell. A match that
    /// straddles a soft-wrap boundary spans two visual rows and is not found
    /// (acceptable: the renderer highlights per row). Pass `case_sensitive = false`
    /// (the editor default) for case-insensitive matching.
    pub fn search(&self, query: &str, limit: usize, case_sensitive: bool) -> Vec<SearchMatch> {
        if query.is_empty() {
            return Vec::new();
        }
        let qlen = query.chars().count();
        let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };
        let cols_n = self.cols as usize;
        let total = self.grid_total_lines();
        let grid = self.term.grid();
        let top = grid.topmost_line().0; // <= 0 (topmost scrollback row)
        let mut out = Vec::new();
        for i in 0..total {
            let row = &grid[Line(top + i as i32)];
            // One char per visual column, skipping wide-char spacers; remember each
            // char's visual column so reported columns match the rendered cells.
            let mut chars = String::new();
            let mut cols: Vec<usize> = Vec::new();
            for c in 0..cols_n {
                let cell = &row[Column(c)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                chars.push(cell.c);
                cols.push(c);
            }
            // Case-fold a copy when insensitive; columns are looked up via `cols`,
            // which holds 1:1 for ASCII. Non-ASCII case folding that changes char
            // count is rare in terminals and may shift the column there.
            let text = if case_sensitive { chars } else { chars.to_lowercase() };
            let mut byte_start = 0;
            while let Some(rel) = text[byte_start..].find(&needle) {
                let byte_idx = byte_start + rel;
                let ci = text[..byte_idx].chars().count();
                let col = cols.get(ci).copied().unwrap_or(ci);
                out.push(SearchMatch { line: i, col, len: qlen });
                if out.len() >= limit {
                    return out;
                }
                byte_start = byte_idx + needle.len();
                if byte_start > text.len() {
                    break;
                }
            }
        }
        out
    }

    pub fn is_alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }


    /// All logical lines (history + visible) as cells. Soft-wrapped rows
    /// (WRAPLINE on the last column) are rejoined; trailing blank cells trimmed.
    fn logical_cell_lines(&self) -> Vec<Vec<Cell>> {
        let grid = self.term.grid();
        let last_col = self.cols as usize - 1;
        let top = grid.topmost_line().0;
        let bottom = self.rows as i32 - 1;
        let mut lines: Vec<Vec<Cell>> = Vec::new();
        let mut cur: Vec<Cell> = Vec::new();
        for line in top..=bottom {
            let row = &grid[Line(line)];
            for col in 0..self.cols as usize {
                let cell = &row[Column(col)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                cur.push(cell.clone());
            }
            if !row[Column(last_col)].flags.contains(Flags::WRAPLINE) {
                trim_trailing_blanks(&mut cur);
                lines.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            trim_trailing_blanks(&mut cur);
            lines.push(cur);
        }
        lines
    }

    /// All logical text (history + visible), one logical line per entry.
    pub fn all_text(&self) -> String {
        self.logical_cell_lines()
            .iter()
            .map(|cells| cells.iter().map(|c| c.c).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Plain text of the visible screen, one line per row.
    pub fn screen_text(&self) -> String {
        let grid = self.term.grid();
        let mut out = String::new();
        for line in 0..self.rows as i32 {
            let row = &grid[Line(line)];
            for col in 0..self.cols as usize {
                let cell = &row[Column(col)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                out.push(cell.c);
            }
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_snapshot_captures_screen_and_cursor() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        m.process(b"hi\r\nyo");
        let snap = m.viewport_snapshot();
        assert_eq!(snap.cols, 10);
        assert_eq!(snap.rows, 3);
        assert_eq!(snap.rows_cells.len(), 3);
        assert_eq!(snap.rows_cells[0][0].ch, 'h');
        assert_eq!(snap.rows_cells[0][1].ch, 'i');
        assert_eq!(snap.rows_cells[1][0].ch, 'y');
        assert_eq!(snap.cursor, (1, 2));
    }

    #[test]
    fn osc8_hyperlink_attaches_uri_to_cells() {
        let mut m = TerminalEmulator::new(3, 20, 100);
        // Open OSC-8 (no id), print "ab", then close the link and print "c".
        m.process(b"\x1b]8;;https://example.com\x1b\\ab\x1b]8;;\x1b\\c");
        let snap = m.viewport_snapshot();
        assert_eq!(snap.rows_cells[0][0].ch, 'a');
        assert_eq!(snap.rows_cells[0][0].hyperlink.as_deref(), Some("https://example.com"));
        assert_eq!(snap.rows_cells[0][1].hyperlink.as_deref(), Some("https://example.com"));
        assert_eq!(snap.rows_cells[0][2].ch, 'c');
        assert_eq!(snap.rows_cells[0][2].hyperlink, None);
    }

    #[test]
    fn viewport_snapshot_reports_modes() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        // ?1000 enables mouse reporting; ?1006 only changes its encoding.
        m.process(b"\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h");
        let snap = m.viewport_snapshot();
        assert!(snap.modes.app_cursor);
        assert!(snap.modes.bracketed_paste);
        assert!(snap.modes.mouse_reporting);
        assert!(!snap.modes.alt_screen);
    }

    #[test]
    fn take_delta_none_when_no_change() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        m.process(b"hello");
        let _ = m.take_delta();
        assert!(m.take_delta().is_none(), "no new output should produce no delta");
    }

    #[test]
    fn take_delta_reports_damaged_row_and_bumps_rev() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        let _ = m.take_delta();
        let rev_before = m.rev();
        m.process(b"AB");
        let delta = m.take_delta().expect("output should produce a delta");
        assert!(delta.rev > rev_before, "rev must increase");
        assert_eq!(m.rev(), delta.rev);
        let run = delta.runs.iter().find(|r| r.line == 0).expect("row 0 damaged");
        let text: String = run.cells.iter().map(|c| c.ch).collect();
        assert!(text.starts_with("AB"), "got {text:?}");
    }

    #[test]
    fn cursor_style_change_forces_a_delta_with_no_output() {
        let mut m = TerminalEmulator::new(4, 10, 100);
        let _ = m.take_delta(); // drain initial
        assert!(m.take_delta().is_none(), "no output → no delta");
        m.set_default_cursor_style(CursorShape::Beam, true);
        let d = m.take_delta().expect("cursor change should force a delta");
        assert!(d.cursor_blink, "delta should carry the new blink state");
        assert_eq!(d.cursor_shape, "beam");
    }

    #[test]
    fn default_cursor_style_reflected_in_snapshot() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        m.set_default_cursor_style(CursorShape::Beam, true);
        let snap = m.viewport_snapshot();
        assert_eq!(snap.cursor_shape, "beam");
        assert!(snap.cursor_blink);
    }

    #[test]
    fn hidden_cursor_dectcem_reported_as_hidden() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        assert_eq!(m.viewport_snapshot().cursor_shape, "block", "shown by default");
        m.process(b"\x1b[?25l"); // DECTCEM off — program hides the cursor for an overlay
        assert_eq!(m.viewport_snapshot().cursor_shape, "hidden");
        m.process(b"\x1b[?25h"); // back on
        assert_eq!(m.viewport_snapshot().cursor_shape, "block");
    }

    #[test]
    fn responds_to_osc11_background_query() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        m.process(b"\x1b]11;?\x07");
        let s = String::from_utf8_lossy(&m.take_responses()).to_string();
        assert!(s.contains("11;rgb:"), "expected OSC 11 color reply, got {s:?}");
    }

    #[test]
    fn osc11_reflects_pushed_theme_background() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        m.set_colors(TermColors { bg: (0xff, 0xff, 0xff), ..TermColors::DARK });
        m.process(b"\x1b]11;?\x07");
        let s = String::from_utf8_lossy(&m.take_responses()).to_string();
        assert!(s.contains("ffff/ffff/ffff"), "OSC 11 should report the set bg, got {s:?}");
    }

    #[test]
    fn responds_to_device_attributes_query() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        m.process(b"\x1b[c");
        let resp = m.take_responses();
        assert!(resp.starts_with(b"\x1b[?"), "expected DA reply, got {resp:?}");
    }

    #[test]
    fn truecolor_fg_survives_on_the_wire() {
        // Claude's spinner/hint text uses 24-bit color, e.g. grey 153,153,153 and
        // orange 215,119,87. These must reach the client as Rgb, not collapse to
        // Default (which the client renders as the theme foreground ≈ white).
        let mut m = TerminalEmulator::new(3, 10, 100);
        let _ = m.take_delta();
        m.process(b"\x1b[38;2;153;153;153mG\x1b[38;2;215;119;87mO");
        let delta = m.take_delta().expect("output should produce a delta");
        let run = delta.runs.iter().find(|r| r.line == 0).expect("row 0 damaged");
        let g = run.cells.iter().find(|c| c.ch == 'G').expect("G present");
        let o = run.cells.iter().find(|c| c.ch == 'O').expect("O present");
        assert_eq!(g.fg, WireColor::Rgb(153, 153, 153), "grey truecolor must survive");
        assert_eq!(o.fg, WireColor::Rgb(215, 119, 87), "orange truecolor must survive");
    }

    #[test]
    fn faint_text_carries_dim_flag_on_the_wire() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        let _ = m.take_delta();
        m.process(b"\x1b[2mX"); // SGR 2 = faint
        let delta = m.take_delta().expect("output should produce a delta");
        let run = delta.runs.iter().find(|r| r.line == 0).expect("row 0 damaged");
        let x = run.cells.iter().find(|c| c.ch == 'X').expect("X present");
        assert!(x.flags & wf::DIM != 0, "faint cell must set the DIM wire flag");
    }

    #[test]
    fn history_lines_returns_requested_logical_range() {
        let mut m = TerminalEmulator::new(3, 20, 100);
        for i in 0..8 {
            m.process(format!("line{}\r\n", i).as_bytes());
        }
        let total = m.total_logical_lines();
        assert!(total >= 8, "expected >=8 logical lines, got {total}");
        let rows = m.history_lines(1, 3);
        assert_eq!(rows.len(), 2);
        let l1: String = rows[0].iter().map(|c| c.ch).collect();
        assert_eq!(l1.trim_end(), "line1");
        let l2: String = rows[1].iter().map(|c| c.ch).collect();
        assert_eq!(l2.trim_end(), "line2");
    }

    #[test]
    fn visual_rows_cover_scrollback_then_screen() {
        let mut m = TerminalEmulator::new(3, 20, 100);
        for i in 0..8 {
            m.process(format!("line{}\r\n", i).as_bytes());
        }
        let total = m.grid_total_lines();
        // 8 short lines + trailing prompt row = 9 visual rows (no wrapping); the
        // last 3 are the live screen, the rest scrollback.
        assert!(total >= 9, "expected history + screen, got {total}");
        // Index 0 is the topmost scrollback row.
        let top = m.visual_rows(0, 1);
        assert_eq!(top.len(), 1);
        let l0: String = top[0].0.iter().map(|c| c.ch).collect();
        assert_eq!(l0.trim_end(), "line0");
        // The whole range clamps and the count matches the request span.
        assert_eq!(m.visual_rows(0, total).len(), total);
        assert_eq!(m.visual_rows(total, total + 50).len(), 0);
    }

    #[test]
    fn history_lines_clamps_out_of_range() {
        let mut m = TerminalEmulator::new(3, 20, 100);
        m.process(b"only\r\n");
        let rows = m.history_lines(0, 9999);
        assert!(rows.len() <= m.total_logical_lines());
    }

    #[test]
    fn search_finds_matches_with_char_columns_and_limit() {
        let mut m = TerminalEmulator::new(4, 40, 100);
        m.process(b"alpha Beta\r\nbeta gamma beta\r\n");
        // case-sensitive: only the two lowercase "beta" on line 1
        let hits = m.search("beta", 10, true);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0], SearchMatch { line: 1, col: 0, len: 4 });
        assert_eq!(hits[1], SearchMatch { line: 1, col: 11, len: 4 });
        // case-insensitive: also matches "Beta" on line 0
        let ci = m.search("beta", 10, false);
        assert_eq!(ci.len(), 3);
        assert_eq!(ci[0], SearchMatch { line: 0, col: 6, len: 4 });
        assert_eq!(ci[1], SearchMatch { line: 1, col: 0, len: 4 });
        assert_eq!(ci[2], SearchMatch { line: 1, col: 11, len: 4 });
        // limit caps results
        assert_eq!(m.search("beta", 2, false).len(), 2);
        // empty query → no matches
        assert!(m.search("", 10, false).is_empty());
    }

    #[test]
    fn search_reports_visual_rows_for_wrapped_lines() {
        // 4 columns → "abcdefgh" soft-wraps into visual rows "abcd" / "efgh".
        let mut m = TerminalEmulator::new(4, 4, 100);
        m.process(b"abcdefgh");
        let abcd = m.search("abcd", 10, false);
        let efgh = m.search("efgh", 10, false);
        assert_eq!(abcd.len(), 1);
        assert_eq!(efgh.len(), 1);
        assert_eq!(abcd[0].col, 0);
        assert_eq!(efgh[0].col, 0);
        // The two halves are on adjacent VISUAL rows (the bug: logical search put
        // both on the same rejoined line; visual search separates them).
        assert_eq!(efgh[0].line, abcd[0].line + 1);
        // A query straddling the soft-wrap boundary is not found (per-visual-row).
        assert!(m.search("cdef", 10, false).is_empty());
    }

    #[test]
    fn parses_visible_text() {
        let mut m = TerminalEmulator::new(24, 80, 1000);
        m.process(b"hello world");
        assert_eq!(m.screen_text().lines().next().unwrap().trim_end(), "hello world");
    }

    #[test]
    fn process_tracks_emitted_byte_count() {
        let mut m = TerminalEmulator::new(5, 20, 100);
        m.process(b"hello");
        m.process(b" world");
        assert_eq!(m.emitted(), 11);
    }

    #[test]
    fn clear_scrollback_shrinks_history_and_forces_full_delta() {
        // What the `clear` binary actually writes (verified: ESC[3J then home +
        // erase-display). ESC[3J purges scrollback; ESC[2J re-pushes only the
        // visible screen, so total drops to ~screen height.
        const CLEAR: &[u8] = b"\x1b[3J\x1b[H\x1b[2J";
        let mut m = TerminalEmulator::new(5, 20, 100);
        for i in 0..30 {
            m.process(format!("line {}\r\n", i).as_bytes());
        }
        let _ = m.take_delta(); // drain
        let before = m.grid_total_lines();
        assert!(before > 25, "expected real scrollback, got {before}");

        m.process(CLEAR);
        let after = m.grid_total_lines();
        // Scrollback fully gone: total == screen height.
        assert_eq!(after, m.rows as usize, "clear must zero scrollback: {before} -> {after}");

        // The clear forces a FULL frame (all rows) carrying the new, smaller
        // total so the client can drop stale scrollback — not a partial delta.
        let d = m.take_delta().expect("clear must produce a delta");
        assert_eq!(d.total_lines, after, "delta must carry the zeroed total");
        assert_eq!(d.runs.len(), m.rows as usize, "clear must force a full frame");
    }

    #[test]
    fn clear_split_across_reads_still_zeroes() {
        // Real PTYs can fragment a write across reads. Deliver the clear
        // sequence in two process() calls split between ESC[3J and ESC[2J — the
        // case the single-call test never exercised.
        let mut m = TerminalEmulator::new(5, 20, 100);
        for i in 0..30 {
            m.process(format!("line {}\r\n", i).as_bytes());
        }
        let _ = m.take_delta();
        m.process(b"\x1b[3J\x1b[H");
        m.process(b"\x1b[2J");
        assert_eq!(
            m.grid_total_lines(),
            m.rows as usize,
            "split clear must still zero scrollback"
        );
    }

    #[test]
    fn clear_bundled_with_output_zeroes_even_without_net_shrink() {
        // Young session (little prior scrollback) where a screenful of output and
        // the clear arrive in ONE read: net history does NOT shrink vs the read's
        // start, so shrink-detection alone would miss it. The ESC[3J scan must
        // still zero scrollback.
        let mut m = TerminalEmulator::new(5, 20, 100);
        let mut batch = Vec::new();
        for i in 0..40 {
            batch.extend_from_slice(format!("out {}\r\n", i).as_bytes());
        }
        batch.extend_from_slice(b"\x1b[3J\x1b[H\x1b[2J");
        m.process(&batch);
        assert_eq!(m.grid_total_lines(), m.rows as usize, "bundled clear must zero");
    }

    #[test]
    fn ctrl_l_keeps_scrollback() {
        // Readline's clear-screen (Ctrl+L) sends ESC[H ESC[2J — NO ESC[3J — so
        // it must PRESERVE scrollback (alacritty pushes the screen into history).
        let mut m = TerminalEmulator::new(5, 20, 100);
        for i in 0..30 {
            m.process(format!("line {}\r\n", i).as_bytes());
        }
        let _ = m.take_delta();
        let before = m.grid_total_lines();
        m.process(b"\x1b[H\x1b[2J");
        assert!(m.grid_total_lines() >= before, "Ctrl+L must keep scrollback");
    }

    #[test]
    fn resize_storm_does_not_duplicate_scrollback() {
        let mut m = TerminalEmulator::new(5, 40, 200);
        for i in 0..20 {
            m.process(format!("line number {}\r\n", i).as_bytes());
        }
        // Simulate a resize storm (wide -> narrow -> wide), as happens on reattach.
        m.resize(5, 20);
        m.resize(5, 40);
        m.resize(5, 18);
        m.resize(5, 40);
        let text = m.all_text();
        let count = text.matches("line number 7").count();
        assert_eq!(count, 1, "emulator duplicated scrollback on resize:\n{text}");
    }

    #[test]
    fn resize_reflows_live_grid() {
        let mut m = TerminalEmulator::new(3, 10, 100);
        m.process(b"abcdefghijklmno"); // wraps across 2 rows at width 10
        m.resize(3, 20); // now fits on a single row
        assert_eq!(
            m.screen_text().lines().next().unwrap().trim_end(),
            "abcdefghijklmno"
        );
    }

    #[test]
    fn scrollback_line_keeps_stable_absolute_id_across_eviction() {
        // Stream past the scrollback cap so the ring buffer evicts old rows. A
        // given line's absolute id (base + visual index) must NOT drift as
        // eviction shifts content under fixed visual indices — otherwise the
        // client, which keys its history cache and scroll anchor by visual
        // index, desyncs and scrollback corrupts mid-stream (duplicated rows).
        fn absolute_id_of(m: &TerminalEmulator, needle: &str) -> Option<usize> {
            let total = m.grid_total_lines();
            let rows = m.visual_rows(0, total);
            let idx = rows
                .iter()
                .position(|(cells, _)| cells.iter().map(|c| c.ch).collect::<String>().contains(needle))?;
            Some(m.base() + idx)
        }

        let mut m = TerminalEmulator::new(3, 40, 50); // scrollback cap 50
        for i in 0..120 {
            m.process(format!("marker {} end\r\n", i).as_bytes());
        }
        let before = absolute_id_of(&m, "marker 100 end").expect("retained before");
        // Stream more output; the full ring buffer evicts old top rows.
        for i in 120..140 {
            m.process(format!("marker {} end\r\n", i).as_bytes());
        }
        let after = absolute_id_of(&m, "marker 100 end").expect("still retained");
        assert_eq!(before, after, "line drifted absolute id across eviction");
    }

    #[test]
    fn response_buffer_is_bounded() {
        let mut emu = TerminalEmulator::new(24, 80, 100);
        // An app stuck in a query loop must not grow the reply buffer unbounded.
        for _ in 0..20_000 {
            emu.process(b"\x1b]11;?\x07"); // OSC 11 background-color query
        }
        assert!(emu.take_responses().len() <= 64 * 1024);
    }
}
