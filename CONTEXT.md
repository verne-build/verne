# Context

## Domain Terms

### Tab Lifecycle

The workflow that creates, restores, focuses, resizes, closes, and reconciles terminal tabs across Electron, the persistent daemon, the sidecar, and the renderer. A tab lifecycle operation may touch persisted rows, pane groups, live PTYs, agent shadow state, runtime status, notifications, and renderer events.

Tab Lifecycle owns pane group mutations when the operation creates, removes, moves, or activates backend terminal tabs. The renderer owns layout rendering and user intent; the lifecycle module owns cross-process ordering, rollback, cleanup, and event emission.

Tab Lifecycle operations include creating tabs, closing tabs, splitting panes, closing pane groups, moving panes, activating panes or pane groups, ensuring a directory has a terminal, and reconciling persisted tabs with live daemon state at startup. Display-only helpers stay in the renderer unless they need lifecycle ordering.

Tab Lifecycle returns post-operation snapshots after required steps are internally reconciled. Create and split operations require DB row, pane group, and daemon spawn success; failures roll back persisted state before returning. Close operations treat daemon kill and sidecar cleanup as best-effort cleanup, but persisted row and pane group updates must converge before the renderer updates presentation.

The first implementation seam for Tab Lifecycle is Electron main. Its adapters are the existing DB modules, daemon RPC client, sidecar RPC client, and renderer event emitter. Tests should target lifecycle operations directly, including rollback, best-effort cleanup, startup reconcile, and event emission after persisted state converges.

### Pane Group

A persisted split-layout group for one or more terminal panes. The tab bar displays pane groups; each pane inside a group maps to a backend terminal tab.

### Sidecar Dispatch

The sidecar socket dispatch is an adapter, not the owner of git, file, search, watch, shadow, notes, MCP, worktree, or settings behaviour. Split it mechanically by method family first, preserving behaviour while adding typed request parsing per family. Deeper module interfaces can follow after locality is restored.

Split Sidecar Dispatch in this order: notes, watch, shadow, search/file, worktree, MCP, then git. Do not introduce trait seams just for modularity; internal modules can be functions over `AppState` until a real second adapter exists.

### Session Ownership

The external seam for terminal lifecycle internals is `Session`. WebSocket handling is a transport adapter. `Session` owns PTY input, resize, attach snapshots, grid subscriptions, history fetch, search, status inspection, and teardown. The implementation may use internal modules behind `Session`, but callers should not reach into emulator, grid channels, or fetch/search mechanics directly.

Migrate Session Ownership by adding narrow `Session` methods first, then moving attach, input/resize, history/search, and finally making leaked fields private. Preserve the attach invariant: delta subscription and snapshot creation must form a consistent cut with no gap or overlap for the client.

### Notes Owner

The sidecar owns notes because notes are workspace filesystem state. Electron resolves workspace roots from the DB and acts as an adapter. The MCP server remains in Electron but should call the sidecar notes interface instead of maintaining a second notes implementation in TypeScript.

### Renderer Workspace State

The workspace Pinia store remains the public renderer interface. Its implementation can split into internal modules for directories, tab runtime, pane groups, the Tab Lifecycle client, and worktrees. Do not create multiple public stores for pane groups or tab lifecycle; that would make callers coordinate new seams.

### Editor Document Session

`CodeEditor.vue` is a Monaco/view adapter. A renderer-side Editor Document Session owns document load/save, dirty state, stale conflict state, shadow state, file watch lifecycle, external delete/change handling, and frontmatter preservation hooks. Notes should reuse the same document lifecycle through options instead of maintaining a separate document lifecycle. Move this first in the renderer; only move more shadow semantics into sidecar later if a second adapter justifies the seam.
