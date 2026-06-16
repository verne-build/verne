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
import { forgetTab as defaultForgetNotificationTab } from "./native/notifications";
import type { CreateTabOpts, Tab, WorkingDirectory } from "../../src/types/shared";

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
  forgetNotificationTab: defaultForgetNotificationTab,
  randomId: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export interface TabLifecycleHandlers {
  tabsCreate: Handler;
  tabsClose: Handler;
  tabsSessionId: Handler;
  tabsList: Handler;
  tabsRename: Handler;
  tabsReorder: Handler;
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

export function createTabLifecycleHandlers(
  daemon: RpcClient,
  sidecar: RpcClient,
  partialDeps: Partial<TabLifecycleDeps> = {},
): TabLifecycleHandlers {
  const deps = { ...defaultDeps, ...partialDeps };

  return {
    async tabsCreate(params: { opts: CreateTabOpts }, win: BrowserWindow) {
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

      const plan = spawnPlanFor(deps, db, tab);
      try {
        await daemon.request("tab_spawn", { plan });
      } catch (e) {
        deps.deleteTab(db, tab.id);
        throw e;
      }
      emit(win, "tab-added", { tab });
      return tab;
    },

    async tabsClose(params: { id: string }, win: BrowserWindow) {
      await daemon.request("tab_kill", { tabId: params.id }).catch(() => {});
      deps.deleteTab(deps.getDb(), params.id);
      sidecar.request("agent_shadow_cleanup", { tabId: params.id }).catch(() => {});
      emit(win, "tab-deleted", { id: params.id });
      deps.forgetNotificationTab(params.id);
      return true;
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
  registerNative("tabs_close", handlers.tabsClose);
  registerNative("tabs_session_id", handlers.tabsSessionId);
  registerNative("tabs_list", handlers.tabsList);
  registerNative("tabs_rename", handlers.tabsRename);
  registerNative("tabs_reorder", handlers.tabsReorder);
}
