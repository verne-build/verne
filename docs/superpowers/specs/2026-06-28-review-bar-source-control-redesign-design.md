# Review Bar — Source Control Redesign

Date: 2026-06-28
Status: Approved (design)

## Goal

Move the diff-review "comments" UI out of the right-hand diff panel and into the
left panel of both source-control views, as a pinned (sticky) expandable bar.
Replace the popover + text buttons with a compact icon bar + inline accordion,
and rework "send to agent" into an agent-picker dropdown. The saved review-agent
setting becomes a general "default agent" that also drives a new
new-terminal-with-agent shortcut.

## Current state (for reference)

- `src/components/ReviewBar.vue` — the comment bar; today mounted in the **right
  diff panel** of both `SourceControlTab.vue` (L136) and `CommitsTab.vue` (L116),
  gated by `scopeKey && reviewTotal > 0`. Renders: a popover trigger
  (`MessageSquare` + `"{n} comments · {m} files"`) opening a comment navigator
  popover; a two-step **Discard** button; a **Request Changes** popover holding an
  optional overall-message `Textarea` + **Send to Agent** button.
- `src/composables/useDiffReview.ts` — review store. `requestChanges(scopeKey,
  directoryId, cwd, overall?)` reads `useSettings().settings.value.reviewAgent`,
  then either reuses a live review tab for the scope (`reviewTabByScope`) or
  spawns a new tab and launches the agent inline (createTab → focus →
  `tabsSessionId` → write `bareLaunchCommand(agent)+"\r"` → wait composer/paste
  ready → `deliverPrompt`).
- `src/lib/reviewLaunch.ts` — `bareLaunchCommand(agent)`, `pasteReadiness(agent)`,
  bracketed-paste helpers. `src/lib/reviewPrompt.ts` — `formatReviewPrompt(list,
  overall?)`.
- Setting: `reviewAgent: string` (`src/types/shared.ts`, default in
  `src/lib/defaultSettings.ts` = `"claude"`), configured in
  `SettingsScreen.vue` Agents category; options from `request.mcpSupportedAgents`.
- Agent enumeration: running tabs via workspace store `agentsList(scope)`;
  launchable catalog via `request.mcpSupportedAgents({})` →
  `{ key, displayName }` for Claude/Codex/Cursor/OpenCode; icons via
  `src/composables/useAgentIcon.ts` `getAgentIcon(agentType)`.
- Shortcuts: data-only catalog `src/lib/shortcuts/catalog.ts`, dispatched in
  `App.vue` `handleGlobalKeydown`; surfaced in `KeyboardShortcutsModal.vue`.
  `Mod+Alt+T` is currently unbound (`Mod+T` = New Terminal). `Kbd.vue` renders
  key chips.

## Design

### 1. Bar placement (pinned in the left panel)

In both `SourceControlTab.vue` and `CommitsTab.vue`, move `<ReviewBar>` out of the
right diff `ResizablePanel` and into the **left** `ResizablePanel`, as a
non-scrolling header above the panel body:

```
<ResizablePanel ...>            <!-- left list panel -->
  <div class="flex h-full flex-col">
    <ReviewBar v-if="scopeKey && reviewTotal > 0" :scope-key cwd directory-id @jump />
    <ChangesPanel|HistoryPanel class="min-h-0 flex-1" ... />
  </div>
</ResizablePanel>
```

