import { defineStore } from "pinia";
import { ref, shallowRef, triggerRef, computed, watch, onScopeDispose } from "vue";
import { toast } from "vue-sonner";
import type {
  WorkingDirectory,
  TabUpdatedEvent,
  Tab,
  CreateTabOpts,
  AgentLaunchSelection,
  AgentState,
  GitBranch,
  TabArchivedEvent,
  TabUnarchivedEvent,
} from "@/types";
import { useRpc } from "@/composables/useRpc";
import { moveTabBetweenBuckets } from "@/lib/scopeMove";
import { stopClient } from "@/composables/useLanguageClient";
import { dropFilePanelScope } from "@/composables/useFilePanelTabs";
import { forgetAgentNotificationTab } from "@/composables/useAgentNotifications";
import {
  firstLeaf,
  collectPaneIds,
  singlePaneResizeTargets,
  type SplitDir,
} from "@/lib/paneLayout";
import {
  activateBottomTab,
  addBottomTab,
  bottomSurfaceKey,
  clampBottomHeight,
  closeBottomTabState,
  emptyBottomPanelState,
  isBottomSurface,
  parseBottomPanelMap,
  parseBottomSurfaceKey,
  pruneBottomTabs,
  reorderBottomTabs,
  serializeBottomPanelMap,
  setGroupName,
  type BottomPanelState,
} from "@/lib/bottomPanel";
import { shouldApplyAgentRevision } from "@/lib/agentStatus";
import { sessionTitleFrom } from "@/lib/sessionTitle";
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

export interface PickerSessionStart {
  directoryId: string;
  mode: "current" | "worktree";
  branch: GitBranch;
  agentLaunch?: AgentLaunchSelection;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const directories = ref<WorkingDirectory[]>([]);
  const selectedDirectoryId = ref<string | null>(
    localStorage.getItem("selectedDirectoryId")
  );
  const pendingPicker = ref<{ dirId: string } | null>(null);
  let selectionRevision = 0;
  let pickerRevision = 0;
  watch(selectedDirectoryId, () => {
    selectionRevision += 1;
  }, { flush: "sync" });
  watch(pendingPicker, () => {
    pickerRevision += 1;
  }, { flush: "sync" });

  function openSessionPicker(dirId = selectedDirectoryId.value ?? undefined): void {
    if (!dirId || !directories.value.some((dir) => dir.id === dirId)) return;
    pendingPicker.value = { dirId };
  }

  function closeSessionPicker(): void {
    pendingPicker.value = null;
  }

  const loading = ref(false);
  // First-run UI state. directoriesLoaded gates the welcome hero so it never
  // flashes before the initial getDirectories() resolves. welcomeSeen makes the
  // branded hero one-time (localStorage).
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

  function applyTabUpdate(
    payload: TabUpdatedEvent,
    { hydrating = false }: { hydrating?: boolean } = {},
  ) {
    const prev = tabRuntime.value.get(payload.tabId);
    if (!shouldApplyAgentRevision(prev?.revision, payload.revision)) return;
    if (!hydrating && (prev?.agentType ?? null) !== (payload.agentType ?? null))
      stampActivity(payload.tabId, payload.lastOutputAt ?? payload.changedAt ?? Date.now());
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
    patchTabIdentityFromEvent(payload);
  }

  /** Main stamps the LATCHED identity + derived `resumeAvailable` on every
   *  tab-updated. Patch the stored row so Resume appears as soon as a session id
   *  is captured — the row is otherwise only refreshed by tabs_list/create/
   *  rename/archive, so resume would stay dead until an app relaunch. Only swaps
   *  when a field actually changed, to keep the reactive array off the status
   *  tick. */
  function patchTabIdentityFromEvent(payload: TabUpdatedEvent): void {
    if (payload.resumeAvailable === undefined && payload.lastAgentType === undefined) return;
    const dirId = tabDirId(payload.tabId);
    if (!dirId) return;
    const existing = (terminalTabsByDirectory.value[dirId] ?? []).find(
      (t) => t.id === payload.tabId,
    );
    if (!existing) return;
    const lastAgentType = payload.lastAgentType ?? undefined;
    const lastAgentSessionId = payload.lastAgentSessionId ?? undefined;
    const resumeAvailable = payload.resumeAvailable ?? false;
    if (
      existing.lastAgentType === lastAgentType
      && existing.lastAgentSessionId === lastAgentSessionId
      && (existing.resumeAvailable ?? false) === resumeAvailable
    )
      return;
    replaceTab({ ...existing, lastAgentType, lastAgentSessionId, resumeAvailable });
  }

  // Lifecycle is orthogonal to agent state (spec: session rows carry both).
  // Missing entry = assumed running (hydration fills the truth).
  const sessionLifecycle = shallowRef<Map<string, "running" | "exited">>(new Map());

  // Recency snapshot for card sorting (re-rank on discrete events only —
  // creation/close/agent-type change/scope move; never selection or status ticks).
  const sessionActivityAt = shallowRef<Map<string, number>>(new Map());
  const activityVersion = ref(0);
  function stampActivity(tabId: string, at = Date.now()) {
    sessionActivityAt.value.set(tabId, at);
    triggerRef(sessionActivityAt);
    activityVersion.value += 1;
  }

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
        for (const t of tabs) {
          // Archived tabs have no PTY to track — leave them out of lifecycle
          // entirely instead of marking them exited.
          if (t.archivedAt != null) continue;
          if (!mine.has(t.id)) next.set(t.id, live.has(t.id) ? "running" : "exited");
        }
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
  const tabsLoadInFlight = new Map<string, Promise<Tab[]>>();
  // Per-directory activation history (most-recent-last) so closing the active
  // tab falls back to the previously-active tab, not index 0.
  const tabActivationHistory: Record<string, string[]> = {};

  // ---- sessions model (slice 2: arrangements own writes) ----
  // Per-scope layout tree of session (== tab) ids. This is now the single
  // write model for "what panes are visible and how" — groups (below) are
  // read-only, kept only for the one-time migration.
  const arrangementByScope = ref<Record<string, Arrangement>>({});
  let arrangementsHydrated: Promise<void> | null = null;
  // Until a hydrate has succeeded once, ensureLayoutModel2 must not persist
  // prune/backfill writes — a transient boot failure would otherwise persist a
  // map missing every other scope's arrangement.
  let arrangementsHydratedOk = false;

