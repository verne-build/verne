# Agent Status Detection — Per-Agent Behaviour

Living reference for how each agent CLI reports its lifecycle, how it spawns
subagents, and what Verne does with that. Agents change their hook schemas
without notice, so **treat every claim here as dated evidence, not a contract** —
re-run the capture recipe below when something looks wrong.

Last verified: **2026-07-30**.

Related code:

- `daemon/crates/core/src/daemon/hook_receiver.rs` — receives hooks, filters subagents
- `daemon/crates/core/src/services/hook_server.rs` — `hook_to_state` event → state map
- `daemon/crates/core/src/services/agent_status/` — engine, policy, screen manifests
- `daemon/crates/core/src/services/agent_registry.rs` — per-agent `HookIntegration`
- `electron/main/native/hook-writer.ts` — what we install, per agent
- `electron/main/native/notifications.ts` — which transitions notify

---

## How to re-verify (capture recipe)

Never read hook behaviour off the binary alone — it lies about what actually
reaches the payload (see the claude correction below). Capture it:

- Make a scratch dir and a `log.sh` that appends `"$1\t$(cat)"` to a jsonl file
- Point the agent's hook config at it, **scoped so global config is untouched**:
  - claude — `.claude/settings.json` in the scratch dir (project scope, additive)
  - codex — a separate `CODEX_HOME`, or a temporary entry in `~/.codex/hooks.json`
- Run a headless turn in that dir that (a) uses a tool directly and (b) spawns a
  subagent, ideally one that outlives the turn
- Diff the payload keys for main-agent vs subagent-sourced events

Useful invocation (claude): `echo '<prompt>' | claude -p --permission-mode bypassPermissions`
— the prompt must come via **stdin**; passing it after `--allowedTools` gets swallowed.

---

## Shared model

- **Hook authority** (`agent_registry.rs` → `policy::hook_authority`):
  - `FullLifecycle` — hooks own state until process exit. Of the agents covered
    here: claude, codex, opencode, pi
  - `Identity` — hooks correlate session/identity only; the screen arbitrates state
  - `None` — screen only

  `agent_registry.rs` is the full set; this doc covers a subset.
- **Screen detection** is manifest-driven (`agent_status/manifest/manifests/*.toml`),
  uniform across agents. It only commits `blocked`, plus two narrow overrides
  added 2026-07-30: it can release a stale hook `blocked` when a live interrupt
  affordance is on screen, and commit `blocked` when a prompt renders.
- **Subagent filter** (`hook_subagent_id`): hooks carrying a subagent marker are
  dropped for **state and title**, but **file-ops still apply** — those edits are
  real and land in the tab's worktree.
- **Notifications** are edge-triggered on `tab-updated`: any → `blocked`
  ("needs your input"), `working` → `idle` ("finished"). A state that flaps
  notifies twice, which is why spurious transitions matter.

---

## Claude Code

Integration: `FullLifecycle`. Hooks merged into `~/.claude/settings.json`.
Installed events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
`Notification`, `PermissionRequest`, `PreToolUse`, `PostToolUse`.
Title strategy: **OSC** (terminal escape), not hooks.

**Payload identity** — verified by live capture, claude 2.1.220:

- Main loop **omits `agent_id` and `agent_type` entirely**, on *every* event
  including `Stop`
- Subagent-sourced events carry `agent_id` (opaque, e.g. `aae9889c073c1ec70`)
  plus `agent_type` (the subagent type, e.g. `general-purpose`) — **not** the
  literal `"subagent"`
- Presence of `agent_id` is therefore the whole discriminator
- ⚠️ Correction on record: the binary's `hb(){return{agentType:"main",agentId:kt()}}`
  suggests the main loop reports the session id as `agent_id`. It does not — that
  is an internal context and the field is dropped before serialisation. Capture,
  don't read.

**Subagents**

- Foreground (`Task`/`Agent` tool): run inside the one session, sequentially.
  The main loop is genuinely waiting, and a permission prompt of theirs really
  does block the tab.
- Background (`run_in_background: true`): run **concurrently**, outliving the
  turn that spawned them. Observed ordering:
  ```
  PreToolUse  Agent  agent_id=None    run_in_background=true   → working
  SubagentStart      agent_id=aae9889…
  PostToolUse Agent  agent_id=None                             → working
  Stop               agent_id=None    background_tasks=[running] → idle   ← turn ends
  PreToolUse  Bash   agent_id=aae9889…                         → working ← flips back
  SubagentStop       agent_id=aae9889…                         → working
  ```
  The tab went idle (correctly — the composer is free), then straight back to
  working with nothing to wait on, and stayed there.