- Source Control: the bar sits above the commit message box (which is the first
  element inside `ChangesPanel`'s scroll area).
- Commits: the bar sits above the commits list (`HistoryPanel`).
- Because the bar is a sibling above each panel's own scroll area, it stays
  pinned at the top without `position: sticky`. `ChangesPanel` and `HistoryPanel`
  are otherwise unchanged.
- The right diff panel no longer mounts `ReviewBar`; the diff `<DiffView>` becomes
  the sole child again. `jump` continues to bubble up to the existing handler
  (which selects the file + scrolls the diff to the comment).

### 2. ReviewBar markup

Collapsed row (keep current container styling: bordered, `bg-secondary/40`,
`text-xs`, horizontal):

- **Left** — a `button` toggling the accordion: `MessageSquare` icon +
  `Comments {summary.total}` + a chevron (`ChevronDown`) rotated when expanded.
  (Drop the `· {m} files` suffix.)
- **Right** — three icon buttons (`Button size="icon"` ghost, `size-3`/`size-3.5`
  glyphs, each with a tooltip/title):
  1. **Send** (`Bot` or `SendHorizontal`) — opens the agent dropdown (§3).
  2. **Copy** (`Copy`) — `navigator.clipboard.writeText(formatReviewPrompt(list))`
     over the live comments in scope; toast "Review copied". No overall message.
  3. **Discard** (`Trash2`) — preserves the existing two-step confirm (first
     click arms a 3s confirm window, reflected via tooltip/icon state; second
     click calls `review.clearScope(scopeKey)`).

Expanded accordion (below the row; `max-h-72` with an internal `ScrollArea`):

- The comment navigator only — the existing `navComments` list markup
  (`FileIcon` + filename + `:start-end` range + 80-char preview, click →
  `emit('jump', c)`, empty-state line). No overall-message field.

Gate: render the bar only when `reviewTotal > 0` (unchanged). `validPaths`
pruning of orphaned source-control comments carries over verbatim.

### 3. Send-to-agent dropdown

A `DropdownMenu` opened by the Send icon, two labeled groups:

```
Open agents                         (DropdownMenuLabel; group hidden if empty)
  [icon] {agentName} · {tab label}  → sendReviewToTab(scopeKey, tabId)
  ...
New agent                           (DropdownMenuLabel)
  [icon] Claude Code        [⌘⌥T]   → sendReviewToNewAgent(scopeKey, dirId, cwd, key)
  [icon] Codex
  [icon] Cursor CLI
  [icon] OpenCode
```

- **Open agents** — rows from `store.agentsList(scope)`; icon `getAgentIcon(
  agentType)`, label from existing `agentName`/title-case helper. Selecting
  injects the review into that running tab. Group + its label omitted when there
  are no running agents.
- **New agent** — rows from `request.mcpSupportedAgents({})` (`{ key,
  displayName }`); icon `getAgentIcon(key)`. Selecting spawns a fresh agent tab
  and sends.
- The new-agent row whose `key === settings.defaultAgent` shows a trailing
  `Kbd` chip with the `new-agent-terminal` shortcut display keys (⌘⌥T),
  marking it as the default agent. The chip is display-only (the shortcut itself
  opens a terminal — see §5 — it does not trigger a review send).

### 4. `useDiffReview` refactor

Replace `requestChanges` with two explicit, single-purpose functions (no
`overall` parameter):

- `sendReviewToNewAgent(scopeKey, directoryId, cwd, agentType)` — `launchAgentTab`
  (§6) → `pasteReadiness(agentType)` → wait composer/paste ready →
  `deliverPrompt(sessionId, formatReviewPrompt(list), readiness)` → on success
  `clearScope(scopeKey)`. Toast on launch failure (reuse current copy).
- `sendReviewToTab(scopeKey, tabId)` — resolve the tab's `sessionId`, `focusTab`,
  wait paste ready, `deliverPrompt(...)`, `clearScope` on success.

Remove the implicit `reviewTabByScope` reuse path — explicit "Open agents"
selection replaces it. The terminal-injection helpers (`sendWhenReady`,
`focusTab`, `waitForComposerReady`, `waitForPasteReady`, `deliverPrompt`,
`pasteLanded`) are retained; the prompt-building helper now always uses
`formatReviewPrompt(list)` with no overall string.

### 5. Default-agent setting

- Rename `reviewAgent` → `defaultAgent` in `src/types/shared.ts` and
  `src/lib/defaultSettings.ts` (default `"claude"`).
- Settings migration: when loading settings, if `defaultAgent` is absent but
  `reviewAgent` is present, carry the old value over (one-time, in the settings
  load/normalize path).
- `SettingsScreen.vue`: relabel the control "Default Agent" with description
  "Agent launched by ⌘⌥T and used as the default review target." Bind to
  `defaultAgent`; options still from `mcpSupportedAgents`.

### 6. Shared agent-tab launch + ⌘⌥T shortcut

- Extract `launchAgentTab(directoryId, cwd, agentType): Promise<{ tabId,
  sessionId } | null>` — the createTab → `focusTab` → `tabsSessionId` →
  `sendWhenReady(bareLaunchCommand(agentType)+"\r")` sequence currently inline in
  `useDiffReview`. Lives where both review-send and the shortcut can import it
  (e.g. `useDiffReview` export or a small `useAgentLaunch` composable);
  `sendReviewToNewAgent` consumes it.
- Catalog: add `new-agent-terminal` — label "New Agent Terminal", category
  Terminal, `defaultBinding: "Mod+Alt+T"`, target renderer. Appears
  automatically in `KeyboardShortcutsModal`.
- `App.vue` `handleGlobalKeydown`: on `shortcuts.matches("new-agent-terminal", e)`
  call `launchAgentTab(dirId, cwd, settings.defaultAgent)` (no prompt). Add a
  matching File-menu item next to "New Terminal" for discoverability
  (`electron/main/menu.ts` + `handleMenuAction` branch).

## Out of scope / non-goals

- No change to how comments are created (gutter clicks), stored, or rendered in
  the diff (`DiffCommentBox`).
- No new agents beyond what `mcpSupportedAgents` already returns.
- ⌘⌥T is not context-sensitive; there is no dedicated review-send shortcut.

## Testing

- `reviewLaunch.test.ts` stays green; add coverage if `launchAgentTab`/send
  helpers gain pure, testable pieces.
- Manual: bar appears pinned above commit box (SC) and commits list (Commits)
  when comments exist; hidden when none. Expand/collapse reveals the navigator;
  click-to-jump still selects + scrolls the diff. Copy puts the full review
  prompt on the clipboard. Discard two-step confirm clears scope. Send dropdown
  lists running agents (inject) + launchable agents (spawn); default agent shows
  ⌘⌥T. ⌘⌥T anywhere opens a new terminal launched with the default agent.
  Settings migration: existing `reviewAgent` value surfaces as `defaultAgent`.
- `pnpm typecheck` + `pnpm build` after frontend changes.
