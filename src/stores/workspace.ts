import { defineStore } from "pinia";
import { ref, shallowRef, triggerRef, computed, watch } from "vue";
import type { WorkingDirectory, TabUpdatedEvent, Tab, TabGroup, LayoutNode, CreateTabOpts, AgentState } from "@/types";
import { useRpc } from "@/composables/useRpc";
import { stopClient } from "@/composables/useLanguageClient";
import { dropFilePanelScope } from "@/composables/useFilePanelTabs";
import { forgetAgentNotificationTab } from "@/composables/useAgentNotifications";
import {
  parseLayout,
  firstLeaf,
  collectPaneIds,
  insertSplit,
  removeLeaf,
  applySizes,
  singlePaneResizeTargets,
  type SplitDir,
} from "@/lib/paneLayout";
import { shouldApplyAgentRevision } from "@/lib/agentStatus";

/** A pane group with its layout parsed into a tree (DB stores `layout` as JSON). */
export interface PaneGroup {
  id: string;
  directoryId: string;
  sortOrder: number;
  activePaneId?: string;
  layout: LayoutNode;
}

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

  // Split layout: each directory has an ordered list of pane GROUPS (one pill
  // per group in the tab bar); a group's `layout` is a tree of panes (= tabs).
  // `activeTabIdByDirectory` stays the source of truth for "the focused tab"
  // (Agents panel / detection / shortcuts read it) and is kept = the active
  // group's active pane.
  const tabGroupsByDirectory = ref<Record<string, PaneGroup[]>>({});
  const activeGroupIdByDirectory = ref<Record<string, string | undefined>>({});

  // Persisted "last active group" per directory (app_state JSON map) so the
  // tab the user was on is restored on reload instead of defaulting to group 0.
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
  function persistActiveGroup(dirId: string, groupId: string | undefined) {
    if (!groupId || persistedActiveGroupByDir.value[dirId] === groupId) return;
    persistedActiveGroupByDir.value = { ...persistedActiveGroupByDir.value, [dirId]: groupId };
    useRpc()
      .request.setAppState({
        key: "active_group_by_directory",
        value: JSON.stringify(persistedActiveGroupByDir.value),
      })
      .catch(() => {});
  }

  function groupsOf(dirId: string): PaneGroup[] {
    return tabGroupsByDirectory.value[dirId] ?? [];
  }

  // The owning tab's display name for a pane = the group's primary (first)
  // pane label. Precedence: manual rename → live OSC title → foreground/agent
  // process → numbered fallback. Computed live so renames propagate to rows.
  function tabGroupName(paneId: string): string {
    const loc = locateGroup(paneId);
    const dirId = loc?.dirId ?? selectedDirectoryId.value ?? "";
    const primaryId = loc ? firstLeaf(loc.group.layout) : paneId;
    const tab = (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === primaryId);

    // 1. Manual rename always wins.
    if (tab?.userRenamed && tab.label) return tab.label;
    // 2. Live OSC title from the running process.
    const osc = oscTitleByTab.value.get(primaryId);
    if (osc) return osc;
    // 3. Foreground process / agent name from detection.
    const rt = tabRuntime.value.get(primaryId);
    if (rt?.agentType) return rt.agentType.charAt(0).toUpperCase() + rt.agentType.slice(1);
    if (rt?.foregroundCommand) return rt.foregroundCommand;
    // 4. Fallback: the numbered label.
    return tab?.label ?? "shell";
  }

  function locateGroup(paneId: string): { group: PaneGroup; dirId: string } | undefined {
    for (const [dirId, groups] of Object.entries(tabGroupsByDirectory.value)) {
      for (const group of groups) {
        if (collectPaneIds(group.layout).includes(paneId)) return { group, dirId };
      }
    }
    return undefined;
  }

  function setGroups(dirId: string, groups: PaneGroup[]) {
    tabGroupsByDirectory.value = { ...tabGroupsByDirectory.value, [dirId]: groups };
  }

  /** A mounted full-area terminal reports its grid size; mirror it onto every
   *  OTHER single-pane group's PTY so a backgrounded tab is already the right
   *  size when reactivated (no SIGWINCH jump → no TUI redraw miscount that
   *  duplicates chrome / garbles text). Gated on the reporter being a single
   *  pane: only then does its container equal the whole terminal viewport. Split
   *  groups size their panes per-pane on activation, so they're left alone. */
  function syncViewportSize(reporterTabId: string, cols: number, rows: number) {
    if (cols < 1 || rows < 1) return;
    const layouts = Object.values(tabGroupsByDirectory.value).flatMap((gs) => gs.map((g) => g.layout));
    for (const tabId of singlePaneResizeTargets(layouts, reporterTabId)) {
      // No-op on the daemon if that tab has no live PTY — cheap and safe.
      void useRpc().request.tabResize({ tabId, cols, rows }).catch(() => {});
    }
  }

  function replaceGroup(dirId: string, group: PaneGroup) {
    setGroups(dirId, groupsOf(dirId).map((g) => (g.id === group.id ? group : g)));
  }

  // Mirror the active group's active pane into activeTabIdByDirectory so every
  // existing consumer of "the active tab" keeps working unchanged.
  function syncActiveTab(dirId: string) {
    const gid = activeGroupIdByDirectory.value[dirId];
    const groups = groupsOf(dirId);
    const g = groups.find((x) => x.id === gid) ?? groups[0];
    if (g && g.id !== gid) {
      activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: g.id };
    }
    const paneId = g?.activePaneId ?? (g ? firstLeaf(g.layout) : undefined);
    activeTabIdByDirectory.value = { ...activeTabIdByDirectory.value, [dirId]: paneId };
    acknowledgeTab(paneId);
    recordTabActivation(dirId, paneId);
    persistActiveGroup(dirId, g?.id);
  }

  // Serialize reconcile per directory so concurrent load paths (startup
  // loadAllTabs + a dir-select loadTabsForDirectory) can't double-create groups.
  const groupLoadInFlight = new Map<string, Promise<void>>();

  function ingestGroups(dirId: string, tabs: Tab[]): Promise<void> {
    const existing = groupLoadInFlight.get(dirId);
    if (existing) return existing;
    const run = ingestGroupsInner(dirId, tabs).finally(() => groupLoadInFlight.delete(dirId));
    groupLoadInFlight.set(dirId, run);
    return run;
  }

  // Fetch the directory's groups (always fresh — never trust a pre-fetched list,
  // which could be stale after a concurrent reconcile), prune panes that no
  // longer exist, and create a single-pane group for any uncovered tab. This is
  // also the migration path: tabs that predate groups get a group on first load.
  async function ingestGroupsInner(dirId: string, tabs: Tab[]) {
    const rows = await useRpc().request.groupsList({ directoryId: dirId });
    const valid = new Set(tabs.map((t) => t.id));
    const covered = new Set<string>();
    const groups: PaneGroup[] = [];
    for (const r of rows) {
      let layout: LayoutNode | null = parseLayout(r.layout);
      for (const pid of collectPaneIds(layout)) {
        if (!valid.has(pid)) layout = layout ? removeLeaf(layout, pid) : null;
      }
      if (!layout) {
        // All panes gone — drop the orphan group.
        void useRpc().request.groupDelete({ id: r.id }).catch(() => {});
        continue;
      }
      collectPaneIds(layout).forEach((p) => covered.add(p));
      const active = r.activePaneId && valid.has(r.activePaneId) ? r.activePaneId : firstLeaf(layout);
      groups.push({ id: r.id, directoryId: dirId, sortOrder: r.sortOrder, activePaneId: active, layout });
    }
    // Tabs without a group → give each its own single-pane group.
    for (const t of tabs) {
      if (covered.has(t.id)) continue;
      const g = await persistNewGroup(dirId, { pane: t.id }, t.id);
      groups.push(g);
    }
    groups.sort((a, b) => a.sortOrder - b.sortOrder);
    setGroups(dirId, groups);
    if (!activeGroupIdByDirectory.value[dirId] && groups.length) {
      const saved = persistedActiveGroupByDir.value[dirId];
      const initial = saved && groups.some((g) => g.id === saved) ? saved : groups[0].id;
      activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: initial };
    }
    syncActiveTab(dirId);
    await ensureTerminal(dirId);
  }

  async function persistNewGroup(dirId: string, layout: LayoutNode, activePaneId: string): Promise<PaneGroup> {
    const row = await useRpc().request.groupCreate({
      directoryId: dirId,
      layout: JSON.stringify(layout),
      activePaneId,
    });
    return { id: row.id, directoryId: dirId, sortOrder: row.sortOrder, activePaneId, layout };
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
    await ingestGroups(directoryId, tabs);
    // Override DB-backed state with daemon's live truth (survives app restarts)
    void hydrateAgentStatesFromDaemon();
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
      Object.entries(grouped).map(([dirId, list]) => ingestGroups(dirId, list)),
    );
    // Override DB-backed state with daemon's live truth (survives app restarts)
    void hydrateAgentStatesFromDaemon();
    return tabs;
  }

  async function createTab(opts: CreateTabOpts) {
    const rpc = useRpc();
    // Number new tabs by GROUP count, not total panes — splitting a tab adds
    // panes (backend tabs) that must not inflate the "1, 2, 3…" tab numbering.
    const withLabel: CreateTabOpts = opts.label
      ? opts
      : { ...opts, label: String(groupsOf(opts.directoryId).length + 1) };
    const tab = await rpc.request.tabsCreate(withLabel);
    const existing = terminalTabsByDirectory.value[opts.directoryId] ?? [];
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [opts.directoryId]: [...existing, tab],
    };
    // A new tab is its own single-pane group.
    const group = await persistNewGroup(opts.directoryId, { pane: tab.id }, tab.id);
    setGroups(opts.directoryId, [...groupsOf(opts.directoryId), group]);
    activeGroupIdByDirectory.value = {
      ...activeGroupIdByDirectory.value,
      [opts.directoryId]: group.id,
    };
    syncActiveTab(opts.directoryId);
    return tab;
  }

  /** Guarantee a directory always has ≥1 terminal — spawn a fresh one if empty. */
  async function ensureTerminal(dirId: string) {
    if (groupsOf(dirId).length === 0) await createTab({ directoryId: dirId });
  }

  /** Split a pane: spawn a new terminal beside it inside the same group. */
  async function splitPane(paneId: string, direction: SplitDir, before = false) {
    const loc = locateGroup(paneId);
    if (!loc) return;
    const { group, dirId } = loc;
    const tabsInDir = terminalTabsByDirectory.value[dirId] ?? [];
    const srcTab = tabsInDir.find((t) => t.id === paneId);
    // New panes inherit the tab's name (the primary pane's label) — they're
    // part of the same tab, not a new numbered tab.
    const primaryLabel = tabsInDir.find((t) => t.id === firstLeaf(group.layout))?.label;
    const tab = await useRpc().request.tabsCreate({ directoryId: dirId, cwd: srcTab?.cwd, label: primaryLabel });
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [dirId]: [...(terminalTabsByDirectory.value[dirId] ?? []), tab],
    };
    const layout = insertSplit(group.layout, paneId, tab.id, direction, before);
    const next: PaneGroup = { ...group, layout, activePaneId: tab.id };
    replaceGroup(dirId, next);
    activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: group.id };
    syncActiveTab(dirId);
    await useRpc().request.groupUpdateLayout({ id: group.id, layout: JSON.stringify(layout), activePaneId: tab.id }).catch(() => {});
    return tab;
  }

  /** Close every pane in a group (= closing the tab-bar pill), then the group. */
  async function closeGroup(groupId: string) {
    const dirId = Object.keys(tabGroupsByDirectory.value).find((d) =>
      groupsOf(d).some((g) => g.id === groupId),
    );
    if (!dirId) return;
    const group = groupsOf(dirId).find((g) => g.id === groupId);
    if (!group) return;
    const groups = groupsOf(dirId);
    const idx = groups.findIndex((g) => g.id === groupId);
    for (const paneId of collectPaneIds(group.layout)) {
      await destroyPane(paneId);
      forgetTab(dirId, paneId);
      forgetAgentNotificationTab(paneId);
    }
    await useRpc().request.groupDelete({ id: groupId }).catch(() => {});
    const remaining = groups.filter((g) => g.id !== groupId);
    setGroups(dirId, remaining);
    if (activeGroupIdByDirectory.value[dirId] === groupId) {
      const nextG = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
      activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: nextG?.id };
    }
    syncActiveTab(dirId);
    await ensureTerminal(dirId);
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

  /** Drop a pane's flat-list + runtime + history state (PTY stop is the caller's job). */
  function forgetTab(dirId: string, id: string) {
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [dirId]: (terminalTabsByDirectory.value[dirId] ?? []).filter((t) => t.id !== id),
    };
    tabRuntime.value.delete(id);
    triggerRef(tabRuntime);
    oscTitleByTab.value.delete(id);
    triggerRef(oscTitleByTab);
    const hist = tabActivationHistory[dirId];
    if (hist) {
      const hi = hist.indexOf(id);
      if (hi !== -1) hist.splice(hi, 1);
    }
  }

  /** Resize: persist the splitter percentages for one internal node. */
  function updateGroupSizes(groupId: string, nodeKey: string, sizes: number[]) {
    const dirId = Object.keys(tabGroupsByDirectory.value).find((d) =>
      groupsOf(d).some((g) => g.id === groupId),
    );
    if (!dirId) return;
    const group = groupsOf(dirId).find((g) => g.id === groupId);
    if (!group) return;
    const layout = applySizes(group.layout, nodeKey, sizes);
    replaceGroup(dirId, { ...group, layout });
    void useRpc().request.groupUpdateLayout({ id: groupId, layout: JSON.stringify(layout), activePaneId: group.activePaneId }).catch(() => {});
  }

  /** Drag a pane next to another pane within the same group. */
  async function movePane(paneId: string, targetPaneId: string, direction: SplitDir, before = false) {
    if (paneId === targetPaneId) return;
    const loc = locateGroup(paneId);
    if (!loc) return;
    const { group, dirId } = loc;
    if (!collectPaneIds(group.layout).includes(targetPaneId)) return; // same group only
    const removed = removeLeaf(group.layout, paneId);
    if (!removed) return;
    const layout = insertSplit(removed, targetPaneId, paneId, direction, before);
    replaceGroup(dirId, { ...group, layout });
    await useRpc().request.groupUpdateLayout({ id: group.id, layout: JSON.stringify(layout), activePaneId: group.activePaneId }).catch(() => {});
  }

  function setActivePane(groupId: string, paneId: string) {
    const dirId = Object.keys(tabGroupsByDirectory.value).find((d) =>
      groupsOf(d).some((g) => g.id === groupId),
    );
    if (!dirId) return;
    const group = groupsOf(dirId).find((g) => g.id === groupId);
    if (group && group.activePaneId !== paneId) {
      replaceGroup(dirId, { ...group, activePaneId: paneId });
    }
    activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: groupId };
    syncActiveTab(dirId);
    void useRpc().request.groupSetActivePane({ id: groupId, paneId }).catch(() => {});
  }

  function setActiveGroup(dirId: string, groupId: string) {
    activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: groupId };
    syncActiveTab(dirId);
  }

  async function reorderGroupsInDirectory(directoryId: string, ids: string[]) {
    const current = groupsOf(directoryId);
    const byId = new Map(current.map((g) => [g.id, g]));
    const reordered = ids.map((id) => byId.get(id)).filter((g): g is PaneGroup => !!g);
    if (reordered.length !== current.length) return;
    setGroups(directoryId, reordered);
    try {
      await useRpc().request.groupsReorder({ ids });
    } catch (e) {
      console.error("[workspace] groupsReorder failed:", e);
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

  // Close a single pane (= one tab). Stops the PTY, collapses it out of its
  // group's layout, and deletes the group if it was the last pane. This is
  // also the per-pane "Close Pane" action.
  async function closeTab(id: string) {
    let dirId: string | undefined;
    for (const [d, list] of Object.entries(terminalTabsByDirectory.value)) {
      if (list.some(t => t.id === id)) { dirId = d; break; }
    }
    if (!dirId) return;
    await destroyPane(id);
    forgetTab(dirId, id);
    forgetAgentNotificationTab(id);

    const group = groupsOf(dirId).find((g) => collectPaneIds(g.layout).includes(id));
    if (group) {
      const layout = removeLeaf(group.layout, id);
      if (!layout) {
        // Last pane in the group → drop the group (and its pill).
        const groups = groupsOf(dirId);
        const idx = groups.findIndex((g) => g.id === group.id);
        const remaining = groups.filter((g) => g.id !== group.id);
        setGroups(dirId, remaining);
        await useRpc().request.groupDelete({ id: group.id }).catch(() => {});
        if (activeGroupIdByDirectory.value[dirId] === group.id) {
          const nextG = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
          activeGroupIdByDirectory.value = { ...activeGroupIdByDirectory.value, [dirId]: nextG?.id };
        }
      } else {
        const survivors = collectPaneIds(layout);
        const activePaneId = survivors.includes(group.activePaneId ?? "") ? group.activePaneId : survivors[0];
        replaceGroup(dirId, { ...group, layout, activePaneId });
        await useRpc().request.groupUpdateLayout({ id: group.id, layout: JSON.stringify(layout), activePaneId }).catch(() => {});
      }
    }
    syncActiveTab(dirId);
    await ensureTerminal(dirId);
  }

  // Focus a tab by id — activates its group and marks it the active pane, so
  // every "focus this tab" caller (Agents panel, file search, cycling) works
  // regardless of splits.
  function setActiveTab(directoryId: string, tabId: string) {
    const group = groupsOf(directoryId).find((g) => collectPaneIds(g.layout).includes(tabId));
    if (group) {
      setActivePane(group.id, tabId);
      return;
    }
    activeTabIdByDirectory.value = {
      ...activeTabIdByDirectory.value,
      [directoryId]: tabId,
    };
    acknowledgeTab(tabId);
    recordTabActivation(directoryId, tabId);
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

  function agentsList(scope: "all" | "current"): { tab: Tab; directory: WorkingDirectory }[] {
    const wantDir = scope === "current" ? selectedDirectoryId.value : null;
    const out: { tab: Tab; directory: WorkingDirectory }[] = [];
    for (const dir of directories.value) {
      if (wantDir && dir.id !== wantDir) continue;
      const tabs = terminalTabsByDirectory.value[dir.id] ?? [];
      for (const t of tabs) {
        // Once runtime exists for a tab, it's authoritative — falling
        // back to the in-memory t.lastAgentType snapshot would keep
        // showing a revoked agent (daemon clears DB, but t.lastAgentType
        // here doesn't refresh until reload).
        const runtime = tabRuntime.value.get(t.id);
        const agentType = runtime ? runtime.agentType : t.lastAgentType;
        if (agentType) out.push({ tab: t, directory: dir });
      }
    }
    return out;
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
    oscTitleByTab,
    applyTabTitle,
    terminalTabsByDirectory,
    activeTabIdByDirectory,
    tabGroupsByDirectory,
    activeGroupIdByDirectory,
    loadTabsForDirectory,
    loadAllTabs,
    createTab,
    renameTab,
    closeTab,
    setActiveTab,
    reorderTabsInDirectory,
    splitPane,
    closePane: closeTab,
    closeGroup,
    tabGroupName,
    updateGroupSizes,
    movePane,
    setActivePane,
    setActiveGroup,
    syncViewportSize,
    reorderGroupsInDirectory,
    reorderRootDirectories,
    reorderWorktrees,
    directoriesLoaded,
    welcomeSeen,
    markWelcomeSeen,
    picking,
    openAndSelectWorkspace,
    agentsList,
    createWorktree,
    removeWorktree,
    renameWorktree,
  };
});
