//! Neutral wire types + binary encoders for the grid-streaming terminal
//! protocol. No alacritty dependency: `terminal_emulator` converts its
//! alacritty `Cell`s into these, and this module serializes them. The client
//! (TypeScript) mirrors the byte layout when decoding.

/// Cell color on the wire. Encoded as a 1-byte tag + value:
/// `0` default, `1` + u8 index, `2` + r,g,b.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireColor {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Cell attribute bits (u16, little-endian on the wire).
pub mod flags {
    pub const BOLD: u16 = 1 << 0;
    pub const DIM: u16 = 1 << 1;
    pub const ITALIC: u16 = 1 << 2;
    pub const UNDERLINE: u16 = 1 << 3;
    pub const INVERSE: u16 = 1 << 4;
    pub const STRIKEOUT: u16 = 1 << 5;
    pub const HIDDEN: u16 = 1 << 6;
    pub const WIDE: u16 = 1 << 7;
    /// Cell carries trailing combining marks (zerowidth tail follows).
    pub const ZEROWIDTH: u16 = 1 << 8;
    pub const UNDERCURL: u16 = 1 << 9;
    pub const DOUBLE_UNDERLINE: u16 = 1 << 10;
    pub const DOTTED_UNDERLINE: u16 = 1 << 11;
    pub const DASHED_UNDERLINE: u16 = 1 << 12;
    /// Cell carries an explicit underline color (tagged color tail follows the
    /// zerowidth tail).
    pub const UNDERLINE_COLOR: u16 = 1 << 13;
    /// Cell is part of an OSC-8 hyperlink (URI tail follows the underline-color
    /// tail: `[u16 LE len][utf8 bytes]`).
    pub const HYPERLINK: u16 = 1 << 14;
}

/// One grid cell on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireCell {
    pub ch: char,
    pub fg: WireColor,
    pub bg: WireColor,
    pub flags: u16,
    /// Display width in columns: 1 or 2.
    pub width: u8,
    /// Combining marks (empty for the common case).
    pub zerowidth: Vec<char>,
    /// Explicit underline color (SGR 58); `None` uses the cell foreground.
    pub underline_color: Option<WireColor>,
    /// OSC-8 hyperlink target URI; `None` for the common case.
    pub hyperlink: Option<String>,
}

/// Modes the client needs to behave correctly (mouse routing, scroll disable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireModes {
    pub mouse_reporting: bool,
    /// 1002: report motion while a button is held (drag).
    pub mouse_drag: bool,
    /// 1003: report all motion (even with no button held).
    pub mouse_motion: bool,
    pub alt_screen: bool,
    pub app_cursor: bool,
    pub bracketed_paste: bool,
}

/// A contiguous run of cells starting at `start_col` on visual row `line`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowRun {
    pub line: u16,
    pub start_col: u16,
    pub cells: Vec<WireCell>,
    /// Row soft-wraps into the next (copy joins without newline).
    pub wrapped: bool,
}

/// Full visible-screen snapshot (sent on attach / resize / lag recovery).
#[derive(Debug, Clone)]
pub struct GridSnapshot {
    pub rev: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor: (u16, u16),
    pub modes: WireModes,
    pub total_lines: usize,
    /// Rows evicted off the top of scrollback so far (monotonic). A retained
    /// row's stable absolute id = `base + its visual index`; clients key their
    /// history cache + frozen-scroll anchor by it so streaming eviction doesn't
    /// corrupt scrollback.
    pub base: usize,
    /// Cursor shape (DECSCUSR): "block" | "beam" | "underline" | "hidden".
    pub cursor_shape: &'static str,
    pub cursor_blink: bool,
    /// One entry per visual row, 0..rows.
    pub rows_cells: Vec<Vec<WireCell>>,
    /// Parallel wrap bits: rows_wrapped[i] is true if row i soft-wraps into i+1.
    pub rows_wrapped: Vec<bool>,
}

