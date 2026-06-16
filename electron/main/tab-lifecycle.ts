import type { BrowserWindow } from "electron";
import { registerNative } from "./ipc-router";
import type { DaemonClient } from "./daemon-client";
import { getDb as defaultGetDb } from "./db/connection";
import {
  getDirectory as defaultGetDirectory,
  resolveWorkspaceRoot as defaultResolveWorkspaceRoot,
} from "./db/directories";
import {
  defaultLabel,
  deleteTab as defaultDeleteTab,
  getTab as defaultGetTab,
  getTabs as defaultGetTabs,
  insertTab as defaultInsertTab,
  renameTab as defaultRenameTab,
  reorderTabs as defaultReorderTabs,
  tabDisplayLabels as defaultTabDisplayLabels,
} from "./db/tabs";
import {
  createGroup as defaultCreateGroup,
  deleteGroup as defaultDeleteGroup,
  getGroups as defaultGetGroups,
  setGroupLayout as defaultSetGroupLayout,
} from "./db/groups";
import { forgetTab as defaultForgetNotificationTab } from "./native/notifications";
import type {
  CloseGroupResult,
  CreateTabOpts,
  CreateTabResult,
  LayoutNode,
  SplitPaneResult,
  Tab,
  TabGroup,
  TabLifecycleSnapshot,
  WorkingDirectory,
} from "../../src/types/shared";

type Handler = (params: any, win: BrowserWindow) => Promise<unknown> | unknown;
type RpcClient = Pick<DaemonClient, "request">;

interface TabLifecycleDeps {
  getDb: typeof defaultGetDb;
  getDirectory: typeof defaultGetDirectory;
  resolveWorkspaceRoot: typeof defaultResolveWorkspaceRoot;
  getTabs: typeof defaultGetTabs;
  getTab: typeof defaultGetTab;
  insertTab: typeof defaultInsertTab;
  deleteTab: typeof defaultDeleteTab;
  renameTab: typeof defaultRenameTab;
  reorderTabs: typeof defaultReorderTabs;
  tabDisplayLabels: typeof defaultTabDisplayLabels;
  createGroup: typeof defaultCreateGroup;
  deleteGroup: typeof defaultDeleteGroup;
  getGroups: typeof defaultGetGroups;
  setGroupLayout: typeof defaultSetGroupLayout;
  forgetNotificationTab: typeof defaultForgetNotificationTab;
  randomId: () => string;
  now: () => number;
}

const defaultDeps: TabLifecycleDeps = {
  getDb: defaultGetDb,
  getDirectory: defaultGetDirectory,
  resolveWorkspaceRoot: defaultResolveWorkspaceRoot,
  getTabs: defaultGetTabs,
  getTab: defaultGetTab,
  insertTab: defaultInsertTab,
  deleteTab: defaultDeleteTab,
  renameTab: defaultRenameTab,
  reorderTabs: defaultReorderTabs,
  tabDisplayLabels: defaultTabDisplayLabels,
  createGroup: defaultCreateGroup,
  deleteGroup: defaultDeleteGroup,
  getGroups: defaultGetGroups,
  setGroupLayout: defaultSetGroupLayout,
  forgetNotificationTab: defaultForgetNotificationTab,
  randomId: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export interface TabLifecycleHandlers {
  tabsCreate: Handler;
  tabsSplitPane: Handler;
  tabsCloseGroup: Handler;
  tabsClose: Handler;
  tabsSessionId: Handler;
  tabsList: Handler;
  tabsRename: Handler;
  tabsReorder: Handler;
}

type SplitDir = "h" | "v";

function isLeaf(n: LayoutNode): n is { pane: string } {
  return "pane" in n;
}

function firstLeaf(n: LayoutNode): string {
  return isLeaf(n) ? n.pane : firstLeaf(n.children[0]);
}

function collectPaneIds(n: LayoutNode, out: string[] = []): string[] {
  if (isLeaf(n)) out.push(n.pane);
  else for (const c of n.children) collectPaneIds(c, out);
  return out;
}

function cloneLayout(n: LayoutNode): LayoutNode {
  return isLeaf(n)
    ? { pane: n.pane }
    : { direction: n.direction, children: n.children.map(cloneLayout), sizes: [...n.sizes] };
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

function insertSplit(
  root: LayoutNode,
  targetPane: string,
  newPane: string,
  dir: SplitDir,
  before = false,
): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (isLeaf(n)) {
      if (n.pane !== targetPane) return n;
      return {
        direction: dir,
        children: before
          ? [{ pane: newPane }, { pane: targetPane }]
          : [{ pane: targetPane }, { pane: newPane }],
        sizes: evenSizes(2),
      };
    }
    if (n.direction === dir) {
      const idx = n.children.findIndex((c) => isLeaf(c) && c.pane === targetPane);
      if (idx !== -1) {
        const children = [...n.children];
        children.splice(before ? idx : idx + 1, 0, { pane: newPane });
        return { direction: dir, children, sizes: evenSizes(children.length) };
      }
    }
    return { direction: n.direction, children: n.children.map(rec), sizes: n.sizes };
  };
  return rec(cloneLayout(root));
}