  function hydrateArrangements(): Promise<void> {
    arrangementsHydrated ??= useRpc()
      .request.getAppState({ key: "arrangement_by_scope" })
      .then((raw) => {
        arrangementByScope.value = { ...parseArrangementMap(raw), ...arrangementByScope.value };
        arrangementsHydratedOk = true;
      })
      .catch(() => {
        // Clear the memo so the next load retries instead of staying stale.
        arrangementsHydrated = null;
      });
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

  // Which surface (center == dirId, or `bottom:<dirId>:<bottomTabId>`) currently
  // holds each session. Computed once per arrangement change — callers must not
  // rescan the map per lookup.
  const surfaceKeyBySession = computed(() => {
    const m = new Map<string, string>();
    for (const [key, arr] of Object.entries(arrangementByScope.value))
      for (const id of collectPaneIds(arr.layout)) m.set(id, key);
    return m;
  });

  /** Surface owning `sessionId`; falls back to its directory (center) for a
   *  session not yet in any arrangement. */
  function surfaceKeyFor(sessionId: string): string | undefined {
    return surfaceKeyBySession.value.get(sessionId) ?? tabDirId(sessionId);
  }

  /** Drop a pane from a specific surface, deleting the surface if it empties.
   *  An emptied BOTTOM surface also drops its tab — otherwise the tab id lingers
   *  in bottomPanelByScope with no arrangement (ghost tab: a tab bar over an
   *  empty body, self-healing only on the next app load). */
  function detachFromSurface(surfaceKey: string, sessionId: string): void {
    const current = arrangementFor(surfaceKey);
    if (!current) return;
    const next = removeFromArrangement(current, sessionId);
    writeArrangement(surfaceKey, next);
    if (next) return;
    const parsed = parseBottomSurfaceKey(surfaceKey);
    if (!parsed) return;
    clearFocusForScope(surfaceKey);
    const state = bottomPanelFor(parsed.dirId);
    if (state?.tabs.includes(parsed.bottomTabId))
      writeBottomPanel(parsed.dirId, closeBottomTabState(state, parsed.bottomTabId));
  }

  // ---- bottom terminal panel ----
  const bottomPanelByScope = ref<Record<string, BottomPanelState>>({});
  let bottomPanelHydrated: Promise<void> | null = null;
  // Same guard as arrangementsHydratedOk: until one hydrate has succeeded the
  // in-memory map is missing every OTHER scope, so persisting it would drop
  // their bottom tabs for good (orphaning running PTYs with no UI to reach).
  let bottomPanelHydratedOk = false;

  function hydrateBottomPanel(): Promise<void> {
    bottomPanelHydrated ??= useRpc()
      .request.getAppState({ key: "bottom_panel_by_scope" })
      .then((raw) => {
        bottomPanelByScope.value = { ...parseBottomPanelMap(raw), ...bottomPanelByScope.value };
        bottomPanelHydratedOk = true;
      })
      .catch(() => {
        bottomPanelHydrated = null; // retry on next load
      });
    return bottomPanelHydrated;
  }

  function bottomPanelFor(dirId: string): BottomPanelState | null {
    return bottomPanelByScope.value[dirId] ?? null;
  }

  function writeBottomPanel(dirId: string, state: BottomPanelState | null) {
    const map = { ...bottomPanelByScope.value };
    if (state && state.tabs.length) map[dirId] = state;
    else delete map[dirId];
    bottomPanelByScope.value = map;
    if (!bottomPanelHydratedOk) return;
    useRpc()
      .request.setAppState({ key: "bottom_panel_by_scope", value: serializeBottomPanelMap(map) })
      .catch(() => {});
  }

  /** Which surface last took terminal focus — routes ⌘T/⌘W, ⌘W's kill and the
   *  split keys. INTENT only: `activeSurface` below discards it whenever the
   *  selected scope has no expanded, non-empty bottom panel, so scope switches,
   *  ⌘J collapses and the last bottom tab closing all invalidate it without any
   *  per-callsite bookkeeping. */
  const activeSurfaceIntent = ref<"center" | "bottom">("center");

  /** Is the selected scope's bottom panel actually on screen and non-empty? */
  const bottomSurfaceVisible = computed(() => {
    const dirId = selectedDirectoryId.value;
    const state = dirId ? bottomPanelByScope.value[dirId] : null;
    return !!state && state.tabs.length > 0 && !state.collapsed;
  });

  const activeSurface = computed<"center" | "bottom">(() =>
    activeSurfaceIntent.value === "bottom" && bottomSurfaceVisible.value ? "bottom" : "center",
  );

  /** Sessions in `dirId` that live in the CENTER (i.e. not in a bottom tab). */
  function centerSessions(dirId: string): Tab[] {
    const bySession = surfaceKeyBySession.value;
    return (terminalTabsByDirectory.value[dirId] ?? []).filter(
      (t) => !isBottomSurface(bySession.get(t.id) ?? dirId),
    );
  }

  async function createBottomTerminal(dirId: string): Promise<Tab | null> {
    const dir = directories.value.find((d) => d.id === dirId);
    if (!dir) return null;
    // Never build on an un-hydrated map (writeBottomPanel would refuse to
    // persist, silently losing the new tab across a relaunch).
    await hydrateBottomPanel();
    const existing = terminalTabsByDirectory.value[dirId] ?? [];
    const tab = await useRpc().request.tabsCreate({
      directoryId: dirId,
      cwd: dir.path,
      label: String(existing.length + 1),
    });
    // Re-read post-await (see newSession) so a concurrent create isn't dropped.
    const current = terminalTabsByDirectory.value[dirId] ?? [];
    terminalTabsByDirectory.value = { ...terminalTabsByDirectory.value, [dirId]: [...current, tab] };
    stampActivity(tab.id);
    const bottomTabId = crypto.randomUUID();
    writeArrangement(bottomSurfaceKey(dirId, bottomTabId), { version: 1, layout: { pane: tab.id } });
    writeBottomPanel(dirId, {
      ...addBottomTab(bottomPanelFor(dirId) ?? emptyBottomPanelState(), bottomTabId),
      collapsed: false,
    });
    focusSession(tab.id);
    // Pin so scope-repin.ts never moves this tab on a cwd change — a bottom
    // terminal must stay put; applyScopeChange's bottom-surface guard is
    // belt-and-braces, not the primary defense.
    useRpc()
      .request.tabSetScopePinned({ id: tab.id, pinned: true })
      .then(() => setTabScopePinnedLocal(tab.id, true))
      .catch(() => {});
    return tab;
  }

  /** Kill one bottom pane; drops its tab when it was the tab's last pane. */
  async function closeBottomPane(sessionId: string): Promise<void> {
    const surfaceKey = surfaceKeyFor(sessionId);
    const parsed = surfaceKey ? parseBottomSurfaceKey(surfaceKey) : null;
    if (!surfaceKey || !parsed) return;
    const { dirId, bottomTabId } = parsed;
    const wasFocused = focusedByScope.value[surfaceKey] === sessionId;
    await destroyPane(sessionId);
    forgetTab(sessionId);
    forgetAgentNotificationTab(sessionId);
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [dirId]: (terminalTabsByDirectory.value[dirId] ?? []).filter((t) => t.id !== sessionId),
    };
    const current = arrangementFor(surfaceKey);
    const next = current ? removeFromArrangement(current, sessionId) : null;
    writeArrangement(surfaceKey, next);
    if (next) {
      if (wasFocused) focusSession(firstLeaf(next.layout));
      return;
    }
    // Surface destroyed — bottom tab ids are fresh UUIDs, never reused, so a
    // leftover focusedByScope[surfaceKey] entry would otherwise persist forever.
    clearFocusForScope(surfaceKey);
    const state = bottomPanelFor(dirId);
    if (state) writeBottomPanel(dirId, closeBottomTabState(state, bottomTabId));
    const remaining = bottomPanelFor(dirId);
    const nextTabId = remaining?.activeTabId;
    if (nextTabId) {
      const nextArr = arrangementFor(bottomSurfaceKey(dirId, nextTabId));
      if (nextArr && wasFocused) focusSession(firstLeaf(nextArr.layout));
    } else {
      activeSurfaceIntent.value = "center";
    }
  }

