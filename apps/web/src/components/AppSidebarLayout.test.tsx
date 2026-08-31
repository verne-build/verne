import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { onOpenCommandPalette } from "../commandPaletteBus";
import { SidebarProvider } from "./ui/sidebar";
import { openSidebarSearch, SidebarControlButtons } from "./AppSidebarLayout";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map(),
}));

vi.mock("./SidebarStageBackdrop", () => ({
  resolveSidebarStageFocusRingOffsetClass: () => "",
  useSidebarStageBackdropVariant: () => null,
}));

describe("SidebarControlButtons", () => {
  beforeEach(() => {
    class TestCustomEvent<T> extends Event {
      readonly detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    }

    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("CustomEvent", TestCustomEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the command palette from the search button", () => {
    let opened = false;
    const unsubscribe = onOpenCommandPalette(() => {
      opened = true;
    });
    try {
      openSidebarSearch();
      expect(opened).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("renders search beside the toggle while the sidebar is collapsed", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <SidebarControlButtons
          isSidebarVisible={false}
          searchShortcutLabel={null}
          stageBackdropVariant={null}
          toggleShortcutLabel={null}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Toggle main sidebar"');
    expect(markup).toContain('aria-label="Search"');
  });
});
