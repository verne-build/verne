import { describe, expect, it } from "vitest";
import { staleToast } from "@/composables/useDaemonStaleness";

describe("staleToast", () => {
  it("names the restart action", () => {
    const { opts } = staleToast();
    const action = opts.action as { label: string };
    expect(action.label).toBe("Restart Now");
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