  /** VS Code's "Unsplit Terminal": move a pane out of its split into a new
   *  bottom group. Drops the grouping only — the PTY keeps running. */
  function unsplitBottomPane(sessionId: string): void {
    const surfaceKey = surfaceKeyFor(sessionId);
    const parsed = surfaceKey ? parseBottomSurfaceKey(surfaceKey) : null;
    if (!surfaceKey || !parsed) return; // center sessions have no groups to leave
    const { dirId } = parsed;
    const current = arrangementFor(surfaceKey);
    const state = bottomPanelFor(dirId);
    if (!current || !state) return;
    const remaining = removeFromArrangement(current, sessionId);
    if (!remaining) return; // already alone: nothing to unsplit
    writeArrangement(surfaceKey, remaining);
    const newGroupId = crypto.randomUUID();
    writeArrangement(bottomSurfaceKey(dirId, newGroupId), { version: 1, layout: { pane: sessionId } });
    writeBottomPanel(dirId, addBottomTab(bottomPanelFor(dirId) ?? state, newGroupId));
    focusSession(sessionId);
  }

  async function closeBottomTab(dirId: string, bottomTabId: string): Promise<void> {
    const key = bottomSurfaceKey(dirId, bottomTabId);
    const arr = arrangementFor(key);
    const panes = arr ? collectPaneIds(arr.layout) : [];
    for (const id of panes) await closeBottomPane(id);
    // Defensive: an already-empty surface still needs its tab dropped.
    const state = bottomPanelFor(dirId);
    if (state?.tabs.includes(bottomTabId)) writeBottomPanel(dirId, closeBottomTabState(state, bottomTabId));
    writeArrangement(key, null);
  }

  /** Name a GROUP. Deliberately not renameTab: a group's name is its own, and
   *  writing it onto the primary pane would rename that terminal too. */
  function renameBottomGroup(dirId: string, bottomTabId: string, name: string): void {
    const state = bottomPanelFor(dirId);
    if (!state) return;
    writeBottomPanel(dirId, setGroupName(state, bottomTabId, name));
  }

  function activateBottomPanelTab(dirId: string, bottomTabId: string): void {
    const state = bottomPanelFor(dirId);
    if (!state) return;
    writeBottomPanel(dirId, { ...activateBottomTab(state, bottomTabId), collapsed: false });
    const arr = arrangementFor(bottomSurfaceKey(dirId, bottomTabId));
    if (arr) focusSession(focusedByScope.value[bottomSurfaceKey(dirId, bottomTabId)] ?? firstLeaf(arr.layout));
  }

  function reorderBottomPanelTabs(dirId: string, from: number, to: number): void {
    const state = bottomPanelFor(dirId);
    if (!state) return;
    writeBottomPanel(dirId, reorderBottomTabs(state, from, to));
  }

  function setBottomPanelCollapsed(dirId: string, collapsed: boolean): void {
    const state = bottomPanelFor(dirId);
    if (!state || state.collapsed === collapsed) return;
    writeBottomPanel(dirId, { ...state, collapsed });
  }

  function setBottomPanelHeight(dirId: string, px: number): void {
    const state = bottomPanelFor(dirId);
    const height = clampBottomHeight(px);
    if (!state || state.height === height) return;
    writeBottomPanel(dirId, { ...state, height });
  }

  const bottomFocusedSessionId = computed(() => {
    const dirId = selectedDirectoryId.value;
    const state = dirId ? bottomPanelFor(dirId) : null;
    if (!dirId || !state?.activeTabId) return undefined;
    const key = bottomSurfaceKey(dirId, state.activeTabId);
    const arr = arrangementFor(key);
    if (!arr) return undefined;
    return focusedByScope.value[key] ?? firstLeaf(arr.layout);
  });

  const focusedSessionIdForActiveSurface = computed(() =>
    activeSurface.value === "bottom" ? bottomFocusedSessionId.value : focusedSessionId.value,
  );

  /** Split-with-existing candidates for a surface: live, same scope, same
   *  surface class, and not already on screen in that surface. */
  function splittableSessions(surfaceKey: string): SessionRow[] {
    const parsed = parseBottomSurfaceKey(surfaceKey);
    const dirId = parsed?.dirId ?? surfaceKey;
    const arr = arrangementFor(surfaceKey);
    const inView = new Set(arr ? collectPaneIds(arr.layout) : []);
    const bySession = surfaceKeyBySession.value;
    return buildSessionsList(directories.value, terminalTabsByDirectory.value, tabRuntime.value, dirId)
      .filter((row) => {
        if (inView.has(row.tab.id) || row.tab.archivedAt != null) return false;
        const key = bySession.get(row.tab.id) ?? dirId;
        return parsed ? isBottomSurface(key) : !isBottomSurface(key);
      });
  }

  const focusedByScope = ref<Record<string, string | undefined>>({});
  let focusedHydrated: Promise<void> | null = null;

  function hydrateFocusedByScope(): Promise<void> {
    focusedHydrated ??= useRpc()
      .request.getAppState({ key: "focused_by_scope" })
      .then((raw) => {
        if (!raw) return;
        try {
          const stored = JSON.parse(raw) as Record<string, string | undefined>;
          focusedByScope.value = { ...stored, ...focusedByScope.value };
          // focusedSessionId reads activeTabIdByDirectory — mirror hydrated
          // focus into it without clobbering focus set this session.
          // Bottom surface keys are not directory ids — mirroring them would
          // land inert `bottom:<dir>:<uuid>` entries in the selection map that
          // only accumulate across restarts.
          const active = { ...activeTabIdByDirectory.value };
          for (const [dirId, sid] of Object.entries(stored))
            if (sid && !isBottomSurface(dirId) && active[dirId] === undefined) active[dirId] = sid;
          activeTabIdByDirectory.value = active;
        } catch {}
      })
      .catch(() => {
        focusedHydrated = null; // retry on next load
      });
    return focusedHydrated;
  }

