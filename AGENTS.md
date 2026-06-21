# Verne

## Stack

- **Backend**: Two Rust processes sharing one workspace crate (`portable-pty`, `rusqlite`, `tokio`, `tokio-tungstenite`, `git2`, `rmcp`, `notify`, `ignore`, `nucleo-matcher`). Talk to Electron main over unix sockets using a length-prefixed JSON protocol.
- **Frontend**: Electron, Vue 3 (composition API), Pinia, TailwindCSS v4, shadcn-vue (reka-ui), a custom canvas/WebGL2 grid terminal renderer (no xterm.js), Monaco
- **Speech**: sherpa-onnx (on-device STT) in a Node worker thread
- **Build**: electron-vite + electron-builder, TypeScript (strict), cargo

## Commands

```bash
pnpm dev          # electron-vite dev (debug daemon + bundled install run first via predev)
pnpm build        # electron-vite build
pnpm package      # release daemon build + electron-builder
pnpm typecheck    # vue-tsc --noEmit + tsc --noEmit
pnpm test         # vitest run
pnpm daemon:build:dev   # cargo build (debug)
```

Use **pnpm**, never npm.

### What Needs Restarting After a Change

`pnpm dev` runs `predev` first (`daemon:build:dev` → `cargo build` debug; then `bundle:install` → `pnpm install` for `resources/bundled` node deps — NOT the Rust binaries). In dev both Rust processes are spawned **directly from `daemon/target/debug/`** (`daemon-supervisor.ts`), so the cargo build IS the install. Note `predev` only runs when you *start* `dev` — saving a `.rs` file mid-session rebuilds nothing. What you must do depends on which layer you touched:

- **Renderer (Vue: `src/**`, components, composables, stores)** — electron-vite HMR hot-reloads. **No restart.**
- **Electron main / preload (`electron/main/**`, `electron/preload/**`)** — electron-vite restarts the main process automatically on save. If it doesn't catch, restart `pnpm dev`.
- **Rust sidecar code (git, db, file search/watch, settings, notes, hooks)** — does NOT live-reload. Stop `pnpm dev` and run it again: `predev` recompiles `daemon/target/debug/verne-sidecar` and the new app launch spawns it. The sidecar is `SIGTERM`'d on quit, so a clean stop is enough — but the supervisor *reuses an already-running sidecar* if its socket is still up, so make sure the prior instance actually exited. The persistent daemon survives, but it doesn't serve these methods, so no extra step.
- **Rust daemon code (PTYs, terminal grid ws bridge, tab spawn/kill, detection)** — the daemon is spawned **detached and survives app close**, so restarting `pnpm dev` alone keeps the *old* daemon running its stale binary. Rebuild (`pnpm daemon:build:dev`), then kill the detached daemon so a fresh one spawns: read the pid from the daemon pid file under `~/Library/Application Support/build.verne` (debug; see `paths.rs`) and `kill` it — don't broad-`pkill verne`, it'll match the dev server too. Then relaunch.

Quick rule: **frontend → nothing; sidecar → restart dev; daemon → kill the detached daemon then restart dev.** Unsure which process serves a method? Check `DAEMON_METHODS` in `electron/main/ipc-router.ts` (in the set → daemon; otherwise → sidecar).

## Architecture

Three layers: Electron main + renderer, plus two long-lived Rust processes.

```
renderer (Vue)  ──window.verne.invoke()──▶  Electron main  ──unix socket──▶  daemon  (verne)
       ▲                                          │         ──unix socket──▶  sidecar (verne-sidecar)
       └──────────── daemon-event ────────────────┘
```

1. **Electron main** (`electron/main/index.ts`) — owns the window, spawns/connects both Rust processes, registers native command handlers, installs the IPC router. Also hosts the bundled notes + browser **MCP server** (Node, `electron/main/mcp/`) that agents spawn via the `verne-mcp` launcher script. Privileged scheme registration (`verne-asset://`) MUST run before `app.whenReady()`.
2. **daemon** (`verne`) — spawned **detached**, **survives app close** so PTY sessions persist across reopen. Owns: PTYs, the terminal grid WebSocket bridge, agent detection snapshots, tab spawn/kill. Single-instance lock via pid file.
3. **sidecar** (`verne-sidecar`) — tied to the app lifecycle (killed on `before-quit`, uninstalls hooks). Owns: SQLite DB, git ops, file search/watch, settings, agent hooks, shadow repos, notes storage.

