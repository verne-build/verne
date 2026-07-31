//! Golden parity corpus: expected (state, visible_blocker, visible_working) per
//! fixture, derived from the current detectors. The manifest engine must
//! reproduce every row. This is a baked golden table (not a live diff against
//! the old code) so it stays meaningful after Phase 4 deletes the detectors.

use crate::services::agent_status::manifest;
use crate::services::detect::AgentState;
use AgentState::{Blocked, Idle, Working};

struct Case {
    key: &'static str,
    label: &'static str,
    screen: &'static str,
    want_state: AgentState,
    want_blocker: bool,
    want_working: bool,
}

// Seeded rows (expected values = what the current detectors return for these
// screens). Phase 3 tasks ADD a row per agent they migrate.
const CASES: &[Case] = &[
    // --- claude ---
    Case { key: "claude", label: "blocked_permission", screen: "─────\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nesc to cancel", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "claude", label: "blocked_session_limit", screen: "❯ /rate-limit-options\n\nWhat do you want to do?\n❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\n\nEnter to confirm · Esc to cancel", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "claude", label: "working_interrupt", screen: "✻ Building… (esc to interrupt)\n╭─\n│ > \n╰─", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "claude", label: "idle_prompt", screen: "╭─\n│ > \n╰─", want_state: Idle, want_blocker: false, want_working: false },
    // --- codex ---
    Case { key: "codex", label: "blocked_confirm", screen: "Press Enter to confirm or Esc to cancel", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "codex", label: "approved_review_not_blocked", screen: "Automatic approval review approved\nPress Enter to confirm or Esc to cancel", want_state: Idle, want_blocker: false, want_working: false },
    Case { key: "codex", label: "reviewing_request_not_blocked", screen: "Reviewing approval request\nPress Enter to confirm or Esc to cancel", want_state: Working, want_blocker: false, want_working: false },
    Case { key: "codex", label: "blocked_session_limit", screen: "You've hit your usage limit.\nUpgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "codex", label: "working_header", screen: "• Working (12s)", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "codex", label: "idle", screen: ">_ codex\n", want_state: Idle, want_blocker: false, want_working: false },
    // --- antigravity ---
    Case { key: "antigravity", label: "blocked_permission", screen: "Requesting permission for: read file\nDo you want to proceed?\n> Yes\n> No", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "antigravity", label: "working_spinner", screen: "⠋ Processing…\nsome other line", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "antigravity", label: "idle_prompt", screen: "antigravity> \nready", want_state: Idle, want_blocker: false, want_working: false },
    // --- cursor ---
    Case { key: "cursor", label: "blocked_approval", screen: "Waiting for approval\nRun this command?\nbash -c 'ls'\nRun (once) (y)\nSkip (esc or n)", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "cursor", label: "working_stop", screen: "Running task...\nCtrl+C to stop", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "cursor", label: "idle_prompt", screen: "cursor> \nready", want_state: Idle, want_blocker: false, want_working: false },
    // --- grok ---
    Case { key: "grok", label: "blocked_scope", screen: "Use ← → to choose permission whitelist scope\nYes, proceed\nNo, reject", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "grok", label: "working_spinner", screen: "⠋ waiting for response\nCtrl+C:cancel\nCtrl+Enter:interject", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "grok", label: "idle_prompt", screen: "grok> \nready", want_state: Idle, want_blocker: false, want_working: false },
    // --- opencode ---
    Case { key: "opencode", label: "blocked_permission", screen: "△ Permission required\nfor bash", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "opencode", label: "blocked_panel", screen: "esc dismiss\nenter confirm\n↑↓ select", want_state: Blocked, want_blocker: true, want_working: false },
    Case { key: "opencode", label: "working_interrupt", screen: "thinking\nesc to interrupt", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "opencode", label: "working_progress", screen: "building ■■■■ done", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "opencode", label: "idle_prompt", screen: "opencode> \nready", want_state: Idle, want_blocker: false, want_working: false },

    // --- pi ---
    Case { key: "pi", label: "working", screen: "Working...\nstreaming output", want_state: Working, want_blocker: false, want_working: true },
    Case { key: "pi", label: "idle", screen: "pi> \nready", want_state: Idle, want_blocker: false, want_working: false },
];

#[test]
fn manifest_matches_golden_table() {
    let mut mismatches = Vec::new();
    for case in CASES {
        let got = manifest::detect(case.key, case.screen);
        if (got.state, got.visible_blocker, got.visible_working)
            != (case.want_state, case.want_blocker, case.want_working)
        {
            mismatches.push(format!(
                "{}::{} want={:?}/{}/{} got={:?}/{}/{}",
                case.key, case.label,
                case.want_state, case.want_blocker, case.want_working,
                got.state, got.visible_blocker, got.visible_working,
            ));
        }
    }
    assert!(mismatches.is_empty(), "parity mismatches:\n{}", mismatches.join("\n"));
    assert!(CASES.len() >= 9, "corpus shrank unexpectedly");
}
