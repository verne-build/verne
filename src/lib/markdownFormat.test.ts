import { describe, it, expect } from "vitest";
import { wrapInline, setHeading, toggleLinePrefix, toggleListItem, insertLink, insertCodeBlock, insertTable, applyAction, listContinuation } from "./markdownFormat";

describe("wrapInline", () => {
  it("wraps a selection in markers", () => {
    expect(wrapInline("abc", 1, 2, "**")).toEqual({ from: 1, to: 2, insert: "**b**", selFrom: 3, selTo: 4 });
  });
  it("unwraps when the selection itself is the wrapped text", () => {
    expect(wrapInline("**b**", 0, 5, "**")).toEqual({ from: 0, to: 5, insert: "b", selFrom: 0, selTo: 1 });
  });
  it("unwraps when markers sit immediately outside the selection", () => {
    expect(wrapInline("**b**", 2, 3, "**")).toEqual({ from: 0, to: 5, insert: "b", selFrom: 0, selTo: 1 });
  });
  it("inserts empty markers with the cursor between when there is no selection", () => {
    expect(wrapInline("", 0, 0, "**")).toEqual({ from: 0, to: 0, insert: "****", selFrom: 2, selTo: 2 });
  });
  it("works with single-char markers (inline code)", () => {
    expect(wrapInline("xy", 0, 1, "`")).toEqual({ from: 0, to: 1, insert: "`x`", selFrom: 1, selTo: 2 });
  });
  it("unwraps a full wrapped selection starting at offset 0", () => {
    expect(wrapInline("`x`", 0, 3, "`")).toEqual({ from: 0, to: 3, insert: "x", selFrom: 0, selTo: 1 });
  });
});

describe("setHeading", () => {
  it("adds a heading prefix when none exists (no selection collapses cursor to end)", () => {
    expect(setHeading("title", 0, 0, 2)).toEqual({ from: 0, to: 5, insert: "## title", selFrom: 8, selTo: 8 });
  });
  it("replaces an existing heading level", () => {
    expect(setHeading("# title", 0, 0, 3)).toEqual({ from: 0, to: 7, insert: "### title", selFrom: 9, selTo: 9 });
  });
  it("toggles off when the line is already at that level", () => {
    expect(setHeading("## title", 0, 0, 2)).toEqual({ from: 0, to: 8, insert: "title", selFrom: 5, selTo: 5 });
  });
  it("keeps the block selected when there is a selection", () => {
    expect(setHeading("a\nb", 0, 3, 1)).toEqual({ from: 0, to: 3, insert: "# a\n# b", selFrom: 0, selTo: 7 });
  });
  it("inserts the marker on an empty line with no selection", () => {
    expect(setHeading("", 0, 0, 1)).toEqual({ from: 0, to: 0, insert: "# ", selFrom: 2, selTo: 2 });
  });
});
describe("toggleLinePrefix (quote)", () => {
  it("adds a quote prefix to each selected line", () => {
    expect(toggleLinePrefix("a\nb", 0, 3, "> ", /^> /)).toEqual({ from: 0, to: 3, insert: "> a\n> b", selFrom: 0, selTo: 7 });
  });
  it("removes the prefix when every line already has it", () => {
    expect(toggleLinePrefix("> a\n> b", 0, 7, "> ", /^> /)).toEqual({ from: 0, to: 7, insert: "a\nb", selFrom: 0, selTo: 3 });
  });
  it("inserts the prefix at the cursor on an empty line with no selection", () => {
    expect(toggleLinePrefix("", 0, 0, "> ", /^> /)).toEqual({ from: 0, to: 0, insert: "> ", selFrom: 2, selTo: 2 });
  });
  it("skips blank lines inside a multi-line selection", () => {
    expect(toggleLinePrefix("a\n\nb", 0, 4, "> ", /^> /)).toEqual({ from: 0, to: 4, insert: "> a\n\n> b", selFrom: 0, selTo: 8 });
  });
});
describe("toggleListItem", () => {
  it("adds a bullet to each selected line", () => {
    expect(toggleListItem("a\nb", 0, 3, "bullet")).toEqual({ from: 0, to: 3, insert: "- a\n- b", selFrom: 0, selTo: 7 });
  });
  it("removes the bullet when every line already has it (toggle off)", () => {
    expect(toggleListItem("- a\n- b", 0, 7, "bullet")).toEqual({ from: 0, to: 7, insert: "a\nb", selFrom: 0, selTo: 3 });
  });
  it("inserts a bullet at the cursor on an empty line with no selection", () => {
    expect(toggleListItem("", 0, 0, "bullet")).toEqual({ from: 0, to: 0, insert: "- ", selFrom: 2, selTo: 2 });
  });
  it("numbers each selected line incrementally", () => {
    expect(toggleListItem("a\nb", 0, 3, "numbered")).toEqual({ from: 0, to: 3, insert: "1. a\n2. b", selFrom: 0, selTo: 9 });
  });
  it("inserts a task marker", () => {
    expect(toggleListItem("a", 0, 1, "task")).toEqual({ from: 0, to: 1, insert: "- [ ] a", selFrom: 0, selTo: 7 });
  });
  it("SWAPS a bullet to a numbered list instead of stacking", () => {
    expect(toggleListItem("- item", 0, 6, "numbered")).toEqual({ from: 0, to: 6, insert: "1. item", selFrom: 0, selTo: 7 });
  });
  it("SWAPS a numbered list to a bullet", () => {
    expect(toggleListItem("1. item", 0, 7, "bullet")).toEqual({ from: 0, to: 7, insert: "- item", selFrom: 0, selTo: 6 });
  });
  it("SWAPS a bullet to a task", () => {
    expect(toggleListItem("- item", 0, 6, "task")).toEqual({ from: 0, to: 6, insert: "- [ ] item", selFrom: 0, selTo: 10 });
  });
  it("SWAPS a task to a bullet", () => {
    expect(toggleListItem("- [ ] item", 0, 10, "bullet")).toEqual({ from: 0, to: 10, insert: "- item", selFrom: 0, selTo: 6 });
  });
  it("swaps every line of a multi-line selection and renumbers", () => {
    expect(toggleListItem("- a\n- b", 0, 7, "numbered")).toEqual({ from: 0, to: 7, insert: "1. a\n2. b", selFrom: 0, selTo: 9 });
  });
  it("preserves indentation when swapping", () => {
    expect(toggleListItem("  - x", 0, 5, "numbered")).toEqual({ from: 0, to: 5, insert: "  1. x", selFrom: 0, selTo: 6 });
  });
});