/// Incremental update: only the damaged row spans since the last delta.
#[derive(Debug, Clone)]
pub struct GridDelta {
    pub rev: u64,
    pub cursor: (u16, u16),
    pub modes: WireModes,
    pub total_lines: usize,
    /// Rows evicted off the top of scrollback so far (monotonic) — see
    /// `GridSnapshot::base`. Lets a frozen client re-anchor across eviction.
    pub base: usize,
    pub cursor_shape: &'static str,
    pub cursor_blink: bool,
    pub runs: Vec<RowRun>,
}

fn encode_color(out: &mut Vec<u8>, c: WireColor) {
    match c {
        WireColor::Default => out.push(0),
        WireColor::Indexed(i) => {
            out.push(1);
            out.push(i);
        }
        WireColor::Rgb(r, g, b) => {
            out.push(2);
            out.extend_from_slice(&[r, g, b]);
        }
    }
}

/// Append one cell's bytes to `out`. Layout:
/// `[u32 LE codepoint][fg tagged][bg tagged][u16 LE flags][u8 width]`
/// then, iff `ZEROWIDTH` is set, `[u8 count][u32 LE codepoint]*count`,
/// then, iff `UNDERLINE_COLOR` is set, `[tagged color]`,
/// then, iff `HYPERLINK` is set, `[u16 LE byte-len][utf8 bytes]`.
pub fn encode_cell(out: &mut Vec<u8>, cell: &WireCell) {
    out.extend_from_slice(&(cell.ch as u32).to_le_bytes());
    encode_color(out, cell.fg);
    encode_color(out, cell.bg);
    let mut flags = cell.flags;
    if !cell.zerowidth.is_empty() {
        flags |= flags::ZEROWIDTH;
    } else {
        flags &= !flags::ZEROWIDTH;
    }
    if cell.underline_color.is_some() {
        flags |= flags::UNDERLINE_COLOR;
    } else {
        flags &= !flags::UNDERLINE_COLOR;
    }
    if cell.hyperlink.is_some() {
        flags |= flags::HYPERLINK;
    } else {
        flags &= !flags::HYPERLINK;
    }
    out.extend_from_slice(&flags.to_le_bytes());
    out.push(cell.width);
    if !cell.zerowidth.is_empty() {
        out.push(cell.zerowidth.len() as u8);
        for c in &cell.zerowidth {
            out.extend_from_slice(&(*c as u32).to_le_bytes());
        }
    }
    if let Some(uc) = cell.underline_color {
        encode_color(out, uc);
    }
    if let Some(uri) = &cell.hyperlink {
        let bytes = uri.as_bytes();
        out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(bytes);
    }
}

/// Append one row run: `[u16 LE line][u16 LE start_col][u16 LE cellCount][u8 wrapped]`
/// then each cell.
pub fn encode_row_run(out: &mut Vec<u8>, run: &RowRun) {
    out.extend_from_slice(&run.line.to_le_bytes());
    out.extend_from_slice(&run.start_col.to_le_bytes());
    out.extend_from_slice(&(run.cells.len() as u16).to_le_bytes());
    out.push(run.wrapped as u8); // [u8 wrapped] — see wire contract
    for cell in &run.cells {
        encode_cell(out, cell);
    }
}

/// Daemon → client frame: `\0` + u32-BE header length + JSON header + payload.
pub fn build_frame(header: &str, payload: &[u8]) -> Vec<u8> {
    let hb = header.as_bytes();
    let mut out = Vec::with_capacity(1 + 4 + hb.len() + payload.len());
    out.push(0);
    out.extend_from_slice(&(hb.len() as u32).to_be_bytes());
    out.extend_from_slice(hb);
    out.extend_from_slice(payload);
    out
}

