// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/composables/useTerminal", () => ({ sendTextToSession: vi.fn() }));

import { classifyTarget, insertText } from "./dictationInsertionTarget";
import { sendTextToSession } from "@/composables/useTerminal";

describe("classifyTarget", () => {
  it("classifies a textarea as text", () => {
    expect(classifyTarget(document.createElement("textarea")).kind).toBe("text");
  });
  it("classifies an input as text", () => {
    expect(classifyTarget(document.createElement("input")).kind).toBe("text");
  });
  it("classifies the grid terminal input as terminal and resolves session id", () => {
    const host = document.createElement("div");
    host.setAttribute("data-session-id", "sess-42");
    const ta = document.createElement("textarea");
    ta.className = "terminal-input absolute";
    host.appendChild(ta);
    const target = classifyTarget(ta);
    expect(target).toEqual({ kind: "terminal", sessionId: "sess-42" });
  });
  it("classifies contentEditable", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    // jsdom needs isContentEditable forced
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(classifyTarget(el).kind).toBe("contentEditable");
  });
  it("classifies null as none", () => {
    expect(classifyTarget(null).kind).toBe("none");
  });
});

describe("insertText", () => {
  it("sends to the terminal session", () => {
    insertText("ls -la", { kind: "terminal", sessionId: "sess-7" });
    expect(sendTextToSession).toHaveBeenCalledWith("sess-7", "ls -la");
  });
  it("inserts into a textarea at the caret", () => {
    const el = document.createElement("textarea");
    el.value = "ab";
    el.selectionStart = el.selectionEnd = 1;
    insertText("X", { kind: "text", element: el });
    expect(el.value).toBe("aXb");
  });
});