- No payload field distinguishes background from foreground. We filter **all**
  subagent-sourced events, which is safe because:
  - no claude subagent event maps to `blocked` (only `working`), so no real
    block can be hidden
  - a foreground subagent is already covered by the main agent's own
    `PreToolUse`/`PostToolUse` on the spawning tool, which latch working until `Stop`
- `Stop` carries `background_tasks: [{id, type, status, description, agent_type}]`
  — an unused signal, if we ever want an "idle, background work running" affordance.

**Notes**

- `Notification` is claude's real needs-attention hook; a payload `message`
  containing "permission" maps to `blocked`, otherwise the 60s idle ping → `idle`.
- `PermissionRequest` is not a claude event; installed for forward-compat only.

---

## Codex

Integration: `FullLifecycle`. Hooks merged into `~/.codex/hooks.json`.
Installed events: `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`,
`PreToolUse`, `PostToolUse`.
Title strategy: `generated_then_hook_prompt` — so a stray `UserPromptSubmit`
*can* retitle the tab (unlike claude).

**Payload identity** — from codex's own JSON schemas embedded in the binary
(`strings` → `permission-request.command.input` etc.), codex standalone 2026-07-21:

- Agents are addressed by canonical path: main agent `/root`, its children
  `/root/<task>`, grandchildren `/root/task1/task_3`. Carried as `agent_id`.
- `agent_id` is **optional** on `PreToolUse` / `PostToolUse` / `PermissionRequest` /
  `UserPromptSubmit` — omitted for the main agent
- `agent_id` is **required** on `Stop` / `SubagentStart` / `SubagentStop`, where the
  main agent reports `/root`
- ⇒ presence alone is NOT the discriminator here; the path value is. A generic
  "has `agent_id`" reading would misclassify every main-agent `Stop`.
- `SessionStart` has no `agent_id` at all
- There is no `approval_required` field — `PermissionRequest` maps to `blocked`
  unconditionally

**Subagents**

- Separate **concurrent threads**, each with its own rollout file, but reporting
  the **parent's `session_id`** and inheriting `VERNE_TAB_ID`. Indistinguishable
  from the parent except by `agent_id` path.
- The parent sits in a `wait_agent` loop while they work — so a subagent's
  permission request is emphatically not the tab's business.
- `SubagentStart` / `SubagentStop` exist but we do not install them.

**Auto-review (`approvals_reviewer`)**

- With `approvals_reviewer = "auto_review"` in `~/.codex/config.toml`, codex fires
  `PermissionRequest` for actions **no human is ever asked about** — a
  `codex-auto-review` model thread decides
- Observed latency 6–12s, far beyond the 700ms `BLOCK_DEBOUNCE_MS`
- On-screen wording: `Reviewing approval request` while in flight (matched by the
  manifest's `review_in_progress` marker), then
  `Automatic approval review approved (risk: …)` once decided — so the marker is
  gone by the time the debounce fires
- Because a subagent's review banner renders in the *subagent's* view, the parent
  tab's screen never shows it at all

**Historical failure this documents** (fixed 2026-07-30): subagent or auto-reviewed
`PermissionRequest` → `blocked` committed + notification fired → hook authority
short-circuited the screen path → the parent, idle-waiting on subagents, sent no
further hooks → the tab read **Blocked** for minutes while the screen showed
`Working (30s • esc to interrupt)`.

---

## OpenCode / Pi

- Integration: `FullLifecycle`, via **plugins** (`agent-plugins.ts`) rather than
  config hooks — port + secret baked in at install.
- Subagent behaviour: **not investigated.**

## Screen-only agents

No hook integration (`HookIntegration::None`) — state comes entirely from the
manifest rules against terminal output: **amp, cline, droid, gemini, grok,
hermes, kilo, kimi, kiro, qodercli**.

---

## Open questions / not yet verified

- OpenCode, Pi: do either spawn subagents that post hooks on the parent's tab?
  Same capture recipe applies.
- Claude: does a *foreground* subagent's permission prompt surface as a
  `Notification` with `agent_id` set? If so the subagent filter would swallow it
  — the reasoning above assumes `Notification` is session-level. Untested because
  headless mode auto-denies rather than prompting.
- Codex: `SubagentStart` / `SubagentStop` are uninstalled. Installing them would
  let us show "N subagents running" without inferring it from tool traffic.
- Both: nothing surfaces background/subagent work in the UI today — the tab is
  just idle. `Stop.background_tasks` (claude) is the ready-made input for that.