/// JSON header for modes (camelCase to match the client).
fn modes_json(m: &WireModes) -> serde_json::Value {
    serde_json::json!({
        "mouseReporting": m.mouse_reporting,
        "mouseDrag": m.mouse_drag,
        "mouseMotion": m.mouse_motion,
        "altScreen": m.alt_screen,
        "appCursor": m.app_cursor,
        "bracketedPaste": m.bracketed_paste,
    })
}

/// Serialize a snapshot to a `sync` frame.
pub fn encode_snapshot(snap: &GridSnapshot) -> Vec<u8> {
    let header = serde_json::json!({
        "type": "sync",
        "protocol": 3,
        "rev": snap.rev,
        "cols": snap.cols,
        "rows": snap.rows,
        "cursor": [snap.cursor.0, snap.cursor.1],
        "altScreen": snap.modes.alt_screen,
        "modes": modes_json(&snap.modes),
        "totalLines": snap.total_lines,
        "base": snap.base,
        "cursorShape": snap.cursor_shape,
        "cursorBlink": snap.cursor_blink,
    })
    .to_string();

    let mut payload = Vec::new();
    payload.extend_from_slice(&(snap.rows_cells.len() as u16).to_le_bytes());
    for (line, cells) in snap.rows_cells.iter().enumerate() {
        let wrapped = snap.rows_wrapped.get(line).copied().unwrap_or(false);
        let run = RowRun { line: line as u16, start_col: 0, cells: cells.clone(), wrapped };
        encode_row_run(&mut payload, &run);
    }
    build_frame(&header, &payload)
}

/// Serialize a delta to a `delta` frame.
pub fn encode_delta(delta: &GridDelta) -> Vec<u8> {
    let header = serde_json::json!({
        "type": "delta",
        "rev": delta.rev,
        "cursor": [delta.cursor.0, delta.cursor.1],
        "modes": modes_json(&delta.modes),
        "totalLines": delta.total_lines,
        "base": delta.base,
        "cursorShape": delta.cursor_shape,
        "cursorBlink": delta.cursor_blink,
    })
    .to_string();

    let mut payload = Vec::new();
    payload.extend_from_slice(&(delta.runs.len() as u16).to_le_bytes());
    for run in &delta.runs {
        encode_row_run(&mut payload, run);
    }
    build_frame(&header, &payload)
}

/// Serialize a ranged history reply to a `history` frame. `rows` are visual
/// rows `[from, from+rows.len())`; each entry is `(cells, wrapped)`. `base` is
/// the server's eviction count when read, so the client can key each row by its
/// stable absolute id (`base + from + i`) even if eviction has since shifted.
pub fn encode_history(req_id: u64, from: usize, base: usize, rows: &[(Vec<WireCell>, bool)]) -> Vec<u8> {
    let header = serde_json::json!({
        "type": "history",
        "reqId": req_id,
        "from": from,
        "to": from + rows.len(),
        "base": base,
    })
    .to_string();

    let mut payload = Vec::new();
    payload.extend_from_slice(&(rows.len() as u16).to_le_bytes());
    for (i, (cells, wrapped)) in rows.iter().enumerate() {
        let run = RowRun { line: (from + i) as u16, start_col: 0, cells: cells.clone(), wrapped: *wrapped };
        encode_row_run(&mut payload, &run);
    }
    build_frame(&header, &payload)
}

/// Serialize a search reply to a `searchResult` frame. Matches `(line, col,
/// len)` ride the JSON header; the payload is empty.
pub fn encode_search_result(req_id: u64, matches: &[(usize, usize, usize)], done: bool) -> Vec<u8> {
    let arr: Vec<serde_json::Value> = matches
        .iter()
        .map(|(line, col, len)| serde_json::json!({ "line": line, "col": col, "len": len }))
        .collect();
    let header = serde_json::json!({
        "type": "searchResult",
        "reqId": req_id,
        "matches": arr,
        "done": done,
    })
    .to_string();
    build_frame(&header, &[])
}

#[cfg(test)]
mod measure {
    use super::*;
    use std::time::Instant;