function parseLayout(raw: string): LayoutNode {
  try {
    return JSON.parse(raw) as LayoutNode;
  } catch {
    return { pane: raw };
  }
}

function emit(win: BrowserWindow, name: string, payload: unknown): void {
  win.webContents.send("daemon-event", name, payload);
}

function spawnPlanFor(
  deps: TabLifecycleDeps,
  db: ReturnType<typeof defaultGetDb>,
  tab: Pick<Tab, "id" | "directoryId" | "cwd">,
) {
  const env: Record<string, string> = {};
  const root = deps.resolveWorkspaceRoot(db, tab.directoryId);
  if (root) env.VERNE_WORKSPACE_DIR = root;
  const labels = deps.tabDisplayLabels(db, tab.id);
  return {
    tabId: tab.id,
    cwd: tab.cwd,
    env,
    agentSessionId: undefined,
    directoryName: labels.directoryName,
    tabLabel: labels.tabLabel,
  };
}

function groupById(deps: TabLifecycleDeps, db: ReturnType<typeof defaultGetDb>, groupId: string): TabGroup | undefined {
  return deps.getGroups(db, null).find((g) => g.id === groupId);
}

function snapshotFor(
  deps: TabLifecycleDeps,
  db: ReturnType<typeof defaultGetDb>,
  directoryId: string,
  activeGroupId?: string | null,
): TabLifecycleSnapshot {
  return {
    directoryId,
    tabs: deps.getTabs(db, directoryId),
    groups: deps.getGroups(db, directoryId),
    activeGroupId,
  };
}

