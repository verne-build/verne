# Suppress Codex "blocked" while an auto-review is in progress

**Date:** 2026-06-24
**Status:** Approved (design) — pending implementation
**Area:** `daemon/crates/core/src/services/agent_status/*`, `daemon/crates/core/src/daemon/hook_receiver.rs`

## Problem

In Codex's auto-review / auto-approval permission mode the sidebar dot flip-flops
`working → blocked → working` on every tool call:

1. Agent runs a tool → `working` (hook).
2. Tool hits a permission gate → Codex POSTs a `PermissionRequest` /
   `PreToolUse(approval_required=true)` hook → daemon maps to `blocked`.
3. Codex prints **"Reviewing approval request"** and the auto-reviewer evaluates it.
4. Reviewer approves → next tool/post hook → back to `working`.

The transient `blocked` in step 2–3 is noise: no human is actually blocked — an
automated reviewer is processing. We want the dot to stay `working` for the whole
review instead of blinking blocked.

### Why the obvious fix doesn't work

Codex's `blocked` is **hook-driven**, not screen-scraped:

- Codex has `HookAuthority::FullLifecycle` (`agent_registry.rs`), so its state is
  set by `engine.apply_hook` (`source = Hook`, confidence 100).
- Once a hook sets `source = Hook`, `engine.observe` takes an early return
  (`engine.rs:177`) that **bypasses the screen-scraping branch entirely**.
- The existing TOML `not` guards in `codex.toml` (the `automatic approval review
  approved` lines) only suppress the **screen** detection path — they never see
  the hook-driven block.

There is already a **700 ms debounce** for codex blocked
(`hook_receiver.rs`, `BLOCK_DEBOUNCE_MS`): an auto-*approved* tool's completion
event supersedes the pending block within the window. The auto-*review* case
breaks this because the review routinely takes longer than 700 ms, so the block
commits before `working` returns.

**Conclusion:** the screen signal ("Reviewing approval request") must gate the
**hook** path. We do that in the engine.

## Approach (chosen)

Screen-gated hook suppression. Detect the review-in-progress text declaratively in
the manifest, surface it as a flag on `AgentDetection`, cache it in the engine
from the last screen observation, and have the engine refuse to surface a
hook-driven `Blocked` while that flag is set — and release an already-committed
hook `Blocked` back to `Working` when the flag appears.

Rejected alternative (extend / re-arm the `hook_receiver` debounce): couples
`hook_receiver` to live screen content it otherwise never touches, and replaces an
explicit on-screen signal with a guessed duration. The review has an explicit end
signal; we should key off state, not time.

## Design

### 1. Manifest: declare the review marker (`codex.toml`)

Add a new per-rule boolean `review_marker` and a rule that sets it:

```toml
[[rules]]
id = "review_in_progress"
state = "working"          # benign: during review the agent IS working
priority = 780             # below the real working rules; only needs to set the flag
region = "bottom_lines(20)"
review_marker = true
contains = ["reviewing approval request"]
```

Also add the same phrase to the `not` guards of the two blocked rules
(`session_limit`, `confirm_prompt`) so the **screen** path is consistent with the
hook path (a screen confirm prompt that co-exists with the review banner must not
read as blocked):

```toml
not = [
  { contains = ["automatic approval review approved"] },
  { contains = ["reviewing approval request"] },
]
```

> The exact literal (`reviewing approval request`, matched lowercased as a
> substring) must be verified against real Codex auto-review output before merge.
> If Codex's wording differs, only this TOML string changes.

### 2. Schema: parse `review_marker`

`manifest/schema.rs` `Rule`: add `#[serde(default)] pub review_marker: bool`.

### 3. Detection: surface the flag independently of the winning rule

The review marker is orthogonal to the winning state rule (during review the
winner might be `working_header`, `interrupt_working`, or the idle fallback), so it
is evaluated as a **separate OR-pass**, not via `best_match`.

`manifest/mod.rs`:

```rust
pub fn detect(key: &str, screen: &str) -> AgentDetection {
    let loaded = loaded_for(key);
    let review_in_progress = loaded
        .manifest
        .rules
        .iter()
        .zip(&loaded.compiled)
        .any(|(rule, compiled)| {
            rule.review_marker && compiled.matches(regions::region(screen, &rule.region))
        });
    let mut det = match best_match(loaded, screen) {
        Some(rule) => detection_from_rule(rule),
        None => AgentDetection::from_state(AgentState::Idle),
    };
    det.review_in_progress = review_in_progress;
    det
}
```