### IPC

**Renderer → main**: preload (`electron/preload/index.ts`) exposes `window.verne` via `contextBridge` (contextIsolation on):
- `invoke(method, params)` → `ipcRenderer.invoke("invoke", …)`
- `listen(event, cb)` → subscribes to `daemon-event` broadcasts
- `assetUrl(path)` → `verne-asset://local/<path>`

`src/platform/index.ts` wraps these as `invoke` / `listen` / `convertFileSrc` for the rest of the renderer. Always import from `platform`, not `window.verne` directly.

**Main → backends**: `electron/main/ipc-router.ts` routes each method:
- **Native** handlers (registered via `registerNative`): window, dialog, shell, menu, browser/CDP, LSP, metrics, review, speech, plus tab-orchestration shims.
- **daemon** methods: PTY ops, tab spawn/kill, detection snapshot, ws port, live tab ids.
- everything else → **sidecar**: git, db, file search, settings, notes, etc.

**Backends → renderer**: both Rust processes emit events; main re-broadcasts via `win.webContents.send("daemon-event", name, payload)`.

```
src/                    Frontend — Vite root
  main.ts               bootstrap
  App.vue               root layout
  platform/index.ts     invoke/listen/convertFileSrc over window.verne
  stores/               Pinia: workspace, browserHistory
  composables/
    useRpc.ts           typed request facade + event listener init
    useTerminal.ts      GridSession registry, WebGL2/Canvas2D renderer selection, WS plumbing
    useDictation.ts     STT state machine + hotkey + insertion (singleton module state)
    useAudioCapture.ts  Web Audio mic capture → speech:feedAudio
    useSettings.ts, useTheme.ts, useLanguageClient.ts, useFilePanelTabs.ts, …
  lib/
    monacoBootstrap.ts, textmate.ts, themeTokens.ts
    terminal/           canvas grid terminal: GridStore, GridSession, Canvas2D/WebGL2 renderers, gridProtocol
    dictation*.ts       (see Dictation below)
    diffs*.ts, review*.ts
  components/           terminal/ (GridTerminal), CodeEditor, DiffView, FileExplorer, NotesPanel, Settings*, browser, DictationOverlay
  components/ui/        shadcn-vue primitives
  grammars/, themes/

electron/main/
  index.ts              entry — startup, tab orchestration, lifecycle
  daemon-supervisor.ts  spawn/connect daemon + sidecar
  daemon-client.ts      unix-socket RPC client
  ipc-router.ts         renderer invoke → native / daemon / sidecar; forwards daemon-event (persists tab-updated snapshots)
  mcp/                  bundled notes + browser MCP server (Node) + verne-mcp launcher
  native/               window, dialog, shell, menu, browser, lsp, metrics, review
  speech/               ipc, stt-service, stt-worker, model-manager, model-catalog, hotkey

daemon/                 Rust workspace (members: crates/{core,daemon,sidecar})
  crates/core/src/
    paths.rs            data dirs, socket/pid paths, ws_port(), hook_port(), CLI symlink
    db.rs               SQLite schema + queries
    types.rs            shared serde types
    state.rs            in-memory sessions/PTYs/watchers
    rpc_serve.rs        socket listener + frame codec + dispatch
    protocol/           method constants + frame codec
    daemon/             PTY lifecycle, tab spawn, ws bridge (daemon-side)
    sidecar/            sidecar runtime entry
    services/           session_manager, ws_server, terminal_emulator, git, git_worker, worktrees,
                        shadow_tree, agent_shadow, hook_server, detect, pgrp, jsonl_reader,
                        mcp_agents, agent_status
    agent_status/       manifest-driven agent detection: engine.rs, model.rs, policy.rs,
                        manifest/ (per-agent TOML rules compiled at startup)
    notes.rs            shared notes file ops (MCP server itself now runs in Electron/Node)
  crates/daemon/        verne binary
  crates/sidecar/       verne-sidecar binary
```

