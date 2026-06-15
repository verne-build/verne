import { describe, it, expect } from "vitest";
import { convertSpokenNumbers } from "./dictationNumbers";

describe("convertSpokenNumbers — cardinals", () => {
  it("converts hundreds with the 'and' connector", () => {
    expect(convertSpokenNumbers("three hundred and fifty")).toBe("350");
  });
  it("converts compound tens", () => {
    expect(convertSpokenNumbers("twenty five")).toBe("25");
    expect(convertSpokenNumbers("nineteen")).toBe("19");
    expect(convertSpokenNumbers("seventy")).toBe("70");
  });
  it("converts thousands and millions", () => {
    expect(convertSpokenNumbers("one thousand two hundred thirty four")).toBe("1234");
    expect(convertSpokenNumbers("two million")).toBe("2000000");
  });
  it("converts numbers inside a sentence", () => {
    expect(convertSpokenNumbers("i have five apples")).toBe("i have 5 apples");
    expect(convertSpokenNumbers("wait fifty milliseconds")).toBe("wait 50 milliseconds");
  });
});

describe("convertSpokenNumbers — digit sequences & shorthand", () => {
  it("treats a run of single digits as a sequence, not a sum", () => {
    expect(convertSpokenNumbers("one two seven")).toBe("127");
    expect(convertSpokenNumbers("eight zero eight zero")).toBe("8080");
    expect(convertSpokenNumbers("zero zero one")).toBe("001");
    expect(convertSpokenNumbers("one oh one")).toBe("101");
  });
  it("handles hundreds shorthand (ones followed by tens)", () => {
    expect(convertSpokenNumbers("three fifty")).toBe("350");
    expect(convertSpokenNumbers("one twenty seven")).toBe("127");
    expect(convertSpokenNumbers("one hundred twenty seven zero zero one")).toBe("127001");
  });
  it("handles year-style pairs", () => {
    expect(convertSpokenNumbers("nineteen eighty four")).toBe("1984");
    expect(convertSpokenNumbers("twenty twenty")).toBe("2020");
  });
  it("collapses spoken dots between digits (IP addresses)", () => {
    expect(convertSpokenNumbers("one two seven dot zero dot zero dot one")).toBe("127.0.0.1");
    expect(convertSpokenNumbers("one two seven dot one two seven")).toBe("127.127");
    expect(convertSpokenNumbers("one two seven dot")).toBe("127.");
  });
});

describe("convertSpokenNumbers — decimals & safety", () => {
  it("handles decimals via 'point'", () => {
    expect(convertSpokenNumbers("three point one four")).toBe("3.14");
    expect(convertSpokenNumbers("zero point five")).toBe("0.5");
    expect(convertSpokenNumbers("version two point oh")).toBe("version 2.0");
  });
  it("handles hyphenated compounds from STT output", () => {
    expect(convertSpokenNumbers("twenty-five")).toBe("25");
    expect(convertSpokenNumbers("one hundred twenty-seven")).toBe("127");
  });
  it("preserves trailing punctuation", () => {
    expect(convertSpokenNumbers("it was fifty.")).toBe("it was 50.");
  });
  it("does not swallow a trailing conjunction", () => {
    expect(convertSpokenNumbers("two and a half")).toBe("2 and a half");
  });
  it("leaves non-number words alone", () => {
    expect(convertSpokenNumbers("android and ios")).toBe("android and ios");
    expect(convertSpokenNumbers("and then we ship")).toBe("and then we ship");
    expect(convertSpokenNumbers("edit the dot env file")).toBe("edit the dot env file");
    expect(convertSpokenNumbers("oh no")).toBe("oh no");
  });
});