  function focusSession(sessionId: string) {
    const surfaceKey = surfaceKeyFor(sessionId);
    if (!surfaceKey) return;
    const changed = focusedByScope.value[surfaceKey] !== sessionId;
    focusedByScope.value = { ...focusedByScope.value, [surfaceKey]: sessionId };
    activeSurfaceIntent.value = isBottomSurface(surfaceKey) ? "bottom" : "center";
    // Center focus mirrors into activeTabIdByDirectory (the selection model);
    // bottom focus must NOT, or focusing a bottom terminal would move the
    // center's active session.
    if (!isBottomSurface(surfaceKey)) {
      activeTabIdByDirectory.value = { ...activeTabIdByDirectory.value, [surfaceKey]: sessionId };
      recordTabActivation(surfaceKey, sessionId);
    }
    acknowledgeTab(sessionId);
    if (changed)
      useRpc()
        .request.setAppState({ key: "focused_by_scope", value: JSON.stringify(focusedByScope.value) })
        .catch(() => {});
  }

  function tabDirId(sessionId: string): string | undefined {
    for (const [dirId, tabs] of Object.entries(terminalTabsByDirectory.value))
      if (tabs.some((t) => t.id === sessionId)) return dirId;
    return undefined;
  }

  /** Clear a scope's focus bookkeeping (no live survivor to fall onto) and
   *  persist, same write path as focusSession. */
  function clearFocusForScope(dirId: string) {
    const nextFocused = { ...focusedByScope.value };
    delete nextFocused[dirId];
    focusedByScope.value = nextFocused;
    const nextActive = { ...activeTabIdByDirectory.value };
    delete nextActive[dirId];
    activeTabIdByDirectory.value = nextActive;
    useRpc()
      .request.setAppState({ key: "focused_by_scope", value: JSON.stringify(focusedByScope.value) })
      .catch(() => {});
  }