`model.rs` `AgentDetection`: add `pub review_in_progress: bool`; default it to
`false` in `from_state` (and via `Default`). Update the one `AgentDetection { .. }`
literal in `detection_from_rule` and any test constructors.

### 4. Engine: gate the hook path (`engine.rs`)

Add a cached field `review_in_progress: bool` to `AgentStatusEngine` (default
`false`).

**`observe`** — refresh the cache from the latest screen detection, and release a
stale hook-blocked when the review banner appears. Insert *before* the
FullLifecycle early-return (`engine.rs:177`):

```rust
self.review_in_progress = observation.detection.review_in_progress;

// Auto-review in flight: a hook already surfaced Blocked, but the screen shows
// the reviewer is processing. Release to Working so the dot doesn't blink.
if self.review_in_progress
    && self.effective.source == AgentStatusSource::Hook
    && self.effective.agent_state == AgentState::Blocked
{
    next.agent_state = AgentState::Working;
    next.source = AgentStatusSource::Screen;
    next.confidence = 80;
    next.visible_blocker = false;
    return self.commit(next, observation.observed_at);
}
```

**`apply_hook`** — never surface a hook `Blocked` while review is in progress.
Replace the FullLifecycle state assignment:

```rust
if report.authority == HookAuthority::FullLifecycle {
    if let Some(state) = report.state {
        let suppress_block = state == AgentState::Blocked && self.review_in_progress;
        if !suppress_block {
            next.agent_state = state;
            next.source = AgentStatusSource::Hook;
            next.confidence = 100;
            next.visible_blocker = state == AgentState::Blocked;
            next.visible_working = state == AgentState::Working;
        }
        // suppressed: leave prior agent_state (Working) untouched; identity,
        // session, and hook_sequence below still update.
    }
}
```

Identity/session/`hook_sequence` continue to update regardless, so sequencing and
agent identity stay correct.

### Behavior after these changes

| Moment | Signal | Result |
|---|---|---|
| Tool runs | working hook | `working` |
| Permission gate | blocked hook, debounced 700 ms; review flag cached | suppressed → stays `working` |
| Race: block commits before flag cached | next screen observe sets flag | released → `working` |
| Reviewer approves | working / post hook | `working` (unchanged) |
| Review banner gone + real block | blocked hook, flag now false | `blocked` (correct) |

## Components & boundaries

- **`codex.toml`** — declares *what text* means review-in-progress. Tunable
  without touching Rust.
- **`schema.rs` / `mod.rs` (manifest)** — parse the marker and compute the flag.
  Pure function of `(key, screen)`; unit-testable in isolation.
- **`model.rs`** — the `review_in_progress` data field on the detection DTO.
- **`engine.rs`** — the only place that *acts* on the flag, against hook state.
  Deterministic state machine; unit-testable with synthetic hooks + observations.
- **`hook_receiver.rs`** — unchanged in logic; the existing 700 ms debounce still
  runs and now composes with engine suppression.

## Testing

Engine unit tests (`engine.rs`):

1. `review_in_progress_suppresses_hook_block` — observe sets review flag; a
   FullLifecycle `Blocked` hook arrives → state stays `Working`,
   `visible_blocker == false`.
2. `review_in_progress_releases_committed_hook_block` — block hook commits first
   (flag not yet cached); a later observe with the review flag → state flips to
   `Working`, source `Screen`.
3. `block_fires_normally_without_review` — no review flag; FullLifecycle `Blocked`
   hook → `Blocked` (regression guard, existing behavior).
4. `review_flag_clears_allows_later_block` — flag set then cleared by a later
   observe; subsequent `Blocked` hook → `Blocked`.

Manifest tests (`manifest/tests.rs` + `parity.rs`):

5. Parity case: screen with `Reviewing approval request` + a confirm prompt →
   `want_blocker: false` (screen path consistent).
6. `detect` returns `review_in_progress == true` for a screen containing the
   marker, `false` otherwise.

Existing tests must stay green (the new `AgentDetection` field defaults to
`false`, so prior parity/engine cases are unaffected).

## Known limitations

- If the review banner has not yet rendered *and* no screen observation has been
  taken when the 700 ms debounce fires, `blocked` commits for the few hundred ms
  until the next observation releases it (test #2 path). The window is small and
  self-correcting; if it proves visible in practice, a follow-up could extend the
  codex debounce. Out of scope here.
- The marker string is Codex-version-dependent; verify against live output.
```
