// Per-scope bottom terminal panel state. Pure — no Pinia, no RPC.
// Surface keys: the center surface IS the directory id; each bottom tab gets
// `bottom:<dirId>:<bottomTabId>`, so one arrangement map serves both.

export const BOTTOM_SURFACE_PREFIX = "bottom:";
export const DEFAULT_BOTTOM_HEIGHT_PX = 260;
export const MIN_BOTTOM_HEIGHT_PX = 120;

export interface BottomPanelState {
  /** Ordered bottom tab ids — drag-reorder writes here. */
  tabs: string[];
  activeTabId?: string;
  /** Expanded height in px. */
  height: number;
  collapsed: boolean;
  /** Stable display number per group ("Group 3"). Assigned on create, never
   *  reused, never renumbered by a close or reorder. */
  numbers: Record<string, number>;
}

export function groupNumber(state: BottomPanelState, bottomTabId: string): number | undefined {
  return state.numbers[bottomTabId];
}

export function bottomSurfaceKey(dirId: string, bottomTabId: string): string {
  return `${BOTTOM_SURFACE_PREFIX}${dirId}:${bottomTabId}`;
}

export function isBottomSurface(key: string): boolean {
  return key.startsWith(BOTTOM_SURFACE_PREFIX);
}

export function parseBottomSurfaceKey(
  key: string,
): { dirId: string; bottomTabId: string } | null {
  if (!isBottomSurface(key)) return null;
  const rest = key.slice(BOTTOM_SURFACE_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return { dirId: rest.slice(0, i), bottomTabId: rest.slice(i + 1) };
}

export function emptyBottomPanelState(): BottomPanelState {
  return {
    tabs: [],
    activeTabId: undefined,
    height: DEFAULT_BOTTOM_HEIGHT_PX,
    collapsed: false,
    numbers: {},
  };
}

export function clampBottomHeight(px: number): number {
  return Number.isFinite(px) ? Math.max(MIN_BOTTOM_HEIGHT_PX, Math.round(px)) : DEFAULT_BOTTOM_HEIGHT_PX;
}

export function addBottomTab(state: BottomPanelState, bottomTabId: string): BottomPanelState {
  if (state.tabs.includes(bottomTabId)) return activateBottomTab(state, bottomTabId);
  // Above the highest ever issued in this scope, so a closed group's number is
  // never handed to a different terminal.
  const next = Math.max(0, ...Object.values(state.numbers)) + 1;
  return {
    ...state,
    tabs: [...state.tabs, bottomTabId],
    activeTabId: bottomTabId,
    numbers: { ...state.numbers, [bottomTabId]: next },
  };
}

export function activateBottomTab(state: BottomPanelState, bottomTabId: string): BottomPanelState {
  if (!state.tabs.includes(bottomTabId) || state.activeTabId === bottomTabId) return state;
  return { ...state, activeTabId: bottomTabId };
}

/** Remove a tab; if it held focus, prefer its right neighbour, else its left. */
export function closeBottomTabState(state: BottomPanelState, bottomTabId: string): BottomPanelState {
  const idx = state.tabs.indexOf(bottomTabId);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((id) => id !== bottomTabId);
  const activeTabId =
    state.activeTabId === bottomTabId ? tabs[idx] ?? tabs[idx - 1] ?? undefined : state.activeTabId;
  return { ...state, tabs, activeTabId };
}

export function reorderBottomTabs(state: BottomPanelState, from: number, to: number): BottomPanelState {
  if (from < 0 || to < 0 || from >= state.tabs.length || to >= state.tabs.length || from === to)
    return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

export function pruneBottomTabs(
  state: BottomPanelState,
  liveBottomTabIds: ReadonlySet<string>,
): BottomPanelState {
  const tabs = state.tabs.filter((id) => liveBottomTabIds.has(id));
  if (tabs.length === state.tabs.length) return state;
  const activeTabId =
    state.activeTabId && tabs.includes(state.activeTabId) ? state.activeTabId : tabs[0];
  return { ...state, tabs, activeTabId, numbers: numbersFor(tabs, state.numbers) };
}

/** Keep only live tabs' numbers (closed groups' numbers are gone for good). */
function numbersFor(tabs: readonly string[], numbers: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of tabs) if (numbers[id] !== undefined) out[id] = numbers[id];
  return out;
}

function normalise(raw: unknown): BottomPanelState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tabs) || !o.tabs.every((t) => typeof t === "string")) return null;
  const tabs = o.tabs as string[];
  const stored = typeof o.activeTabId === "string" ? o.activeTabId : undefined;
  const rawNumbers = (o.numbers && typeof o.numbers === "object" ? o.numbers : {}) as Record<string, unknown>;
  // State persisted before numbering existed has none — backfill positionally
  // so a restart doesn't leave groups unlabelled.
  const numbers: Record<string, number> = {};
  let next = Math.max(0, ...Object.values(rawNumbers).filter((n): n is number => typeof n === "number"));
  for (const id of tabs) numbers[id] = typeof rawNumbers[id] === "number" ? (rawNumbers[id] as number) : ++next;
  return {
    tabs,
    activeTabId: stored && tabs.includes(stored) ? stored : tabs[0],
    height: clampBottomHeight(typeof o.height === "number" ? o.height : DEFAULT_BOTTOM_HEIGHT_PX),
    collapsed: o.collapsed === true,
    numbers,
  };
}

export function parseBottomPanelMap(raw: string | null): Record<string, BottomPanelState> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, BottomPanelState> = {};
    for (const [k, v] of Object.entries(obj)) {
      const state = normalise(v);
      if (state) out[k] = state;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeBottomPanelMap(map: Record<string, BottomPanelState>): string {
  return JSON.stringify(map);
}
