//! Server-side input encoding: semantic events from the client become PTY
//! bytes using the emulator's authoritative `TermMode`. Single home for VT
//! key/mouse/paste encoding — the client never emits escape sequences.

use alacritty_terminal::term::TermMode;

/// Keyboard modifiers accompanying a key or mouse event.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
}

impl Mods {
    /// xterm modifier parameter: 1 + bitmask(shift=1, alt=2, ctrl=4, meta=8).
    fn xterm_code(&self) -> u8 {
        1 + (self.shift as u8)
            + ((self.alt as u8) << 1)
            + ((self.ctrl as u8) << 2)
            + ((self.meta as u8) << 3)
    }

    fn any(&self) -> bool {
        self.shift || self.alt || self.ctrl || self.meta
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    Down,
    Up,
    Move,
    WheelUp,
    WheelDown,
}

/// One client → server input event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// Named key (e.g. "ArrowUp", "Enter", "a") + modifiers.
    Key { key: String, mods: Mods },
    /// Committed text / IME result (sent verbatim as UTF-8).
    Text(String),
    /// Bracketed-paste-eligible payload.
    Paste(String),
    /// Mouse event at zero-based cell (col, row).
    Mouse { action: MouseAction, button: u8, col: u16, row: u16, mods: Mods },
}

/// Encode an event to PTY bytes for the given terminal mode.
pub fn encode(event: &InputEvent, mode: TermMode) -> Vec<u8> {
    match event {
        InputEvent::Key { key, mods } => encode_key(key, *mods, mode),
        InputEvent::Text(s) => s.as_bytes().to_vec(),
        InputEvent::Paste(s) => encode_paste(s, mode),
        InputEvent::Mouse { action, button, col, row, mods } => {
            encode_mouse(*action, *button, *col, *row, *mods, mode)
        }
    }
}

/// CSI introducer with an optional modifier parameter: with no mods, `ESC[<final>`
/// (or `ESCO<final>` for cursor keys in app mode); with mods, `ESC[1;<code><final>`.
fn cursor_seq(final_byte: u8, mods: Mods, app_cursor: bool) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[1;{}{}", mods.xterm_code(), final_byte as char).into_bytes()
    } else if app_cursor {
        vec![0x1b, b'O', final_byte]
    } else {
        vec![0x1b, b'[', final_byte]
    }
}

/// Tilde-style key (Home/End/Insert/Delete/PgUp/PgDn/F5+): `ESC[<n>~` or
/// `ESC[<n>;<code>~` with mods.
fn tilde_seq(n: u8, mods: Mods) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[{};{}~", n, mods.xterm_code()).into_bytes()
    } else {
        format!("\x1b[{}~", n).into_bytes()
    }
}

/// Function keys F1-F4: `ESCO<final>` normally, `ESC[1;<code><final>` with mods.
fn ss3_or_mod(final_byte: u8, mods: Mods) -> Vec<u8> {
    if mods.any() {
        format!("\x1b[1;{}{}", mods.xterm_code(), final_byte as char).into_bytes()
    } else {
        vec![0x1b, b'O', final_byte]
    }
}

fn encode_key(key: &str, mods: Mods, mode: TermMode) -> Vec<u8> {
    let app = mode.contains(TermMode::APP_CURSOR);
    match key {
        // Alt/Option+Enter → ESC+CR (meta-modified Enter); agents read it as
        // insert-newline. Plain Enter → CR.
        "Enter" => {
            if mods.alt {
                vec![0x1b, b'\r']
            } else {
                vec![b'\r']
            }
        }
        "Tab" => {
            if mods.shift { b"\x1b[Z".to_vec() } else { vec![b'\t'] }
        }
        // Alt/Option+Backspace → ESC+DEL (readline backward-kill-word); plain → DEL.
        "Backspace" => {
            if mods.alt {
                vec![0x1b, 0x7f]
            } else {
                vec![0x7f]
            }
        }
        "Escape" => vec![0x1b],
        "ArrowUp" => cursor_seq(b'A', mods, app),
        "ArrowDown" => cursor_seq(b'B', mods, app),
        "ArrowRight" => cursor_seq(b'C', mods, app),
        "ArrowLeft" => cursor_seq(b'D', mods, app),
        "Home" => cursor_seq(b'H', mods, app),
        "End" => cursor_seq(b'F', mods, app),
        "Insert" => tilde_seq(2, mods),
        "Delete" => tilde_seq(3, mods),
        "PageUp" => tilde_seq(5, mods),
        "PageDown" => tilde_seq(6, mods),
        "F1" => ss3_or_mod(b'P', mods),
        "F2" => ss3_or_mod(b'Q', mods),
        "F3" => ss3_or_mod(b'R', mods),
        "F4" => ss3_or_mod(b'S', mods),
        "F5" => tilde_seq(15, mods),
        "F6" => tilde_seq(17, mods),
        "F7" => tilde_seq(18, mods),
        "F8" => tilde_seq(19, mods),
        "F9" => tilde_seq(20, mods),
        "F10" => tilde_seq(21, mods),
        "F11" => tilde_seq(23, mods),
        "F12" => tilde_seq(24, mods),
        _ => encode_char_key(key, mods),
    }
}

