# Review Comments → Agent via Temp File

## Problem

The "Request Changes" feature lets a user highlight diff lines, add comments, then
send them to an agent. For a **fresh** agent it currently:

1. Spawns a tab running the bare `$SHELL`.
2. Types `claude\r` into the shell to launch the agent.
3. Waits for the agent TUI (`waitForAgent`).
4. Bracketed-pastes the markdown prompt into the running TUI and submits.

Step 4 (the paste) is flaky. We want to instead write the prompt to a temp file and
launch the agent seeded directly from that file, avoiding the paste race — while
keeping the prompt content out of the visible typed command (no inline prompt text in
the terminal command line).

## Approach

Write the prompt to a file under the app `userData` dir, then for the fresh-spawn path
type a launch command that reads the file via shell command substitution:

```
claude "$(cat '/Users/…/Application Support/build.verne-dev/review-prompts/review-<uuid>.md')"
```

`$(cat …)` expands in the session shell (`$SHELL`, zsh) before the agent starts, so the
prompt text never appears in the typed command. The agent (`claude` / `cursor-agent`)
starts interactively, seeded with the prompt as its initial message. The file is
auto-deleted ~10s after write (after the `cat` has run).

No Rust/daemon changes. No `tabs_create`/spawn-plan changes. Renderer + Electron-main
native handler only.

### Risk to verify during implementation

`claude "<prompt>"` and `cursor-agent "<prompt>"` must start **interactively** seeded
with the prompt — not in print-and-exit mode. Confirm before finalizing.

## Changes

### 1. Native IPC: `review_write_prompt`

File: `electron/main/native/review-cmds.ts` (already owns review persistence + atomic
write pattern).

- Input: `{ content: string }`.
- Writes to `<userData>/review-prompts/review-<uuid>.md` using the existing atomic
  tmp+rename pattern (`mkdir -p` the dir first).
- Returns `{ path: string }`.
- Schedules best-effort deletion of the file ~10s later (`setTimeout` → `unlink`,
  swallow errors). No separate delete IPC.
- Register in the native handler map alongside the existing `review_*` handlers.

### 2. RPC binding

File: `src/composables/useRpc.ts`.

- Add `reviewWritePrompt: (p: { content: string }) => invoke("review_write_prompt", p)`
  returning `{ path: string }`, next to the other `review*` bindings.

### 3. Launch helper

File: `src/lib/reviewLaunch.ts`.

- Add `fileLaunchCommand(agent, filePath)` returning
  `` `${binFor(agent)} "$(cat '${filePath}')"` ``, reusing the same agent→binary
  mapping that `bareLaunchCommand` uses (`claude`, `cursor-agent`, etc.). Path wrapped
  in single quotes to tolerate spaces (e.g. "Application Support").

### 4. Rewire fresh-spawn branch of `requestChanges`

File: `src/composables/useDiffReview.ts` (~lines 181-197).

- Build prompt via `formatReviewPrompt(list, overall)` (unchanged).
- `const { path } = await request.reviewWritePrompt({ content: prompt })`.
- `store.createTab({ directoryId, cwd, label: "Suggested changes" })` (unchanged).
- Resolve `sessionId` via `request.tabsSessionId({ id: tab.id })` (unchanged).
- `sendWhenReady(sessionId, fileLaunchCommand(agent, path) + "\r", 10000)`.
- **Remove** the `waitForAgent(tab.id)` + `sendPrompt(sessionId, prompt)` calls from
  this branch.
- `clearScope(...)` on success (unchanged).
- If `waitForAgent` is now unused, remove it.

### 5. Reuse branch — unchanged

The running-agent path (existing live review tab for the scope) keeps using
`sendPrompt(sessionId, prompt)` (bracketed paste). A running agent TUI cannot shell-out
to `cat` a file, so the temp-file mechanism does not apply there.

## Data Flow

```
comments
  → formatReviewPrompt(list, overall)            (existing)
  → review_write_prompt { content }              (new native handler)
      → <userData>/review-prompts/review-<uuid>.md   (atomic write)
      → returns { path }
  → createTab → bare $SHELL                       (existing)
  → sendWhenReady: agent "$(cat 'path')"\r        (new launch command)
      → shell reads file, launches agent seeded with prompt
  → file auto-unlinked ~10s later                 (new)
  → clearScope                                    (existing)
```

## Testing

- Unit: `fileLaunchCommand` produces correct string per agent, single-quotes the path.
- Unit: `review_write_prompt` writes the file, returns a path, and the file is gone
  after the deletion timeout (fake timers).
- Manual: Request Changes on a fresh scope → new tab launches agent already seeded with
  the review prompt; no paste step; `review-prompts/` empties after ~10s.
- Manual: Request Changes against an already-running agent tab → still pastes (unchanged
  behavior).
- `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Out of Scope

- Changing the reuse/running-agent paste path.
- Any Rust/daemon/spawn-plan changes (adding command/args/stdin to `TabSpawnPlan`).
- Persisting prompt files for history/debugging.