## Key Patterns

- **Persistent daemon owns sessions**: closing the app does NOT kill PTYs (see the `window-all-closed` / `before-quit` comments in `index.ts`). The sidecar IS killed on quit. To genuinely stop a tab's PTY use `tabs_close`.
- **Tab lifecycle spans both processes**: sidecar inserts the row + resolves a spawn plan → daemon spawns the PTY. `registerTabOrchestration` in `index.ts` keeps this behind a single renderer `tabs_create`. Roll the row back if the spawn fails.
- **Default to a native or sidecar handler, not the daemon**: only reach for a daemon RPC when the work genuinely needs PTY state. New non-PTY commands go to the sidecar.
- **Match nullability across the socket**: if a backend handler takes `Option<String>` but the JSON sends a bare value, mirror optionality on both sides.
- **Chromium renderer**: this is Electron — Chrome DevTools and Chromium APIs apply (unlike the old Tauri/WebKit target). The `verne-asset://` privileged scheme serves local files.
- **reka-ui Switch**: `modelValue`/`update:modelValue`, NOT `checked`/`update:checked`. Use `:model-value` and `@update:model-value`.
- **Thread safety**: `Arc<Mutex<T>>` for state shared across handlers + background threads.
- **RPC dispatch is concurrent**: `rpc_serve.rs` runs each request on its own task (bounded per connection), so handlers on one socket overlap. Any handler that does blocking work (`git2`, `std::fs`, `Command::output`, `rusqlite`, heavy CPU) MUST wrap it in `tokio::task::spawn_blocking` — otherwise it ties up an async worker and stalls the whole runtime under load. Quick `await`-only handlers don't need it.
- **DB migrations**: `CREATE TABLE IF NOT EXISTS` in init. Schema changes need explicit `pragma_table_info` checks. **Gate each migrating table by its own column check** — don't bundle a multi-table migration behind one table's check.
- **Shadow tree**: dirty file content per-directory git shadow via `git2`. CodeEditor reuses one Vue instance across tab switches — track `currentFilePath` explicitly, never rely on `props.filePath` for the previous file.
- **Agent shadow (diff tracking)**: per-tab git shadow. Watcher monitors the JSONL session file for Read/Write/Edit; Read → baseline commit, Write/Edit → committed. Cleanup on tab delete.

## Dictation

On-device STT via sherpa-onnx running in a Node worker thread (`electron/main/speech/stt-worker.ts`, bundled separately by esbuild in `electron.vite.config.ts`). Audio captured in the renderer (`useAudioCapture.ts`) and fed to main via `speech:feedAudio`.

Flow: `useDictation.ts` state machine (`idle → starting → listening → stopping`) listens for `speech:partial` / `speech:final`, then post-processes each final segment:

- `dictationDictionary.ts` — regex replacements, spoken → developer terms (curated defaults + custom rules)
- `dictationItn.ts` — inverse text normalization: "one two seven" → 127, "three fifty" → 350, "oh" → 0, "dot" → `.`
- `dictationNumbers.ts` — thin wrapper over the ITN module
- `dictationFinalSegments.ts` — segment spacing/punctuation rules, dedup, dot attachment (".5")
- `dictationInsertionTarget.ts` — resolve the cursor target (Monaco / input) and insert

Hotkey (toggle/hold) registered per-window in `electron/main/speech/hotkey.ts`. Speech events ride the existing `daemon-event` bus — no preload changes. Microphone usage string is in `electron-builder.yml` (`NSMicrophoneUsageDescription`).

## UI Components

Always use shadcn-vue. **Menu items always use Title Case** — every label inside a `DropdownMenu*` or `ContextMenu*` capitalizes each major word (`Copy Path`, `Word Wrap`, `New Worktree`). Sentence-case is wrong.

## Vue Frontend Guidance

