import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { type BottomDrawerTab } from "../terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "../types";

const MIN_BOTTOM_DRAWER_HEIGHT = 180;
const MAX_BOTTOM_DRAWER_HEIGHT_RATIO = 0.75;

export function clampBottomDrawerHeight(height: number, viewportHeight: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = Math.max(
    MIN_BOTTOM_DRAWER_HEIGHT,
    Math.floor(viewportHeight * MAX_BOTTOM_DRAWER_HEIGHT_RATIO),
  );
  return Math.min(Math.max(Math.round(safeHeight), MIN_BOTTOM_DRAWER_HEIGHT), maxHeight);
}

function currentViewportHeight(): number {
  return typeof window === "undefined"
    ? Math.ceil(DEFAULT_THREAD_TERMINAL_HEIGHT / MAX_BOTTOM_DRAWER_HEIGHT_RATIO)
    : window.innerHeight;
}

export function bottomDrawerTabItems(selectedTab: BottomDrawerTab) {
  return [
    { id: "terminal" as const, label: "Terminal", selected: selectedTab === "terminal" },
    { id: "ports" as const, label: "Ports", selected: selectedTab === "ports" },
  ];
}

interface ThreadBottomDrawerRenderContext {
  height: number;
  resizeEpoch: number;
}

interface ThreadBottomDrawerProps {
  drawerKey: string;
  visible?: boolean;
  height: number;
  selectedTab: BottomDrawerTab;
  onTabChange: (tab: BottomDrawerTab) => void;
  onHeightChange: (height: number) => void;
  renderTerminal: (context: ThreadBottomDrawerRenderContext) => ReactNode;
  portsPanel: ReactNode;
}

export default function ThreadBottomDrawer({
  drawerKey,
  visible = true,
  height,
  selectedTab,
  onTabChange,
  onHeightChange,
  renderTerminal,
  portsPanel,
}: ThreadBottomDrawerProps) {
  const panelIdPrefix = useId();
  const controlledHeight = clampBottomDrawerHeight(height, currentViewportHeight());
  const [heightState, setHeightState] = useState(() => ({
    drawerKey,
    height: controlledHeight,
  }));
  const drawerHeight = heightState.drawerKey === drawerKey ? heightState.height : controlledHeight;
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) => {
      setHeightState((current) => {
        const currentHeight = current.drawerKey === drawerKey ? current.height : controlledHeight;
        const nextHeight = typeof update === "function" ? update(currentHeight) : update;
        return nextHeight === currentHeight && current.drawerKey === drawerKey
          ? current
          : { drawerKey, height: nextHeight };
      });
    },
    [controlledHeight, drawerKey],
  );
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) => {
    setDrawerHeight(nextHeight);
  });
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(controlledHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampBottomDrawerHeight(nextHeight, currentViewportHeight());
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    lastSyncedHeightRef.current = controlledHeight;
  }, [controlledHeight, drawerKey]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampBottomDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
        currentViewportHeight(),
      );
      if (clampedHeight === drawerHeightRef.current) return;
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [setDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) return;
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) return;
    const onWindowResize = () => {
      const clampedHeight = clampBottomDrawerHeight(
        drawerHeightRef.current,
        currentViewportHeight(),
      );
      if (clampedHeight !== drawerHeightRef.current) {
        setDrawerHeightFromWindowResize(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) syncHeight(clampedHeight);
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [syncHeight, visible]);

  useEffect(() => {
    if (visible) setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => () => syncHeight(drawerHeightRef.current), [syncHeight]);

  const tabs = bottomDrawerTabItems(selectedTab);
  return (
    <aside
      data-terminal-owner="drawer"
      className="thread-bottom-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        aria-label="Resize bottom drawer"
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />
      <div
        aria-label="Bottom drawer"
        className="flex h-8 shrink-0 items-end border-b border-border/80 px-2"
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${panelIdPrefix}-${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={tab.selected}
            aria-controls={`${panelIdPrefix}-${tab.id}-panel`}
            className={cn(
              "h-7 border-b-2 px-2 text-xs transition-colors",
              tab.selected
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${panelIdPrefix}-${selectedTab}-panel`}
        role="tabpanel"
        aria-labelledby={`${panelIdPrefix}-${selectedTab}-tab`}
        className="min-h-0 flex-1"
      >
        {selectedTab === "terminal"
          ? renderTerminal({ height: drawerHeight, resizeEpoch })
          : portsPanel}
      </div>
    </aside>
  );
}
