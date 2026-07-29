// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCenterPaneAnchorRegistry } from "./centerPaneAnchorRegistry";

const anchorId = "center-pane:dir-1:session-a";

function connectedElement(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("CenterPaneAnchorRegistry", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

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

  it("keeps captured replacement focus when the old element unregisters later", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    oldTarget.append(input);
    registry.register(anchorId, oldTarget);
    input.focus();

    registry.register(anchorId, newTarget);
    registry.unregister(anchorId, oldTarget);
    oldTarget.remove();
    newTarget.append(input);

    registry.restoreCapturedFocus(anchorId);

    expect(document.activeElement).toBe(input);
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

  it("clears captured focus and handoff candidates", () => {
    const registry = createCenterPaneAnchorRegistry();
    const capturedOldTarget = connectedElement();
    const capturedNewTarget = connectedElement();
    const handoffTarget = connectedElement();
    const capturedInput = document.createElement("input");
    const handoffInput = document.createElement("input");
    capturedOldTarget.append(capturedInput);
    handoffTarget.append(handoffInput);
    registry.register(anchorId, capturedOldTarget);
    capturedInput.focus();
    registry.register(anchorId, capturedNewTarget);
    registry.register("center-pane:dir-1:session-b", handoffTarget);
    handoffInput.focus();
    registry.unregister("center-pane:dir-1:session-b", handoffTarget);
    const capturedFocus = vi.spyOn(capturedInput, "focus");
    const handoffFocus = vi.spyOn(handoffInput, "focus");

    registry.clear();
    capturedOldTarget.remove();
    handoffTarget.remove();
    capturedNewTarget.append(capturedInput);
    document.body.append(handoffInput);

    registry.restoreCapturedFocus(anchorId);
    registry.restoreCapturedFocus("center-pane:dir-1:session-b");

    expect(capturedFocus).not.toHaveBeenCalled();
    expect(handoffFocus).not.toHaveBeenCalled();
  });

  it("restores captured focus once after a replacement", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    oldTarget.append(input);
    registry.register(anchorId, oldTarget);
    input.focus();
    const focus = vi.spyOn(input, "focus");

    registry.register(anchorId, newTarget);
    oldTarget.remove();
    newTarget.append(input);

    expect(document.activeElement).toBe(document.body);

    registry.restoreCapturedFocus(anchorId);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(input);

    input.blur();
    registry.restoreCapturedFocus(anchorId);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("skips disconnected captured focus", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    oldTarget.append(input);
    registry.register(anchorId, oldTarget);
    input.focus();
    const focus = vi.spyOn(input, "focus");

    registry.register(anchorId, newTarget);
    oldTarget.remove();

    registry.restoreCapturedFocus(anchorId);

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not steal focus after a replacement", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    const otherInput = document.createElement("input");
    oldTarget.append(input);
    document.body.append(otherInput);
    registry.register(anchorId, oldTarget);
    input.focus();
    const focus = vi.spyOn(input, "focus");

    registry.register(anchorId, newTarget);
    oldTarget.remove();
    newTarget.append(input);
    otherInput.focus();

    registry.restoreCapturedFocus(anchorId);

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(otherInput);
  });

  it("discards focus when the current target is not replaced", async () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    oldTarget.append(input);
    registry.register(anchorId, oldTarget);
    input.focus();
    const focus = vi.spyOn(input, "focus");

    registry.unregister(anchorId, oldTarget);
    oldTarget.remove();
    newTarget.append(input);
    await Promise.resolve();

    registry.restoreCapturedFocus(anchorId);

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("discards captured replacement focus when the current target unregisters", () => {
    const registry = createCenterPaneAnchorRegistry();
    const oldTarget = connectedElement();
    const newTarget = connectedElement();
    const input = document.createElement("input");
    oldTarget.append(input);
    registry.register(anchorId, oldTarget);
    input.focus();
    registry.register(anchorId, newTarget);
    const focus = vi.spyOn(input, "focus");

    registry.unregister(anchorId, newTarget);
    oldTarget.remove();
    newTarget.append(input);
    registry.restoreCapturedFocus(anchorId);

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