/// Single-character keys, applying Ctrl (control char) and Alt (ESC prefix).
fn encode_char_key(key: &str, mods: Mods) -> Vec<u8> {
    let mut chars = key.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        // Unknown multi-char key name: nothing to send.
        return Vec::new();
    };
    let mut out = Vec::new();
    if mods.ctrl {
        // Map to control char: @ A..Z [ \ ] ^ _ → 0x00..0x1f.
        let upper = c.to_ascii_uppercase();
        let ctrl = match upper {
            '@'..='_' => Some((upper as u8) & 0x1f),
            ' ' => Some(0),
            _ => None,
        };
        if let Some(b) = ctrl {
            if mods.alt {
                out.push(0x1b);
            }
            out.push(b);
            return out;
        }
    }
    if mods.alt {
        out.push(0x1b);
    }
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    out
}

fn encode_paste(s: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let mut out = Vec::with_capacity(s.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(s.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        s.as_bytes().to_vec()
    }
}

/// Mouse button code per the xterm protocol, folding in wheel + modifiers +
/// the motion bit.
fn mouse_button_code(action: MouseAction, button: u8, mods: Mods, motion: bool) -> u8 {
    let mut code = match action {
        MouseAction::WheelUp => 64,
        MouseAction::WheelDown => 65,
        MouseAction::Up => button & 0b11,
        MouseAction::Down => button & 0b11,
        MouseAction::Move => button & 0b11,
    };
    if motion {
        code += 32;
    }
    if mods.shift { code += 4; }
    if mods.alt { code += 8; }
    if mods.ctrl { code += 16; }
    code
}

fn mouse_reporting_on(mode: TermMode) -> bool {
    mode.contains(TermMode::MOUSE_REPORT_CLICK)
        || mode.contains(TermMode::MOUSE_DRAG)
        || mode.contains(TermMode::MOUSE_MOTION)
        || mode.contains(TermMode::SGR_MOUSE)
}

fn encode_mouse(
    action: MouseAction,
    button: u8,
    col: u16,
    row: u16,
    mods: Mods,
    mode: TermMode,
) -> Vec<u8> {
    if !mouse_reporting_on(mode) {
        return Vec::new();
    }
    let motion = action == MouseAction::Move;
    let code = mouse_button_code(action, button, mods, motion);
    // Protocol coordinates are 1-based.
    let cx = col + 1;
    let cy = row + 1;
    if mode.contains(TermMode::SGR_MOUSE) {
        let final_byte = if action == MouseAction::Up { 'm' } else { 'M' };
        format!("\x1b[<{};{};{}{}", code, cx, cy, final_byte).into_bytes()
    } else {
        // X10: byte values offset by 32; release reported as button 3.
        let btn = if action == MouseAction::Up { 3 + (code & !0b11) } else { code };
        vec![
            0x1b,
            b'[',
            b'M',
            32u8.wrapping_add(btn),
            32u8.wrapping_add(cx.min(223) as u8),
            32u8.wrapping_add(cy.min(223) as u8),
        ]
    }
}

/// Parse a client input frame (JSON) into an `InputEvent`. Shapes:
/// `{"type":"key","key":"ArrowUp","mods":{"ctrl":true}}`,
/// `{"type":"text","text":"..."}`, `{"type":"paste","text":"..."}`,
/// `{"type":"mouse","action":"down","button":0,"col":1,"row":2,"mods":{}}`.
pub fn parse_input_event(v: &serde_json::Value) -> Option<InputEvent> {
    let mods = |v: &serde_json::Value| -> Mods {
        let m = &v["mods"];
        Mods {
            shift: m["shift"].as_bool().unwrap_or(false),
            alt: m["alt"].as_bool().unwrap_or(false),
            ctrl: m["ctrl"].as_bool().unwrap_or(false),
            meta: m["meta"].as_bool().unwrap_or(false),
        }
    };
    match v["type"].as_str()? {
        "key" => Some(InputEvent::Key { key: v["key"].as_str()?.to_string(), mods: mods(v) }),
        "text" => Some(InputEvent::Text(v["text"].as_str()?.to_string())),
        "paste" => Some(InputEvent::Paste(v["text"].as_str()?.to_string())),
        "mouse" => {
            let action = match v["action"].as_str()? {
                "down" => MouseAction::Down,
                "up" => MouseAction::Up,
                "move" => MouseAction::Move,
                "wheelUp" => MouseAction::WheelUp,
                "wheelDown" => MouseAction::WheelDown,
                _ => return None,
            };
            Some(InputEvent::Mouse {
                action,
                button: v["button"].as_u64().unwrap_or(0) as u8,
                col: v["col"].as_u64().unwrap_or(0) as u16,
                row: v["row"].as_u64().unwrap_or(0) as u16,
                mods: mods(v),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> Mods {
        Mods::default()
    }

    #[test]
    fn parse_key_text_mouse_events() {
        let k = parse_input_event(&serde_json::json!({"type":"key","key":"ArrowUp","mods":{"ctrl":true}})).unwrap();
        assert_eq!(k, InputEvent::Key { key: "ArrowUp".into(), mods: Mods { ctrl: true, ..Default::default() } });
        let t = parse_input_event(&serde_json::json!({"type":"text","text":"hi"})).unwrap();
        assert_eq!(t, InputEvent::Text("hi".into()));
        let p = parse_input_event(&serde_json::json!({"type":"paste","text":"x"})).unwrap();
        assert_eq!(p, InputEvent::Paste("x".into()));
        let mo = parse_input_event(&serde_json::json!({"type":"mouse","action":"down","button":0,"col":3,"row":4,"mods":{}})).unwrap();
        assert_eq!(mo, InputEvent::Mouse { action: MouseAction::Down, button: 0, col: 3, row: 4, mods: m() });
    }

    #[test]
    fn parse_rejects_unknown_type() {
        assert!(parse_input_event(&serde_json::json!({"type":"nope"})).is_none());
    }

    #[test]
    fn enter_tab_backspace() {
        assert_eq!(encode(&InputEvent::Key { key: "Enter".into(), mods: m() }, TermMode::empty()), b"\r");
        assert_eq!(encode(&InputEvent::Key { key: "Tab".into(), mods: m() }, TermMode::empty()), b"\t");
        assert_eq!(encode(&InputEvent::Key { key: "Backspace".into(), mods: m() }, TermMode::empty()), &[0x7f]);
        // Alt/Option+Backspace → ESC+DEL (delete word backward).
        let alt = Mods { alt: true, ..Default::default() };
        assert_eq!(encode(&InputEvent::Key { key: "Backspace".into(), mods: alt }, TermMode::empty()), &[0x1b, 0x7f]);
    }

    #[test]
    fn alt_enter_prefixes_escape() {
        // Option/Alt+Enter → ESC+CR; agents (Claude, Codex) read this as insert-newline.
        let alt = Mods { alt: true, ..Default::default() };
        assert_eq!(encode(&InputEvent::Key { key: "Enter".into(), mods: alt }, TermMode::empty()), &[0x1b, b'\r']);
    }

    #[test]
    fn arrows_respect_app_cursor_mode() {
        let normal = encode(&InputEvent::Key { key: "ArrowUp".into(), mods: m() }, TermMode::empty());
        assert_eq!(normal, b"\x1b[A");
        let app = encode(&InputEvent::Key { key: "ArrowUp".into(), mods: m() }, TermMode::APP_CURSOR);
        assert_eq!(app, b"\x1bOA");
    }

    #[test]
    fn modified_arrow_uses_csi_with_code() {
        let mods = Mods { ctrl: true, ..Default::default() };
        let out = encode(&InputEvent::Key { key: "ArrowRight".into(), mods }, TermMode::APP_CURSOR);
        assert_eq!(out, b"\x1b[1;5C");
    }

    #[test]
    fn ctrl_letter_is_control_char() {
        let mods = Mods { ctrl: true, ..Default::default() };
        let out = encode(&InputEvent::Key { key: "c".into(), mods }, TermMode::empty());
        assert_eq!(out, &[0x03]);
    }

    #[test]
    fn alt_letter_prefixes_escape() {
        let mods = Mods { alt: true, ..Default::default() };
        let out = encode(&InputEvent::Key { key: "b".into(), mods }, TermMode::empty());
        assert_eq!(out, b"\x1bb");
    }

    #[test]
    fn shift_tab_is_back_tab() {
        let mods = Mods { shift: true, ..Default::default() };
        let out = encode(&InputEvent::Key { key: "Tab".into(), mods }, TermMode::empty());
        assert_eq!(out, b"\x1b[Z");
    }

    #[test]
    fn function_and_tilde_keys() {
        assert_eq!(encode(&InputEvent::Key { key: "F1".into(), mods: m() }, TermMode::empty()), b"\x1bOP");
        assert_eq!(encode(&InputEvent::Key { key: "F5".into(), mods: m() }, TermMode::empty()), b"\x1b[15~");
        assert_eq!(encode(&InputEvent::Key { key: "PageUp".into(), mods: m() }, TermMode::empty()), b"\x1b[5~");
    }

    #[test]
    fn text_passes_through_utf8() {
        let out = encode(&InputEvent::Text("héllo 世".into()), TermMode::empty());
        assert_eq!(out, "héllo 世".as_bytes());
    }

    #[test]
    fn paste_is_plain_without_bracketed_mode() {
        let out = encode(&InputEvent::Paste("abc".into()), TermMode::empty());
        assert_eq!(out, b"abc");
    }

    #[test]
    fn paste_is_wrapped_with_bracketed_mode() {
        let out = encode(&InputEvent::Paste("abc".into()), TermMode::BRACKETED_PASTE);
        assert_eq!(out, b"\x1b[200~abc\x1b[201~");
    }

    #[test]
    fn sgr_mouse_press_and_release() {
        let press = encode(
            &InputEvent::Mouse { action: MouseAction::Down, button: 0, col: 12, row: 4, mods: m() },
            TermMode::SGR_MOUSE | TermMode::MOUSE_REPORT_CLICK,
        );
        assert_eq!(press, b"\x1b[<0;13;5M");
        let release = encode(
            &InputEvent::Mouse { action: MouseAction::Up, button: 0, col: 12, row: 4, mods: m() },
            TermMode::SGR_MOUSE | TermMode::MOUSE_REPORT_CLICK,
        );
        assert_eq!(release, b"\x1b[<0;13;5m");
    }

    #[test]
    fn sgr_wheel_up_uses_button_64() {
        let out = encode(
            &InputEvent::Mouse { action: MouseAction::WheelUp, button: 0, col: 0, row: 0, mods: m() },
            TermMode::SGR_MOUSE,
        );
        assert_eq!(out, b"\x1b[<64;1;1M");
    }

    #[test]
    fn no_mouse_bytes_when_reporting_off() {
        let out = encode(
            &InputEvent::Mouse { action: MouseAction::Down, button: 0, col: 1, row: 1, mods: m() },
            TermMode::empty(),
        );
        assert!(out.is_empty());
    }

    #[test]
    fn x10_mouse_when_sgr_off() {
        let out = encode(
            &InputEvent::Mouse { action: MouseAction::Down, button: 0, col: 0, row: 0, mods: m() },
            TermMode::MOUSE_REPORT_CLICK,
        );
        assert_eq!(out, &[0x1b, b'[', b'M', 32, 33, 33]);
    }
}
