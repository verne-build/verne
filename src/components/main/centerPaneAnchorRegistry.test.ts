// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCenterPaneAnchorRegistry } from "./centerPaneAnchorRegistry";

const anchorId = "center-pane:dir-1:session-a";

function connectedElement(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("CenterPaneAnchorRegistry", () => {
  it("registers and resolves an anchor target", () => {
    const registry = createCenterPaneAnchorRegistry();
    const element = connectedElement();

    registry.register(anchorId, element);

    expect(registry.target(anchorId)).toBe(element);
    expect(registry.revision.value).toBe(1);
    element.remove();
  });

  it("keeps a replacement when the old element unregisters later", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldElement = connectedElement();
    const newElement = connectedElement();

    registry.register(anchorId, oldElement);
    registry.register(anchorId, newElement);
    const revisionAfterReplacement = registry.revision.value;
    registry.unregister(anchorId, oldElement);

    expect(registry.target(anchorId)).toBe(newElement);
    expect(registry.revision.value).toBe(revisionAfterReplacement);
    oldElement.remove();
    newElement.remove();
  });

  it("removes the current element and advances revision", () => {
    const registry = createCenterPaneAnchorRegistry();
    const element = connectedElement();

    registry.register(anchorId, element);
    registry.unregister(anchorId, element);

    expect(registry.target(anchorId)).toBeNull();
    expect(registry.revision.value).toBe(2);
    element.remove();
  });

  it("warns once when two connected elements register under one ID", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldElement = connectedElement();
    const newElement = connectedElement();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    registry.register(anchorId, oldElement);
    registry.register(anchorId, newElement);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    oldElement.remove();
    newElement.remove();
  });

  it("clears all targets with one revision increment", () => {
    const registry = createCenterPaneAnchorRegistry();
    const first = connectedElement();
    const second = connectedElement();

    registry.register(anchorId, first);
    registry.register("center-pane:dir-1:session-b", second);
    registry.clear();
    const revisionAfterClear = registry.revision.value;
    registry.clear();

    expect(registry.target(anchorId)).toBeNull();
    expect(registry.target("center-pane:dir-1:session-b")).toBeNull();
    expect(revisionAfterClear).toBe(3);
    expect(registry.revision.value).toBe(revisionAfterClear);
    first.remove();
    second.remove();
  });
});