describe("insertLink", () => {
  it("wraps a selection as a link with the cursor in url", () => {
    expect(insertLink("x", 0, 1, false)).toEqual({ from: 0, to: 1, insert: "[x](url)", selFrom: 4, selTo: 7 });
  });
  it("inserts an empty image with the cursor in url", () => {
    expect(insertLink("", 0, 0, true)).toEqual({ from: 0, to: 0, insert: "![](url)", selFrom: 4, selTo: 7 });
  });
});
describe("insertCodeBlock", () => {
  it("fences the selection and selects the inner text", () => {
    expect(insertCodeBlock("hi", 0, 2)).toEqual({ from: 0, to: 2, insert: "```\nhi\n```", selFrom: 4, selTo: 6 });
  });
  it("empty selection (cursor only) places cursor on the blank inner line", () => {
    expect(insertCodeBlock("", 0, 0)).toEqual({ from: 0, to: 0, insert: "```\n\n```", selFrom: 4, selTo: 4 });
  });
});
describe("insertTable", () => {
  it("inserts a table skeleton selecting the first header cell", () => {
    const r = insertTable("", 0, 0);
    expect(r.insert).toBe("| Column | Column |\n| --- | --- |\n| Cell | Cell |");
    expect(r.selFrom).toBe(2);
    expect(r.selTo).toBe(8);
  });
});
describe("applyAction", () => {
  it("routes 'bold' through wrapInline", () => {
    expect(applyAction("bold", "abc", 1, 2)).toEqual({ from: 1, to: 2, insert: "**b**", selFrom: 3, selTo: 4 });
  });
  it("routes 'task' through toggleLinePrefix", () => {
    expect(applyAction("task", "a", 0, 1)).toEqual({ from: 0, to: 1, insert: "- [ ] a", selFrom: 0, selTo: 7 });
  });
  it("inserts 'quote' at the cursor with no selection", () => {
    expect(applyAction("quote", "", 0, 0)).toEqual({ from: 0, to: 0, insert: "> ", selFrom: 2, selTo: 2 });
  });
});

describe("listContinuation", () => {
  it("continues a bullet list", () => {
    expect(listContinuation("- item")).toEqual({ kind: "continue", marker: "- " });
  });
  it("continues a +/* bullet preserving the marker char and indent", () => {
    expect(listContinuation("  * item")).toEqual({ kind: "continue", marker: "  * " });
  });
  it("continues a task list with an unchecked box", () => {
    expect(listContinuation("- [x] done")).toEqual({ kind: "continue", marker: "- [ ] " });
  });
  it("increments a numbered list", () => {
    expect(listContinuation("3. third")).toEqual({ kind: "continue", marker: "4. " });
  });
  it("supports the 1) numbered style", () => {
    expect(listContinuation("1) first")).toEqual({ kind: "continue", marker: "2) " });
  });
  it("continues a blockquote", () => {
    expect(listContinuation("> quote")).toEqual({ kind: "continue", marker: "> " });
  });
  it("exits an empty bullet item", () => {
    expect(listContinuation("- ")).toEqual({ kind: "exit", clearLen: 2 });
  });
  it("exits an empty task item", () => {
    expect(listContinuation("- [ ] ")).toEqual({ kind: "exit", clearLen: 6 });
  });
  it("exits an empty numbered item", () => {
    expect(listContinuation("2. ")).toEqual({ kind: "exit", clearLen: 3 });
  });
  it("returns null for a non-list line", () => {
    expect(listContinuation("plain text")).toBeNull();
  });
  it("returns null for a horizontal rule, not a bullet", () => {
    expect(listContinuation("---")).toBeNull();
  });
});
