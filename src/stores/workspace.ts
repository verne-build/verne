import { defineStore } from "pinia";
import { ref, shallowRef, triggerRef, computed, watch } from "vue";
import type { WorkingDirectory, TabUpdatedEvent, Tab, CreateTabOpts, AgentState } from "@/types";
import { useRpc } from "@/composables/useRpc";
import { stopClient } from "@/composables/useLanguageClient";
import { dropFilePanelScope } from "@/composables/useFilePanelTabs";
import { forgetAgentNotificationTab } from "@/composables/useAgentNotifications";
import {
  firstLeaf,
  collectPaneIds,
  singlePaneResizeTargets,
  type SplitDir,
} from "@/lib/paneLayout";
import { shouldApplyAgentRevision } from "@/lib/agentStatus";
import { buildSessionsList, type SessionRow } from "@/lib/sessionsView";
import {
  applyArrangementSizes,
  insertIntoArrangement,
  migrateGroupsToArrangements,
  parseArrangementMap,
  pruneArrangement,
  removeFromArrangement,
  serializeArrangementMap,
  type Arrangement,
} from "@/lib/arrangement";

const LSP_LANGUAGES = ["typescript"];

export const useWorkspaceStore = defineStore("workspace", () => {
  const directories = ref<WorkingDirectory[]>([]);
  const selectedDirectoryId = ref<string | null>(
    localStorage.getItem("selectedDirectoryId")
  );
  const loading = ref(false);
  // Agents panel scope filter — shared so the View menu can drive it too.
  const agentScope = ref<"all" | "current">(
    localStorage.getItem("agentScope") === "current" ? "current" : "all",
  );
  watch(agentScope, (v) => localStorage.setItem("agentScope", v));
  // First-run UI state. directoriesLoaded gates the welcome hero so it never
  // flashes before the initial getDirectories() resolves. welcomeSeen makes the
  // branded hero one-time (localStorage, same pattern as agentScope above).
  const directoriesLoaded = ref(false);
  const welcomeSeen = ref(localStorage.getItem("welcomeSeen") === "true");
  function markWelcomeSeen() {
    if (welcomeSeen.value) return;
    welcomeSeen.value = true;
    localStorage.setItem("welcomeSeen", "true");
  }
  // Guards against re-entrant folder-picker dialogs across all open affordances.
  const picking = ref(false);
  // Per-tab canonical runtime state, keyed by tab_id. Populated by
  // daemon's `tab-updated` events. shallowRef + triggerRef: mutate the Map in
  // place and trigger once, instead of cloning the whole Map on every 1 Hz
  // tab-updated tick (O(tabs) reactive replacement — see CLAUDE.md guardrail).
  const tabRuntime = shallowRef<Map<string, TabUpdatedEvent>>(new Map());

  function applyTabUpdate(payload: TabUpdatedEvent) {
    const prev = tabRuntime.value.get(payload.tabId);
    if (!shouldApplyAgentRevision(prev?.revision, payload.revision)) return;
    const selected = selectedDirectoryId.value;
    const isActive =
      selected != null && activeTabIdByDirectory.value[selected] === payload.tabId;
    const completedInBackground =
      prev?.agentState === "working"
      && payload.agentState === "idle"
      && !isActive;
    tabRuntime.value.set(payload.tabId, {
      ...prev,
      ...payload,
      needsAcknowledgement:
        payload.agentState === "unknown"
          ? false
          : completedInBackground || prev?.needsAcknowledgement,
    });
    triggerRef(tabRuntime);
  }

  // Lifecycle is orthogonal to agent state (spec: session rows carry both).
  // Missing entry = assumed running (hydration fills the truth).
  const sessionLifecycle = shallowRef<Map<string, "running" | "exited">>(new Map());

  // Each in-flight hydrate gets its own set; live events fan out to all of
  // them, so overlapping hydrates never clobber each other.
  const activeHydrateEventSets = new Set<Set<string>>();

  function markSessionExited(tabId: string) {
    sessionLifecycle.value.set(tabId, "exited");
    for (const s of activeHydrateEventSets) s.add(tabId);
    triggerRef(sessionLifecycle);
  }
  function markSessionRunning(tabId: string) {
    sessionLifecycle.value.set(tabId, "running");
    for (const s of activeHydrateEventSets) s.add(tabId);
    triggerRef(sessionLifecycle);
  }

  async function hydrateSessionLifecycle(): Promise<void> {
    const mine = new Set<string>();
    activeHydrateEventSets.add(mine);
    try {
      const live = new Set(await useRpc().request.listLiveTabIds());
      const next = new Map(sessionLifecycle.value);
      for (const tabs of Object.values(terminalTabsByDirectory.value))
        for (const t of tabs)
          if (!mine.has(t.id)) next.set(t.id, live.has(t.id) ? "running" : "exited");
      sessionLifecycle.value = next;
    } catch {
    } finally {
      activeHydrateEventSets.delete(mine);
    }
  }

  // Live OSC 0 titles from the running process, keyed by tab_id. The daemon
  // includes its cached title in canonical hydration after an app relaunch.
  const oscTitleByTab = shallowRef<Map<string, string>>(new Map());

  function applyTabTitle(payload: { tabId: string; title: string }) {
    // The user's manual name wins permanently — ignore auto-titles for it.
    const renamed = Object.values(terminalTabsByDirectory.value)
      .flat()
      .some((t) => t.id === payload.tabId && t.userRenamed);
    if (renamed) return;
    // Arrives from two sources (daemon's live tab-title event + detection-loop
    // re-delivery); skip redundant reactivity when unchanged.
    if (oscTitleByTab.value.get(payload.tabId) === payload.title) return;
    oscTitleByTab.value.set(payload.tabId, payload.title);
    triggerRef(oscTitleByTab);
  }

  // Terminal tab state per directory + the active tab in each.
  const terminalTabsByDirectory = ref<Record<string, Tab[]>>({});
  const activeTabIdByDirectory = ref<Record<string, string | undefined>>({});
  // Per-directory activation history (most-recent-last) so closing the active
  // tab falls back to the previously-active tab, not index 0.
  const tabActivationHistory: Record<string, string[]> = {};

  // ---- sessions model (slice 2: arrangements own writes) ----
  // Per-scope layout tree of session (== tab) ids. This is now the single
  // write model for "what panes are visible and how" — groups (below) are
  // read-only, kept only for the one-time migration.
  const arrangementByScope = ref<Record<string, Arrangement>>({});
  let arrangementsHydrated: Promise<void> | null = null;

  function hydrateArrangements(): Promise<void> {
    arrangementsHydrated ??= useRpc()
      .request.getAppState({ key: "arrangement_by_scope" })
      .then((raw) => {
        arrangementByScope.value = { ...parseArrangementMap(raw), ...arrangementByScope.value };
      })
      .catch(() => {});
    return arrangementsHydrated;
  }

  function arrangementFor(scopeId: string): Arrangement | null {
    return arrangementByScope.value[scopeId] ?? null;
  }

  function writeArrangement(scopeId: string, arr: Arrangement | null) {
    const map = { ...arrangementByScope.value };
    if (arr) map[scopeId] = arr;
    else delete map[scopeId];
    arrangementByScope.value = map;
    useRpc()
      .request.setAppState({ key: "arrangement_by_scope", value: serializeArrangementMap(map) })
      .catch(() => {});
  }

  const focusedByScope = ref<Record<string, string | undefined>>({});

  function focusSession(sessionId: string) {
    const dirId = tabDirId(sessionId);
    if (!dirId) return;
    focusedByScope.value = { ...focusedByScope.value, [dirId]: sessionId };
    activeTabIdByDirectory.value = { ...activeTabIdByDirectory.value, [dirId]: sessionId };
    acknowledgeTab(sessionId);
    recordTabActivation(dirId, sessionId);
  }

  function tabDirId(sessionId: string): string | undefined {
    for (const [dirId, tabs] of Object.entries(terminalTabsByDirectory.value))
      if (tabs.some((t) => t.id === sessionId)) return dirId;
    return undefined;
  }

  async function newSession(directoryId: string, opts: { cwd?: string } = {}): Promise<Tab> {
    const existing = terminalTabsByDirectory.value[directoryId] ?? [];
    const tab = await useRpc().request.tabsCreate({
      directoryId,
      cwd: opts.cwd,
      label: String(existing.length + 1),
    });
    // Re-read post-await — a concurrent newSession in this directory may have
    // already appended its own tab; spreading the stale pre-await snapshot
    // would drop it.
    const current = terminalTabsByDirectory.value[directoryId] ?? [];
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [directoryId]: [...current, tab],
    };
    writeArrangement(directoryId, { version: 1, layout: { pane: tab.id } });
    focusSession(tab.id);
    return tab;
  }

  // Compat alias — App.vue/menu callers use the old CreateTabOpts shape.
  const createTab = (opts: CreateTabOpts): Promise<Tab> => newSession(opts.directoryId, { cwd: opts.cwd });

  async function splitSessionWithNew(sessionId: string, direction: SplitDir, before = false): Promise<void> {
    const dirId = tabDirId(sessionId);
    if (!dirId) return;
    const src = (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === sessionId);
    const existing = terminalTabsByDirectory.value[dirId] ?? [];
    const tab = await useRpc().request.tabsCreate({
      directoryId: dirId,
      cwd: src?.cwd,
      label: String(existing.length + 1),
    });
    // Re-read post-await (see newSession) so a concurrent create isn't dropped.
    const current = terminalTabsByDirectory.value[dirId] ?? [];
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [dirId]: [...current, tab],
    };
    writeArrangement(dirId, insertIntoArrangement(arrangementFor(dirId), sessionId, tab.id, direction, before));
    focusSession(tab.id);
  }

  // Same-scope only — cross-scope moves are forbidden by spec (a session
  // never leaves the directory that owns its PTY).
  function splitSessionWithExisting(sessionId: string, otherSessionId: string, direction: SplitDir, before = false): void {
    const dirId = tabDirId(sessionId);
    if (!dirId || tabDirId(otherSessionId) !== dirId) return;
    const current = arrangementFor(dirId);
    if (!current) return;
    const without = removeFromArrangement(current, otherSessionId) ?? current;
    writeArrangement(dirId, insertIntoArrangement(without, sessionId, otherSessionId, direction, before));
    focusSession(otherSessionId);
  }

  /** Drop a session out of its scope's arrangement without killing its PTY. */
  function removeFromView(sessionId: string): void {
    const dirId = tabDirId(sessionId);
    if (!dirId) return;
    const current = arrangementFor(dirId);
    if (!current) return;
    const next = removeFromArrangement(current, sessionId);
    writeArrangement(dirId, next);
    if (focusedByScope.value[dirId] === sessionId && next) focusSession(firstLeaf(next.layout));
  }

  function setArrangementSizes(scopeId: string, key: string, sizes: number[]): void {
    const current = arrangementFor(scopeId);
    if (current) writeArrangement(scopeId, applyArrangementSizes(current, key, sizes));
  }

  // Title precedence: manual rename → daemon agent display title → live OSC
  // title → foreground/agent process → numbered fallback. Computed live so
  // renames propagate to rows. Named `sessionName` post slice-2 (one session
  // == one pane, no more group indirection); `tabGroupName` alias kept for one
  // slice to limit consumer churn.
  function sessionName(sessionId: string): string {
    const dirId = tabDirId(sessionId) ?? selectedDirectoryId.value ?? "";
    const tab = (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === sessionId);

    // 1. Manual rename always wins.
    if (tab?.userRenamed && tab.label) return tab.label;
    // 2. Hook-derived agent display title from the persistent daemon.
    const rt = tabRuntime.value.get(sessionId);
    if (rt?.displayTitle) return rt.displayTitle;
    // 3. Live OSC title from the running process.
    const osc = oscTitleByTab.value.get(sessionId);
    if (osc) return osc;
    // 4. Foreground process / agent name from detection.
    if (rt?.agentType) return rt.agentType.charAt(0).toUpperCase() + rt.agentType.slice(1);
    if (rt?.foregroundCommand) return rt.foregroundCommand;
    // 5. Fallback: the numbered label.
    return tab?.label ?? "shell";
  }
  const tabGroupName = sessionName;

  /** A mounted full-area terminal reports its grid size; mirror it onto every
   *  OTHER single-pane scope's PTY so a backgrounded tab is already the right
   *  size when reactivated (no SIGWINCH jump → no TUI redraw miscount that
   *  duplicates chrome / garbles text). Gated on the reporter being a single
   *  pane: only then does its container equal the whole terminal viewport. Split
   *  arrangements size their panes per-pane on activation, so they're left
   *  alone. */
  function syncViewportSize(reporterTabId: string, cols: number, rows: number) {
    if (cols < 1 || rows < 1) return;
    const layouts = Object.values(arrangementByScope.value).map((a) => a.layout);
    for (const tabId of singlePaneResizeTargets(layouts, reporterTabId)) {
      // No-op on the daemon if that tab has no live PTY — cheap and safe.
      void useRpc().request.tabResize({ tabId, cols, rows }).catch(() => {});
    }
  }

  // Persisted "last active group" per directory (app_state JSON map) — read
  // only, feeds the one-time groups → arrangements migration below.
  const persistedActiveGroupByDir = ref<Record<string, string>>({});
  let activeGroupHydrated: Promise<void> | null = null;
  function hydrateActiveGroups(): Promise<void> {
    if (!activeGroupHydrated) {
      activeGroupHydrated = useRpc()
        .request.getAppState({ key: "active_group_by_directory" })
        .then((stored) => {
          if (stored) {
            try {
              persistedActiveGroupByDir.value = JSON.parse(stored);
            } catch {}
          }
        })
        .catch(() => {});
    }
    return activeGroupHydrated;
  }

  // One-time groups → arrangements conversion, gated per-directory (so a
  // partially-converted install can't leave some directories stuck on the
  // old model). After conversion (or if already converted), prune the
  // arrangement against currently-live tabs and backfill if empty.
  async function ensureLayoutModel2(dirId: string, tabs: Tab[]) {
    await hydrateArrangements();
    const flagKey = `layout_model:${dirId}`;
    const model = await useRpc().request.getAppState({ key: flagKey });
    if (model !== "2") {
      const raw = await useRpc().request.groupsList({ directoryId: dirId });
      const { arrangements, focusedByDir, orderByDir } = migrateGroupsToArrangements(
        { [dirId]: raw },
        { [dirId]: persistedActiveGroupByDir.value[dirId] },
      );
      if (arrangements[dirId]) writeArrangement(dirId, arrangements[dirId]);
      if (orderByDir[dirId]?.length) await useRpc().request.tabsReorder({ ids: orderByDir[dirId] }).catch(() => {});
      if (focusedByDir[dirId]) focusSession(focusedByDir[dirId]!);
      await useRpc().request.setAppState({ key: flagKey, value: "2" });
    }
    // Prune arrangements against live tabs (dead sessions dropped).
    const live = new Set(tabs.map((t) => t.id));
    const arr = arrangementFor(dirId);
    const pruned = arr ? pruneArrangement(arr, live) : null;
    if (JSON.stringify(pruned) !== JSON.stringify(arr)) writeArrangement(dirId, pruned);
    if (!arrangementFor(dirId) && tabs.length)
      writeArrangement(dirId, { version: 1, layout: { pane: tabs[tabs.length - 1].id } });
  }

  // A tab becoming active means the user is looking at it — clear the "done"
  // acknowledgement badge (a background working→idle completion). No-op unless
  // the flag is set, so this stays cheap on every activation tick.
  function acknowledgeTab(tabId: string | undefined) {
    if (!tabId) return;
    const runtime = tabRuntime.value.get(tabId);
    if (!runtime?.needsAcknowledgement) return;
    tabRuntime.value.set(tabId, { ...runtime, needsAcknowledgement: false });
    triggerRef(tabRuntime);
  }

  function recordTabActivation(dirId: string, tabId: string | undefined) {
    if (!tabId) return;
    const h = (tabActivationHistory[dirId] ??= []);
    const i = h.indexOf(tabId);
    if (i !== -1) h.splice(i, 1);
    h.push(tabId);
  }

  function hydrateTabRuntime(tabs: Tab[]) {
    // Hydrate runtime from persisted state so dots are correct immediately on
    // app reload, before the first hook/detect tick fires. If we know the
    // agent type but not the state (daemon was restarted → state column was
    // cleared), default to "idle" not "unknown" — a known agent is by
    // definition not unknown.
    for (const t of tabs) {
      if (t.lastAgentType || t.lastAgentState) {
        const prev = tabRuntime.value.get(t.id);
        const fallback: AgentState = t.lastAgentType ? "idle" : "unknown";
        tabRuntime.value.set(t.id, {
          ...prev,
          tabId: t.id,
          agentType: t.lastAgentType,
          agentState: t.lastAgentState ?? fallback,
          lastAgentSessionId: t.lastAgentSessionId,
        });
      }
    }
    triggerRef(tabRuntime);
  }

  /** Merge live agent state and OSC titles from the daemon into renderer state. */
  async function hydrateAgentStatesFromDaemon() {
    try {
      const states = await useRpc().request.getAgentStates();
      for (const s of states) {
        applyTabUpdate({
          tabId: s.tabId,
          agentState: s.agentState as import("@/types").AgentState,
          agentType: s.agentType,
          revision: s.revision,
          source: s.source,
          changedAt: s.changedAt,
          lastAgentSessionId: s.lastAgentSessionId ?? undefined,
          displayTitle: s.displayTitle ?? undefined,
        });
        if (s.title) applyTabTitle({ tabId: s.tabId, title: s.title });
      }
    } catch (_e) {
      // Non-fatal: DB fallback from hydrateTabRuntime is still valid
    }
  }

  async function loadTabsForDirectory(directoryId: string) {
    const rpc = useRpc();
    const tabs = await rpc.request.tabsList({ directoryId });
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [directoryId]: tabs,
    };
    hydrateTabRuntime(tabs);
    await hydrateActiveGroups();
    await ensureLayoutModel2(directoryId, tabs);
    // Override DB-backed state with daemon's live truth (survives app restarts)
    void hydrateAgentStatesFromDaemon();
    void hydrateSessionLifecycle();
    return tabs;
  }

  async function loadAllTabs() {
    const rpc = useRpc();
    const tabs = await rpc.request.tabsList({});
    const grouped: Record<string, Tab[]> = {};
    for (const t of tabs) {
      (grouped[t.directoryId] ??= []).push(t);
    }
    terminalTabsByDirectory.value = { ...terminalTabsByDirectory.value, ...grouped };
    hydrateTabRuntime(tabs);
    await hydrateActiveGroups();
    await Promise.all(
      Object.entries(grouped).map(([dirId, list]) => ensureLayoutModel2(dirId, list)),
    );
    // Override DB-backed state with daemon's live truth (survives app restarts)
    void hydrateAgentStatesFromDaemon();
    void hydrateSessionLifecycle();
    return tabs;
  }

  // Fully stop a pane's PTY and release its cached xterm. Resolve the session
  // id BEFORE closing — tabsSessionId/ensure_tab_session would otherwise respawn
  // a fresh PTY after the close.
  async function destroyPane(id: string) {
    let sid: string | null = null;
    try { sid = await useRpc().request.tabsSessionId({ id }); } catch {}
    await useRpc().request.tabsClose({ id }).catch(() => {});
    if (sid) window.dispatchEvent(new CustomEvent("dispose-terminal-session", { detail: sid }));
  }

  /** Drop a session's runtime + history state (PTY stop / list removal are the
   *  caller's job — see closeSession). */
  function forgetTab(id: string) {
    tabRuntime.value.delete(id);
    triggerRef(tabRuntime);
    oscTitleByTab.value.delete(id);
    triggerRef(oscTitleByTab);
    sessionLifecycle.value.delete(id);
    triggerRef(sessionLifecycle);
    for (const hist of Object.values(tabActivationHistory)) {
      const hi = hist.indexOf(id);
      if (hi !== -1) hist.splice(hi, 1);
    }
  }

  /** Kill a session's PTY, drop its row, and remove it from its scope's
   *  arrangement. Replaces closeTab/closePane/closeGroup. */
  async function closeSession(sessionId: string): Promise<void> {
    const dirId = tabDirId(sessionId);
    await destroyPane(sessionId);
    forgetTab(sessionId);
    forgetAgentNotificationTab(sessionId);
    if (dirId) {
      terminalTabsByDirectory.value = {
        ...terminalTabsByDirectory.value,
        [dirId]: (terminalTabsByDirectory.value[dirId] ?? []).filter((t) => t.id !== sessionId),
      };
      const current = arrangementFor(dirId);
      const next = current ? removeFromArrangement(current, sessionId) : null;
      const remaining = terminalTabsByDirectory.value[dirId] ?? [];
      const wasFocused = focusedByScope.value[dirId] === sessionId;
      if (next) writeArrangement(dirId, next);
      else if (remaining.length) writeArrangement(dirId, { version: 1, layout: { pane: remaining[remaining.length - 1].id } });
      else writeArrangement(dirId, null);
      const arr = arrangementFor(dirId);
      // Only refocus when the closed session actually held focus — a
      // background/non-focused pane closing shouldn't steal focus.
      if (arr && wasFocused) focusSession(firstLeaf(arr.layout));
      if (!remaining.length && dirId === selectedDirectoryId.value) void newSession(dirId).catch(() => {}); // ensureTerminal equivalent
    }
  }

  async function renameTab(id: string, label: string) {
    const rpc = useRpc();
    const tab = await rpc.request.tabsRename({ id, label });
    const list = terminalTabsByDirectory.value[tab.directoryId] ?? [];
    const next = list.map(t => (t.id === id ? tab : t));
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [tab.directoryId]: next,
    };
    return tab;
  }

  async function reorderTabsInDirectory(directoryId: string, ids: string[]) {
    const current = terminalTabsByDirectory.value[directoryId] ?? [];
    const byId = new Map(current.map(t => [t.id, t]));
    const reordered = ids
      .map(id => byId.get(id))
      .filter((t): t is Tab => !!t);
    if (reordered.length !== current.length) return;
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [directoryId]: reordered,
    };
    try {
      await useRpc().request.tabsReorder({ ids });
    } catch (e) {
      console.error("[workspace] tabsReorder failed:", e);
    }
  }

  async function reorderRootDirectories(ids: string[]) {
    const idSet = new Set(ids);
    const others = directories.value.filter(d => !idSet.has(d.id));
    const byId = new Map(directories.value.map(d => [d.id, d]));
    const reordered = ids.map(id => byId.get(id)).filter((d): d is WorkingDirectory => !!d);
    directories.value = [...reordered, ...others];
    try {
      await useRpc().request.reorderDirectories({ ids });
    } catch (e) {
      console.error("[workspace] reorderDirectories failed:", e);
    }
  }

  async function reorderWorktrees(parentId: string, ids: string[]) {
    const idSet = new Set(ids);
    const byId = new Map(directories.value.map(d => [d.id, d]));
    const reordered = ids.map(id => byId.get(id)).filter((d): d is WorkingDirectory => !!d);
    // Splice the reordered children back in, in the same slot order they had
    // before. Other directories keep their positions.
    const out: WorkingDirectory[] = [];
    let inserted = false;
    for (const d of directories.value) {
      if (idSet.has(d.id)) {
        if (!inserted) {
          out.push(...reordered);
          inserted = true;
        }
      } else {
        out.push(d);
      }
    }
    if (!inserted) out.push(...reordered);
    directories.value = out;
    try {
      await useRpc().request.reorderDirectories({ ids });
    } catch (e) {
      console.error("[workspace] reorderDirectories (worktrees) failed:", e);
    }
    void parentId;
  }

  async function createWorktree(parentDirectoryId: string, branch: string) {
    const dir = await useRpc().request.worktreeCreate({ parentDirectoryId, branch });
    if (!directories.value.find((d) => d.id === dir.id)) {
      directories.value = [...directories.value, dir];
    }
    return dir;
  }

  async function removeWorktree(id: string) {
    const subtree = collectSubtreeIds(id);
    await useRpc().request.worktreeRemove({ id });
    for (const sid of subtree) dropFilePanelScope(sid);
    directories.value = directories.value.filter((d) => d.id !== id);
    if (selectedDirectoryId.value === id) selectedDirectoryId.value = null;
  }

  async function renameWorktree(id: string, branch: string) {
    const updated = await useRpc().request.worktreeRename({ id, branch });
    directories.value = directories.value.map((d) => (d.id === id ? updated : d));
    return updated;
  }

  function sessionsList(scope: "all" | "current"): SessionRow[] {
    const wantDir = scope === "current" ? selectedDirectoryId.value : null;
    return buildSessionsList(
      directories.value,
      terminalTabsByDirectory.value,
      tabRuntime.value,
      wantDir,
    );
  }

  function agentsList(scope: "all" | "current"): { tab: Tab; directory: WorkingDirectory }[] {
    return sessionsList(scope)
      .filter((r) => r.agentType)
      .map(({ tab, directory }) => ({ tab, directory }));
  }

  const expandedDirectoryIds = ref<Set<string>>(new Set());

  function toggleDirectoryExpanded(id: string) {
    const next = new Set(expandedDirectoryIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedDirectoryIds.value = next;
    persistExpandedDirectoryIds();
  }

  let expandedSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function persistExpandedDirectoryIds() {
    if (expandedSaveTimer) clearTimeout(expandedSaveTimer);
    expandedSaveTimer = setTimeout(() => {
      expandedSaveTimer = null;
      const csv = Array.from(expandedDirectoryIds.value).join(",");
      useRpc().request.setAppState({ key: "directory_expanded_ids", value: csv }).catch(() => {});
    }, 300);
  }

  async function hydrateExpandedDirectoryIds() {
    try {
      const stored = await useRpc().request.getAppState({ key: "directory_expanded_ids" });
      if (stored) expandedDirectoryIds.value = new Set(stored.split(",").filter(Boolean));
    } catch {}
  }

  watch(selectedDirectoryId, (v, oldV) => {
    if (v === null) localStorage.removeItem("selectedDirectoryId");
    else localStorage.setItem("selectedDirectoryId", v);
    useRpc().request.setActiveDirectory({ directoryId: v }).catch(() => {});

    // Kill LSP immediately on directory switch
    if (oldV) {
      const oldDir = directories.value.find(d => d.id === oldV);
      if (oldDir) {
        for (const lang of LSP_LANGUAGES) stopClient(oldDir.path, lang);
      }
    }
    // Prewarm file search index for the new directory
    if (v) {
      const newDir = directories.value.find(d => d.id === v);
      if (newDir) {
        useRpc().request.prewarmFileIndex({ dir: newDir.path }).catch(() => {});
      }
    }
  });

  const selectedDirectory = computed(() =>
    directories.value.find(d => d.id === selectedDirectoryId.value) || null
  );

  // Spec selection model: activeScope == selected directory; focused session
  // == the directory's active tab (kept mirrored by focusSession).
  const activeScopeId = computed(() => selectedDirectoryId.value);
  const focusedSessionId = computed(() =>
    selectedDirectoryId.value ? activeTabIdByDirectory.value[selectedDirectoryId.value] : undefined,
  );

  function selectSession(sessionId: string) {
    for (const dir of directories.value) {
      const tabs = terminalTabsByDirectory.value[dir.id] ?? [];
      if (!tabs.some((t) => t.id === sessionId)) continue;
      if (dir.id !== selectedDirectoryId.value) selectDirectory(dir);
      const arr = arrangementFor(dir.id);
      const member = collectPaneIds(arr?.layout ?? { pane: "" }).includes(sessionId);
      if (!member) writeArrangement(dir.id, { version: 1, layout: { pane: sessionId } });
      focusSession(sessionId);
      return;
    }
  }

  const activeRoot = computed<{ path: string; scopeType: "directory" | "agent_worktree"; scopeId: string } | null>(() => {
    const dir = directories.value.find(d => d.id === selectedDirectoryId.value);
    if (!dir) return null;
    return { path: dir.path, scopeType: "directory", scopeId: dir.id };
  });

  async function fetchDirectories() {
    const rpc = useRpc();
    try {
      directories.value = await rpc.request.getDirectories({});
      // A user with existing workspaces is not a first-run user — never show
      // them the branded hero (e.g. if they later remove all workspaces).
      if (directories.value.length > 0) markWelcomeSeen();
    } finally {
      // Open the gate even on failure so the welcome/picker (with its Open
      // Folder action) shows instead of a permanently blank center pane.
      directoriesLoaded.value = true;
    }
  }

  async function createDirectory(path: string) {
    const rpc = useRpc();
    const dir = await rpc.request.createDirectory({ path });
    if (!directories.value.find(d => d.id === dir.id)) {
      directories.value.push(dir);
    }
    return dir;
  }

  // The directory plus any worktree descendants (cascade-removed on the backend).
  function collectSubtreeIds(rootId: string): string[] {
    const ids = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of directories.value) {
        if (d.parentDirectoryId && ids.has(d.parentDirectoryId) && !ids.has(d.id)) {
          ids.add(d.id);
          grew = true;
        }
      }
    }
    return [...ids];
  }

  async function deleteDirectory(id: string) {
    const rpc = useRpc();
    const dir = directories.value.find(d => d.id === id);
    const subtree = collectSubtreeIds(id);
    await rpc.request.deleteDirectory({ id });
    if (dir) {
      for (const lang of LSP_LANGUAGES) stopClient(dir.path, lang);
    }
    // Drop file-panel scope state for the removed subtree so it doesn't leak.
    for (const sid of subtree) dropFilePanelScope(sid);
    directories.value = directories.value.filter(d => d.id !== id);
    if (expandedDirectoryIds.value.has(id)) {
      const next = new Set(expandedDirectoryIds.value);
      next.delete(id);
      expandedDirectoryIds.value = next;
      persistExpandedDirectoryIds();
    }
    if (selectedDirectoryId.value === id) {
      selectedDirectoryId.value = null;
    }
  }

  /** Pick a folder, register + select it, load its tabs, and dismiss the
   *  welcome hero. The single entry point for every "open folder" affordance
   *  (App menu, Workspaces panel, welcome hero). Auto-selecting the new dir is
   *  what fixes the old add→nothing-selected dead-end. */
  async function openAndSelectWorkspace(): Promise<WorkingDirectory | null> {
    if (picking.value) return null;
    picking.value = true;
    try {
      const { path } = await useRpc().request.pickDirectory({});
      if (!path) return null;
      let dir: WorkingDirectory;
      try {
        dir = await createDirectory(path);
      } catch (e) {
        window.alert(`Failed to add directory: ${e}`);
        return null;
      }
      selectDirectory(dir);
      void loadTabsForDirectory(dir.id);
      markWelcomeSeen();
      return dir;
    } catch (e) {
      console.error("[workspace] openAndSelectWorkspace failed:", e);
      return null;
    } finally {
      picking.value = false;
    }
  }

  function selectDirectory(dir: WorkingDirectory | null) {
    selectedDirectoryId.value = dir?.id || null;
  }

  return {
    directories,
    selectedDirectoryId,
    selectedDirectory,
    activeRoot,
    loading,
    agentScope,
    expandedDirectoryIds,
    toggleDirectoryExpanded,
    hydrateExpandedDirectoryIds,
    fetchDirectories,
    createDirectory,
    deleteDirectory,
    selectDirectory,
    tabRuntime,
    applyTabUpdate,
    sessionLifecycle,
    markSessionExited,
    markSessionRunning,
    hydrateSessionLifecycle,
    oscTitleByTab,
    applyTabTitle,
    terminalTabsByDirectory,
    activeTabIdByDirectory,
    loadTabsForDirectory,
    loadAllTabs,
    createTab,
    newSession,
    splitSessionWithNew,
    splitSessionWithExisting,
    removeFromView,
    closeSession,
    focusSession,
    setArrangementSizes,
    arrangementFor,
    renameTab,
    reorderTabsInDirectory,
    tabGroupName,
    sessionName,
    syncViewportSize,
    reorderRootDirectories,
    reorderWorktrees,
    directoriesLoaded,
    welcomeSeen,
    markWelcomeSeen,
    picking,
    openAndSelectWorkspace,
    agentsList,
    sessionsList,
    arrangementByScope,
    activeScopeId,
    focusedSessionId,
    selectSession,
    hydrateArrangements,
    createWorktree,
    removeWorktree,
    renameWorktree,
  };
});
