import { afterEach, describe, expect, it, vi } from "vitest";
import { staleToast } from "@/composables/useDaemonStaleness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("staleToast", () => {
  it("names the restart action", () => {
    const { opts } = staleToast();
    const action = opts.action as { label: string };
    expect(action.label).toBe("Restart Now");
  });

  // sonner auto-dismisses on action click unless the handler claims the event.
  // Without this the toast vanishes before the confirm dialog is answered, so
  // cancelling leaves the user stale with no prompt and no way back but the menu.
  it("survives a cancelled confirm dialog", () => {
    const invoke = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { verne: { invoke } });

    const action = staleToast().opts.action as { onClick: (e: Event) => void };
    let prevented = false;
    action.onClick({ preventDefault: () => { prevented = true; } } as unknown as Event);

    expect(prevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("daemon_restart_confirm", undefined);
  });

  it("persists until acted on and stays dismissible", () => {
    const { opts } = staleToast();
    expect(opts.duration).toBe(Infinity);
    expect(opts.closeButton).toBe(true);
  });

  it("uses a stable id so it never stacks", () => {
    expect(staleToast().opts.id).toBe(staleToast().opts.id);
  });

  it("warns that open terminals close", () => {
    expect(String(staleToast().opts.description)).toMatch(/terminals will close/i);
  });

  // The whole point of the rewrite — internal vocabulary must not leak here.
  it("keeps daemon jargon out of user-facing copy", () => {
    const { title, opts } = staleToast();
    expect(`${title} ${opts.description}`).not.toMatch(/daemon/i);
  });
});