    const COLS: usize = 120;
    const ROWS: usize = 40;

    fn default_modes() -> WireModes {
        WireModes {
            mouse_reporting: false,
            mouse_drag: false,
            mouse_motion: false,
            alt_screen: false,
            app_cursor: false,
            bracketed_paste: false,
        }
    }

    fn plain_cell(ch: char) -> WireCell {
        WireCell {
            ch,
            fg: WireColor::Default,
            bg: WireColor::Default,
            flags: 0,
            width: 1,
            zerowidth: vec![],
            underline_color: None,
            hyperlink: None,
        }
    }

    fn full_snapshot(make: impl Fn(usize, usize) -> WireCell) -> GridSnapshot {
        let rows_cells = (0..ROWS)
            .map(|r| (0..COLS).map(|c| make(r, c)).collect())
            .collect();
        GridSnapshot {
            rev: 1,
            cols: COLS as u16,
            rows: ROWS as u16,
            cursor: (0, 0),
            modes: default_modes(),
            total_lines: ROWS,
            base: 0,
            cursor_shape: "block",
            cursor_blink: false,
            rows_wrapped: vec![false; ROWS],
            rows_cells,
        }
    }

    fn full_delta(make: impl Fn(usize, usize) -> WireCell) -> GridDelta {
        let runs = (0..ROWS)
            .map(|r| RowRun {
                line: r as u16,
                start_col: 0,
                cells: (0..COLS).map(|c| make(r, c)).collect(),
                wrapped: false,
            })
            .collect();
        GridDelta {
            rev: 1,
            cursor: (0, 0),
            modes: default_modes(),
            total_lines: ROWS,
            base: 0,
            cursor_shape: "block",
            cursor_blink: false,
            runs,
        }
    }

    fn report(name: &str, bytes: &[u8], cells: usize) {
        let hdr_len =
            u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let payload = bytes.len() - 5 - hdr_len;
        let per_cell = if cells > 0 { payload as f64 / cells as f64 } else { 0.0 };
        println!(
            "[proto] {name:18} total {:7}B  hdr {:4}B  payload {:7}B  cells {:5}  {:.2} B/cell",
            bytes.len(),
            hdr_len,
            payload,
            cells,
            per_cell
        );
    }

    fn time_encode<T>(name: &str, val: &T, enc: impl Fn(&T) -> Vec<u8>) {
        let n = 2000usize;
        let t = Instant::now();
        let mut sink = 0usize;
        for _ in 0..n {
            sink = sink.wrapping_add(enc(val).len());
        }
        let us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
        println!(
            "[proto] {name:18} encode {us:.2} µs/frame  (n={n}, sink={sink})"
        );
    }

    // ASCII word rotation for delta_flood
    static WORDS: &[&str] = &["ls", "cd", "git", "vim", "top", "man", "cat", "sed"];

    fn ascii_word_char(r: usize, c: usize) -> char {
        let word = WORDS[(r + c) % WORDS.len()];
        let idx = c % word.len();
        word.as_bytes()[idx] as char
    }