- Ignore `src/components/ui/**` for local Vue style enforcement unless explicitly changing shadcn-vue components.
- Avoid `v-html`. Don't render SVG markup inline from user/document content — use Blob/object URLs through `<img>` and revoke on cleanup.
- Move filtering/grouping/sorting into `computed`; keep expensive expressions out of templates. Don't call helpers repeatedly inside `v-for`.
- Every `v-for` needs a stable, meaningful key. Avoid combining complex `v-if` with `v-for` — pre-filter.
- Guard async UI refreshes against stale results: snapshot the active path/id/query before awaiting, commit only if it still matches.
- Clean up all timers, listeners, object URLs, watchers, subscriptions, and fs watches in `onUnmounted`/`onBeforeUnmount`.
- Prefer Vue refs over `document.querySelector`; scope DOM queries to the component root when unavoidable.
- Run `pnpm typecheck`, lint, and `pnpm build` after frontend changes.

## Performance Guardrails

- **Own every watcher/timer/listener explicitly**: one owner, one teardown path.
- **Stopping a session must fully stop it**: terminate the PTY child, release terminal renderer caches (WebGL contexts), clear working state. Removing from the session manager is not enough.
- **Don't duplicate background pipelines**: session log ingestion, file-op extraction, agent shadow snapshotting run in one backend-owned path.
- **Don't tie expensive work to broad reactive fields**: no recomputing git diffs / repo scans / large list transforms on `updatedAt` or every render.
- **Event-driven over polling**: poll only as fallback or while a related panel is open. Resource monitor, git status, agent refresh stay visibility-aware.
- **Inactive terminals may be visually degraded, not paused**: background agent sessions keep running. Safe: renderer downgrade, released WebGL contexts, coarser batching. Never pause PTY reads.
- **Validate with**: repeated start/stop cycles, file switching, idle CPU/memory plateau, `cargo check`, `pnpm typecheck`, `pnpm build`.

## Syntax Highlighting / TextMate Grammars

Same algorithm as VS Code: vscode-textmate + vscode-oniguruma WASM. **If a language's colors look wrong, the problem is almost certainly the grammar, not the theme or token pipeline.**

- Grammars in `src/grammars/` — copied from VS Code's built-in extensions
- `lib/textmate.ts` bridges grammars to Monaco via `setTokensProvider` (string-based)
- `lib/themeTokens.ts` maps vscode-textmate binary metadata → Monaco token names
- Adding a language: copy `.tmLanguage.json`, register loader + scope in `textmate.ts`, call `registerTextMateLanguage()` in `monacoBootstrap.ts`, add to `LANG_MAP`/`LANG_LABELS` in `CodeEditor.vue`
- **Debugging**: `grammar.tokenizeLine()` to inspect scopes. Wrong scopes → grammar. Right scopes, wrong colors → theme.

## Naming

- Vue components: PascalCase (`CodeEditor.vue`)
- Stores/composables: camelCase (`workspace.ts`, `useRpc.ts`)
- Rust modules: snake_case (`session_manager.rs`)

## Tab States

Per-tab agent state: `working` | `blocked` | `idle` | `unknown`. Drives the dot in the sidebar. Detection (the daemon's `detect_snapshot`, surfaced to Electron via `tab-updated` events forwarded in `ipc-router.ts`) only commits `blocked`; hooks own working/idle transitions because tail-buffer scraping oscillates on spinner redraw.

## Persistence

- Internal data — `~/Library/Application Support/build.verne` (`…-dev` debug): sockets, pid files, `server.log`, `browser-control.json`, `notes/`, SQLite DB. WAL mode, FKs on.
- User data — `~/.verne` (`~/.verne-dev` debug): settings, themes.
- Ports: ws bridge 9600/9601, hook server 9610/9611. CLI symlinked to `~/.local/bin/verne[-dev]` on launch.

## Style

- Be extremely concise in code and commit messages; sacrifice grammar for brevity.
- Always use Conventional Commits for commit messages and PR titles.
- Before creating or updating a PR, read `.github/pull_request_template.md` and the relevant `.github/PULL_REQUEST_TEMPLATE/*` file, then follow that template in the PR body.
- Keep performance fast — avoid unnecessary re-renders, heavy main-thread work, bloated deps.
- When rendering the user's path in the UI, always use the `~` shortcut for the home directory.