export function createTabLifecycleHandlers(
  daemon: RpcClient,
  sidecar: RpcClient,
  partialDeps: Partial<TabLifecycleDeps> = {},
): TabLifecycleHandlers {
  const deps = { ...defaultDeps, ...partialDeps };

  return {
    async tabsCreate(params: { opts: CreateTabOpts }, win: BrowserWindow): Promise<CreateTabResult> {
      const db = deps.getDb();
      const { opts } = params;
      const dir = deps.getDirectory(db, opts.directoryId) as WorkingDirectory | undefined;
      if (!dir) throw new Error("directory not found");
      const cwd = opts.cwd ?? dir.path;
      const label = opts.label ?? defaultLabel(deps.getTabs(db, opts.directoryId).length);

      const tab: Tab = {
        id: deps.randomId(),
        directoryId: opts.directoryId,
        label,
        cwd,
        sortOrder: 0,
        createdAt: deps.now(),
        lastAgentType: undefined,
        lastAgentSessionId: undefined,
        lastAgentState: undefined,
        userRenamed: false,
      };
      deps.insertTab(db, tab);
      const group = deps.createGroup(db, tab.directoryId, JSON.stringify({ pane: tab.id }), tab.id);

      const plan = spawnPlanFor(deps, db, tab);
      try {
        await daemon.request("tab_spawn", { plan });
      } catch (e) {
        if (group) deps.deleteGroup(db, group.id);
        deps.deleteTab(db, tab.id);
        throw e;
      }
      emit(win, "tab-added", { tab });
      return { tab, group, snapshot: snapshotFor(deps, db, tab.directoryId, group?.id ?? null) };
    },

    async tabsSplitPane(
      params: { groupId: string; paneId: string; direction: SplitDir; before?: boolean },
      win: BrowserWindow,
    ): Promise<SplitPaneResult> {
      const db = deps.getDb();
      const group = groupById(deps, db, params.groupId);
      if (!group) throw new Error("group not found");
      const layout = parseLayout(group.layout);
      if (!collectPaneIds(layout).includes(params.paneId)) {
        throw new Error("pane not found in group");
      }
      const srcTab = deps.getTab(db, params.paneId);
      if (!srcTab) throw new Error("source tab not found");
      const primaryTab = deps.getTab(db, firstLeaf(layout));
      const tab: Tab = {
        id: deps.randomId(),
        directoryId: group.directoryId,
        label: primaryTab?.label ?? srcTab.label,
        cwd: srcTab.cwd,
        sortOrder: 0,
        createdAt: deps.now(),
        lastAgentType: undefined,
        lastAgentSessionId: undefined,
        lastAgentState: undefined,
        userRenamed: false,
      };
      deps.insertTab(db, tab);
      const previousLayout = group.layout;
      const previousActivePaneId = group.activePaneId ?? null;
      const nextLayout = JSON.stringify(insertSplit(layout, params.paneId, tab.id, params.direction, params.before));
      const updatedGroup: TabGroup = { ...group, layout: nextLayout, activePaneId: tab.id };
      deps.setGroupLayout(db, group.id, nextLayout, tab.id);

      try {
        await daemon.request("tab_spawn", { plan: spawnPlanFor(deps, db, tab) });
      } catch (e) {
        deps.setGroupLayout(db, group.id, previousLayout, previousActivePaneId);
        deps.deleteTab(db, tab.id);
        throw e;
      }
      emit(win, "tab-added", { tab });
      emit(win, "tab-updated", { tab });
      return { tab, group: updatedGroup, snapshot: snapshotFor(deps, db, tab.directoryId, group.id) };
    },

    async tabsClose(params: { id: string }, win: BrowserWindow) {
      await daemon.request("tab_kill", { tabId: params.id }).catch(() => {});
      deps.deleteTab(deps.getDb(), params.id);
      sidecar.request("agent_shadow_cleanup", { tabId: params.id }).catch(() => {});
      emit(win, "tab-deleted", { id: params.id });
      deps.forgetNotificationTab(params.id);
      return true;
    },

    async tabsCloseGroup(params: { id: string }, win: BrowserWindow): Promise<CloseGroupResult> {
      const db = deps.getDb();
      const group = groupById(deps, db, params.id);
      if (!group) throw new Error("group not found");
      const closedTabIds = collectPaneIds(parseLayout(group.layout));

      await Promise.all(
        closedTabIds.map((tabId) => daemon.request("tab_kill", { tabId }).catch(() => {})),
      );
      for (const tabId of closedTabIds) {
        deps.deleteTab(db, tabId);
        sidecar.request("agent_shadow_cleanup", { tabId }).catch(() => {});
        deps.forgetNotificationTab(tabId);
        emit(win, "tab-deleted", { id: tabId });
      }
      deps.deleteGroup(db, group.id);
      return {
        directoryId: group.directoryId,
        groupId: group.id,
        closedTabIds,
        snapshot: snapshotFor(deps, db, group.directoryId, null),
      };
    },

    tabsSessionId(params: { id: string }) {
      const db = deps.getDb();
      const tab = deps.getTab(db, params.id);
      if (!tab) throw new Error("tab not found");
      return daemon.request("tab_spawn", { plan: spawnPlanFor(deps, db, tab) });
    },

    tabsList(params: { directoryId?: string | null }) {
      return deps.getTabs(deps.getDb(), params.directoryId);
    },

    tabsRename(params: { id: string; label: string }, win: BrowserWindow) {
      const db = deps.getDb();
      deps.renameTab(db, params.id, params.label);
      const tab = deps.getTab(db, params.id);
      if (!tab) throw new Error("tab gone after rename");
      emit(win, "tab-updated", { tab });
      return tab;
    },

    tabsReorder(params: { ids: string[] }, win: BrowserWindow) {
      deps.reorderTabs(deps.getDb(), params.ids);
      emit(win, "tabs-reordered", { ids: params.ids });
      return true;
    },
  };
}

// Tab lifecycle spans both processes (Star topology): Electron owns the DB row,
// the daemon owns the live PTY, and the sidecar owns agent-shadow teardown.
export function registerTabLifecycle(daemon: DaemonClient, sidecar: DaemonClient): void {
  const handlers = createTabLifecycleHandlers(daemon, sidecar);
  registerNative("tabs_create", handlers.tabsCreate);
  registerNative("tabs_split_pane", handlers.tabsSplitPane);
  registerNative("tabs_close_group", handlers.tabsCloseGroup);
  registerNative("tabs_close", handlers.tabsClose);
  registerNative("tabs_session_id", handlers.tabsSessionId);
  registerNative("tabs_list", handlers.tabsList);
  registerNative("tabs_rename", handlers.tabsRename);
  registerNative("tabs_reorder", handlers.tabsReorder);
}
