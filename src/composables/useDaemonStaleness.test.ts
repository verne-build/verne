import { describe, expect, it } from "vitest";
import { staleToast } from "@/composables/useDaemonStaleness";

describe("staleToast", () => {
  it("names the restart action", () => {
    const { opts } = staleToast();
    const action = opts.action as { label: string };
    expect(action.label).toBe("Restart Daemon");
  });

  it("persists until acted on and stays dismissible", () => {
    const { opts } = staleToast();
    expect(opts.duration).toBe(Infinity);
    expect(opts.closeButton).toBe(true);
  });

  it("uses a stable id so it never stacks", () => {
    expect(staleToast().opts.id).toBe(staleToast().opts.id);
  });

  it("warns that sessions will end", () => {
    expect(String(staleToast().opts.description)).toMatch(/sessions will end/i);
  });
});