  /** Optimistic local mirror of tab_set_scope_pinned (which emits no event) —
   *  call after the RPC resolves so the Follow Agent checkbox doesn't go
   *  stale. */
  function setTabScopePinnedLocal(tabId: string, pinned: boolean) {
    const dirId = tabDirId(tabId);
    if (!dirId) return;
    const list = terminalTabsByDirectory.value[dirId] ?? [];
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1 || list[idx].scopePinnedByUser === pinned) return;
    const next = [...list];
    next[idx] = { ...next[idx], scopePinnedByUser: pinned };
    terminalTabsByDirectory.value = { ...terminalTabsByDirectory.value, [dirId]: next };
  }

  async function newSession(
    directoryId: string,
    opts: { cwd?: string; label?: string; agentLaunch?: AgentLaunchSelection } = {},
  ): Promise<Tab> {
    const existing = terminalTabsByDirectory.value[directoryId] ?? [];
    const tab = await useRpc().request.tabsCreate({
      directoryId,
      cwd: opts.cwd,
      label: opts.label ?? String(existing.length + 1),
      agentLaunch: opts.agentLaunch,
    });
    // Re-read post-await — a concurrent newSession in this directory may have
    // already appended its own tab; spreading the stale pre-await snapshot
    // would drop it.
    const current = terminalTabsByDirectory.value[directoryId] ?? [];
    terminalTabsByDirectory.value = {
      ...terminalTabsByDirectory.value,
      [directoryId]: [...current, tab],
    };
    stampActivity(tab.id);
    writeArrangement(directoryId, { version: 1, layout: { pane: tab.id } });
    focusSession(tab.id);
    return tab;
  }

  // Compat alias — App.vue/menu callers use the CreateTabOpts shape.
  const createTab = (opts: CreateTabOpts): Promise<Tab> =>
    newSession(opts.directoryId, {
      cwd: opts.cwd,
      label: opts.label,
      agentLaunch: opts.agentLaunch,
    });

  async function splitSessionWithNew(sessionId: string, direction: SplitDir, before = false): Promise<void> {
    const dirId = tabDirId(sessionId);
    const surfaceKey = surfaceKeyFor(sessionId);
    if (!dirId || !surfaceKey) return;
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
    writeArrangement(
      surfaceKey,
      insertIntoArrangement(arrangementFor(surfaceKey), sessionId, tab.id, direction, before),
    );
    focusSession(tab.id);
  }

  // Same-scope only — cross-scope moves are forbidden by spec (a session never
  // leaves the directory that owns its PTY). Cross-SURFACE within a scope is
  // allowed: the source surface is detached first.
  function splitSessionWithExisting(sessionId: string, otherSessionId: string, direction: SplitDir, before = false): void {
    const dirId = tabDirId(sessionId);
    const surfaceKey = surfaceKeyFor(sessionId);
    const otherKey = surfaceKeyFor(otherSessionId);
    if (!dirId || !surfaceKey || !otherKey || tabDirId(otherSessionId) !== dirId) return;
    const current = arrangementFor(surfaceKey);
    if (!current) return;
    if (otherKey === surfaceKey) {
      const without = removeFromArrangement(current, otherSessionId) ?? current;
      writeArrangement(surfaceKey, insertIntoArrangement(without, sessionId, otherSessionId, direction, before));
    } else {
      detachFromSurface(otherKey, otherSessionId);
      writeArrangement(
        surfaceKey,
        insertIntoArrangement(arrangementFor(surfaceKey), sessionId, otherSessionId, direction, before),
      );
      // Show the destination tab: detaching the source may have handed "active"
      // to an unrelated neighbour, leaving the merged pane off screen.
      const dest = parseBottomSurfaceKey(surfaceKey);
      const destState = dest ? bottomPanelFor(dest.dirId) : null;
      if (dest && destState)
        writeBottomPanel(dest.dirId, {
          ...activateBottomTab(destState, dest.bottomTabId),
          collapsed: false,
        });
    }
    focusSession(otherSessionId);
  }

  /** Drop a session out of its surface's arrangement without killing its PTY. */
  function removeFromView(sessionId: string): void {
    const surfaceKey = surfaceKeyFor(sessionId);
    if (!surfaceKey) return;
    const current = arrangementFor(surfaceKey);
    if (!current) return;
    const next = removeFromArrangement(current, sessionId);
    writeArrangement(surfaceKey, next);
    if (focusedByScope.value[surfaceKey] === sessionId && next) focusSession(firstLeaf(next.layout));
  }

  function setArrangementSizes(scopeId: string, key: string, sizes: number[]): void {
    const current = arrangementFor(scopeId);
    if (current) writeArrangement(scopeId, applyArrangementSizes(current, key, sizes));
  }

  // Title precedence: manual rename → generated title → live daemon display
  // title → persisted display title → live OSC title → foreground/agent
  // process → numbered fallback.
  // Computed live so renames (and generated titles) propagate to rows.
  // Precedence itself lives in sessionTitleFrom (testable without Pinia).
  // Named `sessionName` post slice-2 (one session == one pane, no more group
  // indirection); `tabGroupName` alias kept for one slice to limit consumer
  // churn.
  function sessionName(sessionId: string): string {
    const dirId = tabDirId(sessionId) ?? selectedDirectoryId.value ?? "";
    const tab = (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === sessionId);
    const rt = tabRuntime.value.get(sessionId);
    return sessionTitleFrom({
      userRenamed: tab?.userRenamed,
      label: tab?.label,
      generatedTitle: tab?.generatedTitle,
      displayTitle: rt?.displayTitle ?? undefined,
      storedDisplayTitle: tab?.displayTitle,
      oscTitle: oscTitleByTab.value.get(sessionId),
      agentType: rt?.agentType ?? undefined,
      foregroundCommand: rt?.foregroundCommand,
    });
  }
  const tabGroupName = sessionName;

  /** Mirror a full-pane terminal's grid only to hidden tabs that share its exact
   *  viewport. Center scopes are isolated per directory because their available
   *  height depends on that directory's bottom panel. Bottom tabs share a
   *  viewport only with other bottom tabs in the same directory. */
  function syncViewportSize(reporterTabId: string, cols: number, rows: number) {
    if (cols < 1 || rows < 1) return;
    const entries = Object.entries(arrangementByScope.value);
    const reporterScope = entries.find(([, a]) => collectPaneIds(a.layout).includes(reporterTabId))?.[0];
    if (!reporterScope) return;
    const reporterBottom = parseBottomSurfaceKey(reporterScope);
    const layouts = entries
      .filter(([scopeId]) => {
        if (!reporterBottom) return scopeId === reporterScope;
        return parseBottomSurfaceKey(scopeId)?.dirId === reporterBottom.dirId;
      })
      .map(([, a]) => a.layout);
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
  // Per-dir in-flight de-dupe: concurrent loads share one run.
  const ensureLayoutInFlight = new Map<string, Promise<void>>();
  function ensureSessionForEmptyDir(dirId: string): void {
    if (centerSessions(dirId).length) return;
    if (dirId === selectedDirectoryId.value) openSessionPicker(dirId);
  }

  function ensureLayoutModel2(dirId: string, tabs: Tab[]): Promise<void> {
    const existing = ensureLayoutInFlight.get(dirId);
    if (existing) return existing;
    const run = doEnsureLayoutModel2(dirId, tabs).finally(() => ensureLayoutInFlight.delete(dirId));
    ensureLayoutInFlight.set(dirId, run);
    return run;
  }

  // Drop a hydrated focus id that no longer names a live session in dirId's
  // bucket, so focusedSessionId can't keep pointing at a pruned/closed
  // session after relaunch.
  function pruneStaleFocusId(dirId: string, tabs: Tab[]) {
    const live = new Set(tabs.map((t) => t.id));
    const focused = focusedByScope.value[dirId];
    if (focused && !live.has(focused)) {
      const next = { ...focusedByScope.value };
      delete next[dirId];
      focusedByScope.value = next;
    }
    const active = activeTabIdByDirectory.value[dirId];
    if (active && !live.has(active)) {
      const next = { ...activeTabIdByDirectory.value };
      delete next[dirId];
      activeTabIdByDirectory.value = next;
    }
    // Bottom surface keys are `bottom:<dirId>:<uuid>` — never reused once the
    // tab is gone, so a stale entry (dead arrangement, or a focused pane that
    // isn't live) would otherwise leak into focused_by_scope forever.
    let bottomChanged = false;
    const nextFocused = { ...focusedByScope.value };
    for (const key of Object.keys(nextFocused)) {
      const parsed = parseBottomSurfaceKey(key);
      if (!parsed || parsed.dirId !== dirId) continue;
      const paneId = nextFocused[key];
      if (!arrangementFor(key) || !paneId || !live.has(paneId)) {
        delete nextFocused[key];
        bottomChanged = true;
      }
    }
    if (bottomChanged) focusedByScope.value = nextFocused;
  }

  async function doEnsureLayoutModel2(dirId: string, tabs: Tab[]) {
    await Promise.all([hydrateArrangements(), hydrateFocusedByScope(), hydrateBottomPanel()]);
    pruneStaleFocusId(dirId, tabs);
    const flagKey = `layout_model:${dirId}`;
    const model = await useRpc().request.getAppState({ key: flagKey });
    if (model !== "2") {
      const raw = await useRpc().request.groupsList({ directoryId: dirId });
      const { arrangements, focusedByDir, orderByDir } = migrateGroupsToArrangements(
        { [dirId]: raw },
        { [dirId]: persistedActiveGroupByDir.value[dirId] },
      );
      if (arrangements[dirId]) writeArrangement(dirId, arrangements[dirId]);
      const order = orderByDir[dirId];
      if (order?.length) {
        await useRpc().request.tabsReorder({ ids: order }).catch(() => {});
        // Mirror the persisted order in memory so the sidebar matches now,
        // not on the next load.
        const current = terminalTabsByDirectory.value[dirId] ?? [];
        const byId = new Map(current.map((t) => [t.id, t]));
        const orderSet = new Set(order);
        const reordered = [
          ...order.map((id) => byId.get(id)).filter((t): t is Tab => !!t),
          ...current.filter((t) => !orderSet.has(t.id)),
        ];
        terminalTabsByDirectory.value = { ...terminalTabsByDirectory.value, [dirId]: reordered };
      }
      if (focusedByDir[dirId]) focusSession(focusedByDir[dirId]!);
      await useRpc().request.setAppState({ key: flagKey, value: "2" });
    }
    // Prune/backfill only once hydration has succeeded (see hydrate guard).
    if (arrangementsHydratedOk) {
      const live = new Set(tabs.map((t) => t.id));
      // Bottom surfaces first, so centerSessions() below sees the truth.
      const bottom = bottomPanelHydratedOk ? bottomPanelFor(dirId) : null;
      if (bottom) {
        const survivors = new Set<string>();
        for (const bottomTabId of bottom.tabs) {
          const key = bottomSurfaceKey(dirId, bottomTabId);
          const arr = arrangementFor(key);
          const pruned = arr ? pruneArrangement(arr, live) : null;
          if (JSON.stringify(pruned) !== JSON.stringify(arr)) writeArrangement(key, pruned);
          if (pruned) survivors.add(bottomTabId);
        }
        const nextState = pruneBottomTabs(bottom, survivors);
        if (nextState !== bottom) writeBottomPanel(dirId, nextState);
      }
      // Prune the center arrangement against live tabs (dead sessions dropped).
      const arr = arrangementFor(dirId);
      const pruned = arr ? pruneArrangement(arr, live) : null;
      if (JSON.stringify(pruned) !== JSON.stringify(arr)) writeArrangement(dirId, pruned);
      const center = centerSessions(dirId);
      if (!arrangementFor(dirId) && center.length)
        writeArrangement(dirId, { version: 1, layout: { pane: center[center.length - 1].id } });
    }
    // Empty selected scopes route to the picker without creating a session.
    if (!centerSessions(dirId).length && dirId === selectedDirectoryId.value)
      ensureSessionForEmptyDir(dirId);
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
    // Gated on lastAgentState, NOT lastAgentType: the type is latched now, so an
    // exited tab keeps it and would seed a bogus "idle" dot (permanently if
    // listLiveTabIds rejects and lifecycle stays empty = assumed running).
    // clearStaleTabStates nulls the state column for every tab with no live PTY
    // while exempting archived rows, so archived tabs still seed.
    for (const t of tabs) {
      if (t.lastAgentState) {
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
        applyTabUpdate(
          {
            tabId: s.tabId,
            agentState: s.agentState as import("@/types").AgentState,
            agentType: s.agentType,
            revision: s.revision,
            source: s.source,
            changedAt: s.changedAt,
            lastOutputAt: s.lastOutputAt,
            lastAgentSessionId: s.lastAgentSessionId ?? undefined,
            displayTitle: s.displayTitle ?? undefined,
          },
          { hydrating: true },
        );
        if (!sessionActivityAt.value.has(s.tabId))
          stampActivity(s.tabId, s.lastOutputAt ?? s.changedAt ?? 0);
        if (s.title) applyTabTitle({ tabId: s.tabId, title: s.title });
      }
    } catch (_e) {
      // Non-fatal: DB fallback from hydrateTabRuntime is still valid
    }
  }

  async function performTabsLoad(directoryId: string): Promise<Tab[]> {
    const rpc = useRpc();
    const bucketAtRequest = terminalTabsByDirectory.value[directoryId];
    const loadedTabs = await rpc.request.tabsList({ directoryId });
    // Every store writer replaces a directory's array. If it changed while
    // this request was pending, that newer local mutation/load wins.
    const bucketUnchanged = terminalTabsByDirectory.value[directoryId] === bucketAtRequest;
    const tabs = bucketUnchanged
      ? loadedTabs
      : terminalTabsByDirectory.value[directoryId] ?? [];
    if (bucketUnchanged) {
      terminalTabsByDirectory.value = {
        ...terminalTabsByDirectory.value,
        [directoryId]: tabs,
      };
    }
    hydrateTabRuntime(tabs);
    await hydrateActiveGroups();
    await ensureLayoutModel2(directoryId, tabs);
    // Override DB-backed state with daemon's live truth (survives app restarts)
    void hydrateAgentStatesFromDaemon();
    void hydrateSessionLifecycle();
    return tabs;
  }

  function loadTabsForDirectory(directoryId: string): Promise<Tab[]> {
    const existing = tabsLoadInFlight.get(directoryId);
    if (existing) return existing;

    const request = performTabsLoad(directoryId);
    tabsLoadInFlight.set(directoryId, request);
    const clear = () => {
      if (tabsLoadInFlight.get(directoryId) === request)
        tabsLoadInFlight.delete(directoryId);
    };
    void request.then(clear, clear);
    return request;
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
    const dirId = tabDirId(id);
    const tab = dirId ? (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === id) : undefined;
    // Exited or archived session: no live PTY to resolve — tabsSessionId
    // would pointlessly respawn a shell (or resurrect an archived one) just
    // to kill it. Straight to tabsClose, never respawn.
    if (sessionLifecycle.value.get(id) === "exited" || tab?.archivedAt != null) {
      await useRpc().request.tabsClose({ id }).catch(() => {});
      return;
    }
    // Live session: this ordering is sacred (resolve BEFORE close, dispose after).
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
    const deletedActivity = sessionActivityAt.value.delete(id);
    triggerRef(sessionActivityAt);
    if (deletedActivity) activityVersion.value += 1;
    for (const hist of Object.values(tabActivationHistory)) {
      const hi = hist.indexOf(id);
      if (hi !== -1) hist.splice(hi, 1);
    }
  }

  /** Kill a session's PTY, drop its row, and remove it from its scope's
   *  arrangement. Replaces closeTab/closePane/closeGroup. */
  async function closeSession(sessionId: string): Promise<void> {
    const surfaceKey = surfaceKeyFor(sessionId);
    if (surfaceKey && isBottomSurface(surfaceKey)) return closeBottomPane(sessionId);
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
      const remaining = centerSessions(dirId);
      const wasFocused = focusedByScope.value[dirId] === sessionId;
      if (next) writeArrangement(dirId, next);
      else if (remaining.length) writeArrangement(dirId, { version: 1, layout: { pane: remaining[remaining.length - 1].id } });
      else writeArrangement(dirId, null);
      const arr = arrangementFor(dirId);
      // Only refocus when the closed session actually held focus — a
      // background/non-focused pane closing shouldn't steal focus.
      if (arr && wasFocused) focusSession(firstLeaf(arr.layout));
      if (!remaining.length) {
        clearFocusForScope(dirId);
        if (dirId === selectedDirectoryId.value) openSessionPicker(dirId);
      }
    }
  }

  /** New scope discovered by the backend (e.g. auto re-pin creating/using a
   *  worktree the renderer hasn't seen yet). Idempotent. */
  function applyDirectoryAdded(directory: WorkingDirectory) {
    if (!directories.value.some((d) => d.id === directory.id))
      directories.value = [...directories.value, directory];
  }

  /** A session's owning scope changed server-side (manual move, worktree
   *  removal re-pin, or cwd-driven auto re-pin). Moves the tab between
   *  buckets, reconciles the source arrangement/focus, and offers an undo. */
  function applyScopeChange(ev: { tabId: string; fromDirectoryId: string; toDirectoryId: string; cwd: string }) {
    if (isBottomSurface(surfaceKeyFor(ev.tabId) ?? "")) return;
    // Echo guard: if the tab is already in the destination bucket (e.g. a
    // local optimistic apply already landed), moveTabBetweenBuckets would
    // no-op on the FROM side too — check membership up front and skip
    // silently, no duplicate toast.
    const alreadyMoved = (terminalTabsByDirectory.value[ev.toDirectoryId] ?? []).some(
      (t) => t.id === ev.tabId,
    );
    if (alreadyMoved) return;
    // Neither-bucket guard: the tab isn't in the FROM bucket either — a
    // broadcast racing initial load. Nothing local to reconcile.
    const inFromBucket = (terminalTabsByDirectory.value[ev.fromDirectoryId] ?? []).some(
      (t) => t.id === ev.tabId,
    );
    if (!inFromBucket) return;
    const label = tabGroupName(ev.tabId);
    // Capture BEFORE the source-arrangement collapse mutates focus below —
    // spec: if the moved session was the focused session of the active
    // scope, the right panel follows it to its new scope.
    const wasFocusedActiveSession =
      ev.fromDirectoryId === selectedDirectoryId.value && focusedByScope.value[ev.fromDirectoryId] === ev.tabId;
    terminalTabsByDirectory.value = moveTabBetweenBuckets(
      terminalTabsByDirectory.value,
      ev.tabId,
      ev.fromDirectoryId,
      ev.toDirectoryId,
      ev.cwd,
    );
    stampActivity(ev.tabId);
    // Source arrangement: slot collapses; focus falls to the survivor (spec).
    const src = arrangementFor(ev.fromDirectoryId);
    const wasFocusedSource = focusedByScope.value[ev.fromDirectoryId] === ev.tabId;
    if (src) {
      const next = removeFromArrangement(src, ev.tabId);
      writeArrangement(ev.fromDirectoryId, next);
      if (wasFocusedSource) {
        if (next) focusSession(firstLeaf(next.layout));
        else clearFocusForScope(ev.fromDirectoryId);
      }
    } else if (wasFocusedSource) {
      clearFocusForScope(ev.fromDirectoryId);
    }
    // Destination arrangement untouched — session enters it on selection (spec).
    const toName = directories.value.find((d) => d.id === ev.toDirectoryId)?.name ?? "scope";
    // The source scope may have just been deleted (worktree_remove orphan
    // re-pin) — only offer Undo if it still exists; re-check at click time
    // too since directories can change between toast and click.
    const fromExistsAtToastTime = directories.value.some((d) => d.id === ev.fromDirectoryId);
    toast(`${label} moved to ${toName}`, {
      ...(fromExistsAtToastTime
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                if (!directories.value.some((d) => d.id === ev.fromDirectoryId)) {
                  toast.error("Original scope no longer exists");
                  return;
                }
                void useRpc()
                  .request.tabMoveToDirectory({ id: ev.tabId, directoryId: ev.fromDirectoryId })
                  .then(() => setTabScopePinnedLocal(ev.tabId, true))
                  .catch(() => {});
                // Manual move pins server-side; the resulting session-scope-changed
                // round-trip is what actually applies the undo in the UI.
              },
            },
          }
        : {}),
      duration: 8000,
    });
    // Spec: if the moved session was the focused session of the active
    // scope, the right panel swaps scopes to follow it.
    if (wasFocusedActiveSession) {
      const dest = directories.value.find((d) => d.id === ev.toDirectoryId);
      if (dest) {
        selectDirectory(dest);
        selectSession(ev.tabId);
      }
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

  /** Replace a tab in its directory bucket, keyed by id. Idempotent — safe to
   *  apply the same (or a stale-duplicate) tab twice. Never touches the
   *  arrangement, so a session's pane leaf survives the swap untouched. */
  function replaceTab(tab: Tab): void {
    const list = terminalTabsByDirectory.value[tab.directoryId] ?? [];
    const next = list.map((t) => (t.id === tab.id ? tab : t));
    terminalTabsByDirectory.value = { ...terminalTabsByDirectory.value, [tab.directoryId]: next };
  }

  /** Apply a tab that just finished archiving (from the RPC response or the
   *  daemon's `tab-archived` broadcast). Idempotent: replaceTab is a keyed
   *  swap and dropping an already-absent lifecycle entry is a no-op. */
  function applyArchivedTab(tab: Tab): void {
    replaceTab(tab);
    sessionLifecycle.value.delete(tab.id);
    triggerRef(sessionLifecycle);
  }

  /** Archive a live session: snapshot + kill the PTY server-side, then mirror
   *  the resulting (now-archived) tab locally. Never call tabsSessionId/
   *  tabsClose here — that's the daemon's job inside tabs_archive. */
  async function archiveSession(id: string): Promise<void> {
    const tab = await useRpc().request.tabsArchive({ id });
    applyArchivedTab(tab);
  }

  function handleTabArchivedEvent(e: Event) {
    const detail = (e as CustomEvent<TabArchivedEvent>).detail;
    if (detail?.tab) applyArchivedTab(detail.tab);
  }
  window.addEventListener("tab-archived", handleTabArchivedEvent as EventListener);
  onScopeDispose(() => window.removeEventListener("tab-archived", handleTabArchivedEvent as EventListener));

  /** Apply a freshly generated session title (main's `tab-title-generated`).
   *  Patches the one field via the existing keyed swap so nothing else in the
   *  tab — or the arrangement — is disturbed. */
  function handleTabTitleGenerated(e: Event) {
    const detail = (e as CustomEvent<{ tabId: string; title: string }>).detail;
    if (!detail?.tabId || !detail.title) return;
    const dirId = tabDirId(detail.tabId);
    if (!dirId) return;
    const existing = (terminalTabsByDirectory.value[dirId] ?? []).find((t) => t.id === detail.tabId);
    if (!existing) return;
    replaceTab({ ...existing, generatedTitle: detail.title });
  }
  window.addEventListener("tab-title-generated", handleTabTitleGenerated as EventListener);
  onScopeDispose(() =>
    window.removeEventListener("tab-title-generated", handleTabTitleGenerated as EventListener),
  );

  /** Apply a tab that just came back from archive (RPC response or the daemon's
   *  `tab-unarchived` broadcast). Idempotent: replaceTab is a keyed swap; mark
   *  the (now-live) session running so TerminalPane attaches to its PTY. */
  function applyUnarchivedTab(tab: Tab): void {
    replaceTab(tab);
    markSessionRunning(tab.id);
  }

  /** Un-archive a session: spawn its PTY server-side (optionally resuming the
   *  agent), mirror the now-live tab locally, then surface it in the pane via
   *  the normal open/attach path. */
  async function unarchiveSession(id: string, resume: boolean): Promise<void> {
    const tab = await useRpc().request.tabsUnarchive({ id, resume });
    applyUnarchivedTab(tab);
    selectSession(id);
  }

  function handleTabUnarchivedEvent(e: Event) {
    const detail = (e as CustomEvent<TabUnarchivedEvent>).detail;
    if (detail?.tab) applyUnarchivedTab(detail.tab);
  }
  window.addEventListener("tab-unarchived", handleTabUnarchivedEvent as EventListener);
  onScopeDispose(() => window.removeEventListener("tab-unarchived", handleTabUnarchivedEvent as EventListener));

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

  async function createWorktree(parentDirectoryId: string, branch?: string, baseRef?: string) {
    const dir = await useRpc().request.worktreeCreate({ parentDirectoryId, branch, baseRef });
    if (!directories.value.find((d) => d.id === dir.id)) {
      directories.value = [...directories.value, dir];
    }
    return dir;
  }

  function worktreeRoot(directoryId: string): WorkingDirectory {
    const byId = new Map(directories.value.map((directory) => [directory.id, directory]));
    let current = byId.get(directoryId);
    if (!current) throw new Error("directory not found");
    const seen = new Set<string>();
    while (current.parentDirectoryId) {
      if (seen.has(current.id)) throw new Error("worktree parent cycle");
      seen.add(current.id);
      const parent = byId.get(current.parentDirectoryId);
      if (!parent) throw new Error("worktree parent not found");
      current = parent;
    }
    return current;
  }

  async function startPickerSession(input: PickerSessionStart): Promise<Tab> {
    const source = directories.value.find((directory) => directory.id === input.directoryId);
    if (!source) throw new Error("directory not found");

    if (input.mode === "current") {
      if (!input.branch.isHead)
        await useRpc().request.gitCheckoutBranch({
          path: source.path,
          name: input.branch.name,
          isRemote: input.branch.isRemote,
          remoteRef: input.branch.isRemote
            ? input.branch.fullRef.replace(/^refs\/remotes\//, "")
            : undefined,
        });
      return newSession(source.id, { agentLaunch: input.agentLaunch });
    }

    const root = worktreeRoot(source.id);
    const selectionBeforeLaunch = selectedDirectoryId.value;
    const pendingPickerBeforeLaunch = pendingPicker.value
      ? { ...pendingPicker.value }
      : null;
    const selectionRevisionBeforeLaunch = selectionRevision;
    const pickerRevisionBeforeLaunch = pickerRevision;
    let created: WorkingDirectory | null = null;
    try {
      created = await createWorktree(root.id, "", input.branch.name);
      const tab = await newSession(created.id, { agentLaunch: input.agentLaunch });
      const ownsNavigation =
        selectionRevision === selectionRevisionBeforeLaunch
        && pickerRevision === pickerRevisionBeforeLaunch;
      if (ownsNavigation) {
        selectedDirectoryId.value = created.id;
        pendingPicker.value = null;
      }
      return tab;
    } catch (error) {
      if (!created) throw error;
      let cleanupError: unknown;
      let cleanupSucceeded = false;
      try {
        await useRpc().request.worktreeRemove({ id: created.id, force: true });
        cleanupSucceeded = true;
      } catch (cleanup) {
        cleanupError = cleanup;
      }
      if (cleanupSucceeded) {
        dropFilePanelScope(created.id);
        sweepRemovedScopes([created.id]);
        directories.value = directories.value.filter((directory) => directory.id !== created!.id);
        const hasLiveDirectory = (id: string | null): id is string =>
          id !== null && directories.value.some((directory) => directory.id === id);
        const selectionFallback = [selectionBeforeLaunch, root.id, source.id]
          .find(hasLiveDirectory) ?? null;
        const pickerFallback = pendingPickerBeforeLaunch
          && hasLiveDirectory(pendingPickerBeforeLaunch.dirId)
          ? pendingPickerBeforeLaunch
          : null;
        if (selectedDirectoryId.value === created.id)
          selectedDirectoryId.value = selectionFallback;
        if (pendingPicker.value?.dirId === created.id)
          pendingPicker.value = pickerFallback;
      }
      if (cleanupError) {
        const launchMessage = error instanceof Error ? error.message : String(error);
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${launchMessage}; cleanup failed: ${cleanupMessage}`);
      }
      throw error;
    }
  }

  async function removeWorktree(id: string) {
    const subtree = collectSubtreeIds(id);
    await useRpc().request.worktreeRemove({ id });
    for (const sid of subtree) dropFilePanelScope(sid);
    sweepRemovedScopes(subtree);
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
    const rows = buildSessionsList(
      directories.value,
      terminalTabsByDirectory.value,
      tabRuntime.value,
      wantDir,
    );
    // Index lookup, never surfaceKeyFor — its tabDirId fallback would rescan
    // every directory for every row the arrangements don't hold.
    const bySession = surfaceKeyBySession.value;
    return rows.filter((row) => !isBottomSurface(bySession.get(row.tab.id) ?? row.directory.id));
  }

  function agentsList(scope: "all" | "current"): { tab: Tab; directory: WorkingDirectory }[] {
    // A LIVE agent has a live state, not merely a latched type (same re-keying as
    // agentCount in db/tabs.ts) — otherwise every session that ever ran an agent
    // shows up in the palette.
    return sessionsList(scope)
      .filter((r) => r.agentType && tabRuntime.value.get(r.tab.id)?.agentState != null)
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
      const existingSurface = surfaceKeyFor(sessionId);
      const bottom = existingSurface ? parseBottomSurfaceKey(existingSurface) : null;
      if (bottom) {
        if (dir.id !== selectedDirectoryId.value) selectDirectory(dir);
        activateBottomPanelTab(bottom.dirId, bottom.bottomTabId);
        focusSession(sessionId);
        return;
      }
      if (dir.id !== selectedDirectoryId.value) selectDirectory(dir);
      closeSessionPicker();
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
      const selectedId = selectedDirectoryId.value;
      const selectedTabs = selectedId
        ? terminalTabsByDirectory.value[selectedId]
        : undefined;
      // A persisted selection's empty tab load can finish before its directory
      // exists locally, making openSessionPicker reject it. Retry once directory
      // hydration makes the already-loaded scope valid.
      if (selectedId && selectedTabs && !selectedTabs.length && !ensureLayoutInFlight.has(selectedId))
        ensureSessionForEmptyDir(selectedId);
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

  /** Dead-scope sweep: removed directories must not leak tab buckets,
   *  lifecycle entries, or persisted arrangements. */
  function sweepRemovedScopes(scopeIds: string[]) {
    const tabsMap = { ...terminalTabsByDirectory.value };
    const arrMap = { ...arrangementByScope.value };
    let tabsChanged = false;
    let lifecycleChanged = false;
    let arrChanged = false;
    for (const sid of scopeIds) {
      const bucket = tabsMap[sid];
      if (bucket) {
        for (const t of bucket)
          if (sessionLifecycle.value.delete(t.id)) lifecycleChanged = true;
        delete tabsMap[sid];
        tabsChanged = true;
      }
      if (arrMap[sid]) {
        delete arrMap[sid];
        arrChanged = true;
      }
    }
    if (tabsChanged) terminalTabsByDirectory.value = tabsMap;
    if (lifecycleChanged) triggerRef(sessionLifecycle);
    if (arrChanged) {
      arrangementByScope.value = arrMap;
      useRpc()
        .request.setAppState({ key: "arrangement_by_scope", value: serializeArrangementMap(arrMap) })
        .catch(() => {});
    }
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
    sweepRemovedScopes(subtree);
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

  /** Pick a folder, register + select it, and dismiss the
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
    if (dir && pendingPicker.value) pendingPicker.value = { dirId: dir.id };
    // Already-loaded empty scopes can route immediately. Otherwise the guarded
    // load tail opens the picker only if this scope is still selected.
    if (
      dir &&
      terminalTabsByDirectory.value[dir.id] &&
      !terminalTabsByDirectory.value[dir.id].length &&
      !ensureLayoutInFlight.has(dir.id)
    )
      ensureSessionForEmptyDir(dir.id);
  }

  return {
    directories,
    selectedDirectoryId,
    pendingPicker,
    openSessionPicker,
    closeSessionPicker,
    selectedDirectory,
    activeRoot,
    loading,
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
    sessionActivityAt,
    activityVersion,
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
    focusedByScope,
    setArrangementSizes,
    arrangementFor,
    writeArrangement,
    surfaceKeyFor,
    detachFromSurface,
    activeSurface,
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
    startPickerSession,
    removeWorktree,
    renameWorktree,
    applyDirectoryAdded,
    applyScopeChange,
    setTabScopePinnedLocal,
    replaceTab,
    applyArchivedTab,
    archiveSession,
    applyUnarchivedTab,
    unarchiveSession,
    bottomPanelByScope,
    bottomPanelFor,
    centerSessions,
    createBottomTerminal,
    closeBottomPane,
    closeBottomTab,
    unsplitBottomPane,
    activateBottomPanelTab,
    renameBottomGroup,
    reorderBottomPanelTabs,
    setBottomPanelCollapsed,
    setBottomPanelHeight,
    bottomFocusedSessionId,
    focusedSessionIdForActiveSurface,
    splittableSessions,
    hydrateBottomPanel,
  };
});
