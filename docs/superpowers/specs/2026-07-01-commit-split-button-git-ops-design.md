# Commit Split-Button with Git Ops Dropdown

Date: 2026-07-01
Branch: feat/review-bar-source-control

## Goal

Convert the single **Commit** button in the source-control changes panel into a
split button group: a primary **Commit** button plus a chevron-down trigger that
opens a dropdown of additional git operations, grouped by purpose. Relevant
operations surface the existing loading toast (loading → success/error).

## Operations

Grouped dropdown (Title Case labels, shadcn `DropdownMenu`, `align="end"`):

```
(top, unlabeled)
  Commit & Push          disabled unless commit-enabled AND upstream
  Commit & Sync          disabled unless commit-enabled AND upstream
── Remote ──
  Push                   needs upstream
  Pull                   needs upstream
  Sync                   needs upstream
  Fetch                  needs remote
  Publish Branch         enabled only when canPublish (remote, no upstream yet)
── Advanced ──
  Fast-Forward           needs upstream
  Force Push (danger)    needs upstream; native confirm before running
```

The primary button remains **Commit** with its current label, `⌘↵` shortcut, and
disabled logic (`!commitMessage.trim() || !status.staged.length || committing`).
The chevron trigger is enabled whenever a repo is present, independent of the
Commit button's disabled state. Disabled menu items stay visible (greyed) so
availability is legible.

## Semantics

- **Force Push**: `--force-with-lease` (refuses to overwrite unseen remote work).
  A native confirm dialog gates it; no other op is confirmed.
- **Fast-Forward**: `pull --ff-only` (fails cleanly when a real merge is needed).
- **Sync**: pull then push under a single loading toast.
- **Commit & Push / Commit & Sync**: commit first; if the commit succeeds,
  chain push / sync. If the commit fails, bail (surfaced by the existing commit
  error path) and do not push.

`GitStatus` has no ahead/behind counts, so the menu shows no counts — enablement
is derived from `canPublish` / `canSyncUpstream` / `hasRemote` only.

## Backend (Rust sidecar)

Git ops are sidecar methods (not daemon). Add two:

- `daemon/crates/core/src/protocol/methods.rs`: `GIT_FORCE_PUSH`,
  `GIT_FAST_FORWARD` constants; register in the sidecar dispatch alongside the
  other `GIT_*` methods.
- `daemon/crates/core/src/services/git.rs`:
  - `git_force_push()` — model on `git_push()` (line ~833) but pass
    `--force-with-lease`. Return the same `To …` output string so `remoteWebUrl`
    still yields a View action.
  - `git_fast_forward()` — model on `git_pull()` (line ~817) with `--ff-only`.
    On a non-fast-forward, return the git error message (surfaced as a failed
    toast).
  - Both wrapped in `spawn_blocking` like the existing git handlers.

No daemon changes. No DB/schema changes.

## Frontend

### `src/composables/useRpc.ts`

Add to the request facade (mirroring `gitPush`):

- `gitForcePush({ path }) → string`
- `gitFastForward({ path }) → string`

### `src/composables/useGitOperations.ts`

Extend the existing composable (it already owns `runGitCommand` → `toast.loading`
→ success/error, keyed by `SC_GIT_TOAST_ID`):

- Widen `gitBusy` union and `SC_GIT_LABELS` to include `fetch`, `sync`,
  `forcePush`, `fastForward`.
- New functions routed through `runGitCommand`:
  - `fetch()` → `gitFetch`
  - `sync()` → `"Syncing…"` toast running `gitPull` then `gitPush`, outputs
    concatenated for the success description.
  - `forcePush()` → native `confirm(...)`; on confirm, `gitForcePush`.
  - `fastForward()` → `gitFastForward`.
- Export the new functions plus the existing `pull` / `push` / `publish` /
  `canPublish` / `canSyncUpstream` / `gitBusy` / `gitStatus`.

### `src/components/ChangesPanel.vue`

- Instantiate `useGitOperations(() => props.workingDir)` inside the panel; keep
  its `gitStatus` in sync with the panel's existing `status` ref (assign on
  refresh) so menu enablement matches the panel's tracked status.
- Replace the single Commit `<Button>` (line ~635) with a `ButtonGroup`:
  primary Commit button (unchanged) + `DropdownMenuTrigger` chevron button.
- Compound commit handlers live here (they need `commitMessage`):
  - Refactor `doCommit()` to return a success boolean / throw so chains can bail.
  - `commitAndPush()` = `await doCommit()` then `push()`.
  - `commitAndSync()` = `await doCommit()` then `sync()`.
- Build the dropdown with `DropdownMenu*` primitives, separators + labels for the
  Remote / Advanced groups, `variant="destructive"` on Force Push, per-item
  `:disabled` from the enablement rules above.

Imports: `ButtonGroup` from `@/components/ui/button-group`; `DropdownMenu`,
`DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`,
`DropdownMenuSeparator`, `DropdownMenuLabel` from `@/components/ui/dropdown-menu`;
a chevron icon (`ChevronDown`) from the existing icon set.

## Out of Scope

- The commented-out push/pull footer in `SourceControlTab.vue` stays commented.
- No ahead/behind counts (would require a `GitStatus` shape change).
- No rebase/merge operations.

## Testing

- Unit (`vitest`): existing `remoteWebUrl` tests pass; add tests for `sync`
  output concatenation and the force-push confirm gate (mock `toast`, `request`,
  and `confirm`).
- Rust: `cargo check` for the two new handlers.
- Manual: each op fires the loading toast and resolves to success/error; disabled
  states correct with vs. without upstream / remote; Force Push confirm dialog
  appears and cancel aborts; `pnpm typecheck` + `pnpm build`.
- Restart note: Fast-Forward / Force Push touch Rust — require a `pnpm dev`
  restart (sidecar rebuild) to take effect.
