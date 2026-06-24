# Portable hook path via `$VERNE_HOOK_DIR`

**Date:** 2026-06-23
**Status:** Approved (design), pre-implementation
**Area:** Electron `hook-writer.ts` + tab spawn env

## Problem

Verne installs lifecycle hooks into each agent's *global* config
(`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.copilot/hooks/verne.json`,
`~/.gemini/config/hooks.json`, `~/.cursor/hooks.json`). Each entry bakes the
**absolute** path to `notify.sh`:

```
'/Users/<you>/Library/Application Support/build.verne/hooks/notify.sh' Stop claude
```

Two consequences:

1. **Not portable across machines.** Users who sync these config files (dotfiles)
   carry a machine/user-specific absolute path that breaks elsewhere.
2. **Dev and prod clobber each other.** Both instances write to the *same* global
   config files but bake *different* absolute paths (`build.verne` vs
   `build.verne-dev`), so whichever launched last wins.

## Goal

Write a single, machine-independent hook command that resolves to the correct
`notify.sh` for whichever Verne instance (dev or prod) spawned the tab — and
degrades harmlessly when the agent runs outside Verne.

## Approach

Replace the baked absolute path with a shell-expanded variable plus a default,
and inject the per-instance hooks dir into the tab's spawn environment.

### Command string (written into every agent config)

```
"${VERNE_HOOK_DIR:-$HOME/Library/Application Support/build.verne/hooks}/notify.sh" <Event> <agentType>
```

- `$VERNE_HOOK_DIR` — injected at PTY spawn = *this* instance's hooks dir
  (dev → `build.verne-dev/hooks`, prod → `build.verne/hooks`). Lets one shared
  config entry resolve per-instance (fixes the dev/prod clobber).
- `:-$HOME/Library/Application Support/build.verne/hooks` — default when the var
  is unset (agent run outside Verne). Resolves to the **prod** hooks dir;
  `notify.sh` then gates on `VERNE_TAB_ID` (also unset) and exits 0. Harmless.
- The default is a **constant** (always prod, `$HOME`-relative) so dev and prod
  write the *identical* string — that identity is what stops the clobber.
- Double quotes (was single) so the var expands and the space in
  `Application Support` survives.

### Verified prerequisites

Every target agent runs the hook command through a shell (so `${VAR:-default}`
expands) and inherits the spawned agent's env (so injected vars are visible):

| Agent | Shell-expand | Env inherit | Evidence |
|---|---|---|---|
| Claude | ✅ | ✅ | source (`sh -c`) |
| Codex | ✅ | ✅ | source (`$SHELL -lc`) |
| Copilot | ✅ | ✅ | source (`bash --norc --noprofile -c`, `bash:` field) |
| Antigravity (`agy`) | ✅ | ✅ | **empirical** (probe run) |
| Cursor | ✅ | ✅ | **empirical** (probe run) |

Empirical probe (2026-06-23): injected the env-var command form into the real
cursor/agy configs, ran each once with/without `VERNE_HOOK_DIR`. Confirmed: var
set → custom path ran with `VERNE_TAB_ID` inherited; var unset → `:-` default
ran, including correct handling of the space in the default path.

## Changes

### 1. `electron/main/native/hook-writer.ts` — command builders

Build the env-var command instead of the quoted absolute path. Affects all four
command shapes:

- `verneHookEntry()` (Claude, Codex) — `{hooks:[{type:"command", command}]}`
- Copilot `bash:` entries in `ensureHooksForCopilot()`
- `agyCmd()` (Antigravity) — `{type:"command", command}`
- Cursor flat `{command}` in `ensureHooksForCursor()`

Introduce one shared helper that produces the command string from `(event,
agentType)` and a module-level constant `HOOK_CMD_DEFAULT_DIR =
"$HOME/Library/Application Support/build.verne/hooks"`. `writeNotifyScript()` is
**unchanged** (it still writes the file); the command no longer references the
absolute script path.

### 2. Detection / idempotency rework (`hook-writer.ts`)

Current detection keys off the absolute `notifyScript` path string
(`isVerneEntry(marker)`, `verneScriptPath`, `isStaleVerneEntry`,
`isCursorVerneEntry`). With env-var commands the path is no longer a literal, so:

- **New marker:** an entry is "ours" if its command contains `notify.sh` **and**
  (`VERNE_HOOK_DIR` **or** `build.verne`). This matches both the **new** env-var
  form and **legacy** absolute-path entries — so upgrades auto-clean old entries.
  The `build.verne` clause keeps it from matching other tools' hooks (e.g. orca,
  superset) that reference their own scripts.
- **Drop `verneScriptPath` / `isStaleVerneEntry`** (the `existsSync`-on-literal
  staleness check). No longer meaningful and no longer needed: all instances now
  write an identical entry, so there are no divergent stale entries to prune.
- **Idempotency:** unchanged shape — strip all marker-matching entries, push one
  fresh entry. Because the string is identical across instances, dev/prod runs
  converge instead of clobbering.
- `removeHooksFor{Claude,Codex,Cursor}` use the same new marker so uninstall
  cleans both new and legacy entries. Copilot (whole-file rewrite) and
  Antigravity (whole-group rewrite) need no detection change — only their
  command strings change.

### 3. Spawn env injection (`electron/main/index.ts`)

Where `VERNE_TAB_ID` is set on the spawn plan env — `tabs_create` (~L170) and
`tabs_session_id` (~L211) — also set:

```ts
env.VERNE_HOOK_DIR = join(internalDataDir, "hooks");
```

`internalDataDir` is already imported there (it feeds `writeNotifyScript`). This
is the per-instance value (dev vs prod) that overrides the config default.

### 4. `notify.sh` — unchanged

Still gates on `VERNE_TAB_ID`, reads the positional `<agentType>` arg.

## Out of scope / accepted trade-offs

- **Dev-only users outside Verne:** the `:-` default points at the **prod**
  hooks dir. A user with only dev installed, running an agent *outside* Verne,
  hits a non-existent default path → hook silently no-ops. Acceptable (no hook is
  wanted there anyway).
- **Daemon/Rust side:** no change. Hook command authoring is entirely in
  Electron/TypeScript.
- No change to event lists, agent registry, or `hook_server`.

## Testing

- **Unit (`hook-writer`):** new marker matches legacy absolute + new env-var
  entries; does not match foreign hooks (orca/superset); strip+re-add is
  idempotent; uninstall removes both forms. Command string shape per agent.
- **Manual:**
  - Fresh install → each config contains the env-var command.
  - Upgrade over a config with legacy absolute entries → old entries replaced,
    no duplicates.
  - Spawn a tab in dev and in prod → `VERNE_HOOK_DIR` resolves to the matching
    hooks dir; hook reaches the right hook server.
  - Run an agent outside Verne → `:-` default resolves, `notify.sh` exits 0.
- `pnpm typecheck`, `pnpm build`.

## Files touched

- `electron/main/native/hook-writer.ts` (command builders + detection)
- `electron/main/index.ts` (spawn env injection)