    #[test]
    fn protocol_size_and_timing() {
        // --- fixture 1: sync_default ---
        let sync_default = full_snapshot(|_, _| plain_cell(' '));
        let cells_snap = ROWS * COLS;

        // --- fixture 2: delta_flood (ASCII words) ---
        let delta_flood = full_delta(|r, c| plain_cell(ascii_word_char(r, c)));

        // --- fixture 3: delta_truecolor (distinct RGB fg+bg per cell) ---
        let delta_truecolor = full_delta(|r, c| {
            let idx = (r * COLS + c) as u8;
            WireCell {
                ch: ascii_word_char(r, c),
                fg: WireColor::Rgb(idx, (idx / 2).wrapping_add(r as u8), (c as u8).wrapping_mul(3)),
                bg: WireColor::Rgb(
                    (idx).wrapping_add(64),
                    (r as u8).wrapping_mul(5),
                    (c as u8).wrapping_add(128),
                ),
                flags: 0,
                width: 1,
                zerowidth: vec![],
                underline_color: None,
                hyperlink: None,
            }
        });

        // --- fixture 4: delta_typing (1 run, 12 cells) ---
        let typing_cells: Vec<WireCell> = "hello, world"
            .chars()
            .map(|ch| plain_cell(ch))
            .collect();
        let delta_typing = GridDelta {
            rev: 1,
            cursor: (0, 12),
            modes: default_modes(),
            total_lines: ROWS,
            base: 0,
            cursor_shape: "block",
            cursor_blink: false,
            runs: vec![RowRun {
                line: 0,
                start_col: 0,
                cells: typing_cells,
                wrapped: false,
            }],
        };
        let cells_typing = 12;

        // --- fixture 5: sync_hyperlink (every cell linked to a 30-char URI) ---
        let uri_30 = "https://example.com/path/12345"; // exactly 30 chars
        assert_eq!(uri_30.len(), 30, "URI must be exactly 30 chars");
        let sync_hyperlink = full_snapshot(|_, _| WireCell {
            ch: 'H',
            fg: WireColor::Default,
            bg: WireColor::Default,
            flags: 0,
            width: 1,
            zerowidth: vec![],
            underline_color: None,
            hyperlink: Some(uri_30.to_string()),
        });

        // --- fixture 6: delta_cjk (wide chars, width 2) ---
        // CJK unified ideographs start at U+4E00; use a rotation
        let cjk_base = 0x4E00u32;
        // Each wide cell occupies 2 columns visually, so only COLS/2 cells per row
        let cjk_cols = COLS / 2;
        let delta_cjk_runs: Vec<RowRun> = (0..ROWS)
            .map(|r| RowRun {
                line: r as u16,
                start_col: 0,
                cells: (0..cjk_cols)
                    .map(|c| {
                        let cp = char::from_u32(cjk_base + ((r * cjk_cols + c) % 0x4000) as u32)
                            .unwrap_or('中');
                        WireCell {
                            ch: cp,
                            fg: WireColor::Default,
                            bg: WireColor::Default,
                            flags: flags::WIDE,
                            width: 2,
                            zerowidth: vec![],
                            underline_color: None,
                            hyperlink: None,
                        }
                    })
                    .collect(),
                wrapped: false,
            })
            .collect();
        let cells_cjk = ROWS * cjk_cols;
        let delta_cjk = GridDelta {
            rev: 1,
            cursor: (0, 0),
            modes: default_modes(),
            total_lines: ROWS,
            base: 0,
            cursor_shape: "block",
            cursor_blink: false,
            runs: delta_cjk_runs,
        };

        // --- Encode all ---
        let enc_sync_default = encode_snapshot(&sync_default);
        let enc_delta_flood = encode_delta(&delta_flood);
        let enc_delta_truecolor = encode_delta(&delta_truecolor);
        let enc_delta_typing = encode_delta(&delta_typing);
        let enc_sync_hyperlink = encode_snapshot(&sync_hyperlink);
        let enc_delta_cjk = encode_delta(&delta_cjk);

        // --- Size reports ---
        report("sync_default", &enc_sync_default, cells_snap);
        report("delta_flood", &enc_delta_flood, ROWS * COLS);
        report("delta_truecolor", &enc_delta_truecolor, ROWS * COLS);
        report("delta_typing", &enc_delta_typing, cells_typing);
        report("sync_hyperlink", &enc_sync_hyperlink, cells_snap);
        report("delta_cjk", &enc_delta_cjk, cells_cjk);

        // --- Timing ---
        time_encode("sync_default", &sync_default, encode_snapshot);
        time_encode("delta_flood", &delta_flood, encode_delta);
        time_encode("delta_truecolor", &delta_truecolor, encode_delta);
        time_encode("delta_typing", &delta_typing, encode_delta);
        time_encode("sync_hyperlink", &sync_hyperlink, encode_snapshot);
        time_encode("delta_cjk", &delta_cjk, encode_delta);

        // --- Hyperlink dedup estimate ---
        {
            let actual = enc_sync_hyperlink.len();
            // Deduped: one URI entry (2B len + 30B) + per-cell 2B id = 32 + cells_snap*2
            let hdr_len = u32::from_be_bytes([
                enc_sync_hyperlink[1],
                enc_sync_hyperlink[2],
                enc_sync_hyperlink[3],
                enc_sync_hyperlink[4],
            ]) as usize;
            let actual_payload = actual - 5 - hdr_len;
            // base payload without hyperlink data: 9B/cell (cp u32 + fg tag + bg tag + flags u16 + width u8)
            // plus run headers: ROWS * (2+2+2) = 6B each, plus 2B row count
            // We estimate deduped payload = actual_payload - cells_snap*(2+30) + (2+30) + cells_snap*2
            let per_cell_uri_cost = 2 + 30; // u16 len + 30 bytes
            let deduped_payload_est = actual_payload
                .saturating_sub(cells_snap * per_cell_uri_cost)
                + per_cell_uri_cost  // one URI entry
                + cells_snap * 2;   // 2B id per cell
            println!(
                "[proto] sync_hyperlink      actual_payload {:7}B  deduped_est {:7}B  saving {:7}B  ({:.1}%)",
                actual_payload,
                deduped_payload_est,
                actual_payload.saturating_sub(deduped_payload_est),
                100.0 * actual_payload.saturating_sub(deduped_payload_est) as f64
                    / actual_payload as f64
            );
        }

        // --- Write fixture files ---
        let fixtures_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/grid");
        std::fs::create_dir_all(&fixtures_dir)
            .expect("create fixtures dir");

        let fixtures: &[(&str, &[u8], usize)] = &[
            ("sync_default", &enc_sync_default, cells_snap),
            ("delta_flood", &enc_delta_flood, ROWS * COLS),
            ("delta_truecolor", &enc_delta_truecolor, ROWS * COLS),
            ("delta_typing", &enc_delta_typing, cells_typing),
            ("sync_hyperlink", &enc_sync_hyperlink, cells_snap),
            ("delta_cjk", &enc_delta_cjk, cells_cjk),
        ];

        let mut manifest_entries = Vec::new();
        for (name, bytes, cells) in fixtures {
            let path = fixtures_dir.join(format!("{name}.bin"));
            std::fs::write(&path, bytes).expect("write fixture");
            manifest_entries.push(format!(r#"  {{"name": "{name}", "cells": {cells}}}"#));
        }
        let manifest = format!("[\n{}\n]\n", manifest_entries.join(",\n"));
        std::fs::write(fixtures_dir.join("manifest.json"), manifest)
            .expect("write manifest");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_frame(frame: &[u8]) -> (serde_json::Value, &[u8]) {
        assert_eq!(frame[0], 0);
        let header_len = u32::from_be_bytes(frame[1..5].try_into().unwrap()) as usize;
        let header = serde_json::from_slice(&frame[5..5 + header_len]).unwrap();
        (header, &frame[5 + header_len..])
    }

    fn one_cell(ch: char) -> WireCell {
        WireCell { ch, fg: WireColor::Default, bg: WireColor::Default, flags: 0, width: 1, zerowidth: vec![], underline_color: None, hyperlink: None }
    }

    #[test]
    fn encodes_plain_default_cell() {
        let cell = one_cell('A');
        let mut out = Vec::new();
        encode_cell(&mut out, &cell);
        // 'A' = 0x41 LE u32, fg tag 0, bg tag 0, flags 0 (u16 LE), width 1
        assert_eq!(out, vec![0x41, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn encodes_indexed_and_rgb_colors() {
        let cell = WireCell {
            ch: 'x',
            fg: WireColor::Indexed(9),
            bg: WireColor::Rgb(1, 2, 3),
            flags: 0,
            width: 1,
            zerowidth: vec![],
            underline_color: None,
            hyperlink: None,
        };
        let mut out = Vec::new();
        encode_cell(&mut out, &cell);
        // 'x'=0x78 LE, fg: tag1 idx9, bg: tag2 1,2,3, flags 0, width 1
        assert_eq!(out, vec![0x78, 0, 0, 0, 1, 9, 2, 1, 2, 3, 0, 0, 1]);
    }

    #[test]
    fn encodes_flags_and_width() {
        let cell = WireCell {
            ch: 'W',
            fg: WireColor::Default,
            bg: WireColor::Default,
            flags: flags::BOLD | flags::WIDE,
            width: 2,
            zerowidth: vec![],
            underline_color: None,
            hyperlink: None,
        };
        let mut out = Vec::new();
        encode_cell(&mut out, &cell);
        let expected_flags = (flags::BOLD | flags::WIDE).to_le_bytes();
        // layout: u32 cp (0..4), fg tag (4), bg tag (5), u16 flags (6..8), width (8)
        assert_eq!(out[6..8], expected_flags);
        assert_eq!(*out.last().unwrap(), 2u8);
    }

    #[test]
    fn encodes_zerowidth_tail_and_sets_flag() {
        let cell = WireCell {
            ch: 'e',
            fg: WireColor::Default,
            bg: WireColor::Default,
            flags: 0,
            width: 1,
            zerowidth: vec!['\u{0301}'],
            underline_color: None,
            hyperlink: None,
        };
        let mut out = Vec::new();
        encode_cell(&mut out, &cell);
        let flags = u16::from_le_bytes([out[6], out[7]]);
        assert!(flags & flags::ZEROWIDTH != 0, "zerowidth flag not set");
        // after u32 cp (0..4), fg (4), bg (5), flags (6..8), width (8): tail at 9
        let tail = &out[9..];
        assert_eq!(tail[0], 1);
        assert_eq!(u32::from_le_bytes([tail[1], tail[2], tail[3], tail[4]]), 0x0301);
    }

    #[test]
    fn encodes_hyperlink_tail_and_sets_flag() {
        let mut cell = one_cell('L');
        cell.hyperlink = Some("https://x.io".to_string());
        let mut out = Vec::new();
        encode_cell(&mut out, &cell);
        let flags = u16::from_le_bytes([out[6], out[7]]);
        assert!(flags & flags::HYPERLINK != 0, "hyperlink flag not set");
        // after cp(0..4), fg(4), bg(5), flags(6..8), width(8): URI tail at 9.
        let len = u16::from_le_bytes([out[9], out[10]]) as usize;
        assert_eq!(len, "https://x.io".len());
        assert_eq!(&out[11..11 + len], b"https://x.io");
    }

    #[test]
    fn encodes_row_run_header_then_cells() {
        let run = RowRun { line: 3, start_col: 2, cells: vec![one_cell('Z')], wrapped: false };
        let mut out = Vec::new();
        encode_row_run(&mut out, &run);
        // [u16 LE line=3][u16 LE start_col=2][u16 LE cellCount=1][u8 wrapped=0]
        assert_eq!(out[0..7], [3, 0, 2, 0, 1, 0, 0]);
        // first cell byte: 'Z' = 0x5a
        assert_eq!(out[7], 0x5a);
    }

    #[test]
    fn wrapped_byte_position_and_value() {
        // wrapped=true → byte 1 at offset 6 (after u16 line, u16 start_col, u16 cellCount)
        let run_w = RowRun { line: 0, start_col: 0, cells: vec![one_cell('A')], wrapped: true };
        let mut out = Vec::new();
        encode_row_run(&mut out, &run_w);
        assert_eq!(out[6], 1, "wrapped=true must encode as byte 1 after cellCount");

        // wrapped=false → byte 0
        let run_f = RowRun { line: 0, start_col: 0, cells: vec![one_cell('A')], wrapped: false };
        let mut out2 = Vec::new();
        encode_row_run(&mut out2, &run_f);
        assert_eq!(out2[6], 0, "wrapped=false must encode as byte 0");
    }

    #[test]
    fn build_frame_wraps_header_and_payload() {
        let f = build_frame("{\"type\":\"x\"}", b"PAY");
        let (header, payload) = split_frame(&f);
        assert_eq!(header["type"], "x");
        assert_eq!(payload, b"PAY");
    }

    #[test]
    fn encode_snapshot_has_sync_header_and_row_payload() {
        let snap = GridSnapshot {
            rev: 7,
            cols: 4,
            rows: 1,
            cursor: (0, 2),
            modes: WireModes { mouse_reporting: false, mouse_drag: false, mouse_motion: false, alt_screen: false, app_cursor: true, bracketed_paste: false },
            total_lines: 9,
            base: 4,
            cursor_shape: "block",
            cursor_blink: false,
            rows_cells: vec![vec![one_cell('h'), one_cell('i')]],
            rows_wrapped: vec![false],
        };
        let frame = encode_snapshot(&snap);
        let (header, payload) = split_frame(&frame);
        assert_eq!(header["type"], "sync");
        assert_eq!(header["protocol"], 3);
        assert_eq!(header["rev"], 7);
        assert_eq!(header["cols"], 4);
        assert_eq!(header["rows"], 1);
        assert_eq!(header["cursor"], serde_json::json!([0, 2]));
        assert_eq!(header["totalLines"], 9);
        assert_eq!(header["base"], 4);
        assert_eq!(header["modes"]["appCursor"], true);
        assert_eq!(payload[0..2], [1, 0]);
    }

    #[test]
    fn encode_search_result_carries_matches_in_header() {
        let frame = encode_search_result(3, &[(1, 2, 4), (5, 0, 4)], true);
        let (header, payload) = split_frame(&frame);
        assert_eq!(header["type"], "searchResult");
        assert_eq!(header["reqId"], 3);
        assert_eq!(header["done"], true);
        assert_eq!(header["matches"][0]["line"], 1);
        assert_eq!(header["matches"][0]["col"], 2);
        assert_eq!(header["matches"][1]["len"], 4);
        assert!(payload.is_empty());
    }

    #[test]
    fn encode_history_has_history_header_and_range() {
        let rows = vec![(vec![one_cell('a')], false), (vec![one_cell('b')], false)];
        let frame = encode_history(5, 10, 3, &rows);
        let (header, payload) = split_frame(&frame);
        assert_eq!(header["type"], "history");
        assert_eq!(header["reqId"], 5);
        assert_eq!(header["from"], 10);
        assert_eq!(header["to"], 12);
        assert_eq!(header["base"], 3);
        assert_eq!(payload[0..2], [2, 0]); // rowCount = 2
    }

    #[test]
    fn encode_delta_has_delta_header_and_runs() {
        let delta = GridDelta {
            rev: 12,
            cursor: (1, 1),
            modes: WireModes { mouse_reporting: true, mouse_drag: false, mouse_motion: false, alt_screen: false, app_cursor: false, bracketed_paste: false },
            total_lines: 20,
            base: 0,
            cursor_shape: "beam",
            cursor_blink: true,
            runs: vec![RowRun { line: 0, start_col: 0, cells: vec![one_cell('x')], wrapped: false }],
        };
        let frame = encode_delta(&delta);
        let (header, payload) = split_frame(&frame);
        assert_eq!(header["type"], "delta");
        assert_eq!(header["rev"], 12);
        assert_eq!(header["modes"]["mouseReporting"], true);
        assert_eq!(payload[0..2], [1, 0]);
    }
}
