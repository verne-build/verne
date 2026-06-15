import { describe, it, expect } from "vitest";
import {
  applyDictationDictionary,
  parseCustomRules,
  buildDictationRules,
  DEFAULT_DICTATION_RULES,
} from "./dictationDictionary";
import { convertSpokenNumbers } from "./dictationNumbers";

describe("applyDictationDictionary (defaults)", () => {
  const apply = (t: string) => applyDictationDictionary(t, DEFAULT_DICTATION_RULES);

  it("rewrites framework names", () => {
    expect(apply("i use next js for this")).toBe("i use Next.js for this");
    expect(apply("a vue js component")).toBe("a Vue.js component");
    expect(apply("type script and java script")).toBe("TypeScript and JavaScript");
  });

  it("handles spoken-out dot and concatenated variants", () => {
    expect(apply("deploy with node dot js")).toBe("deploy with Node.js");
    expect(apply("deploy with node dot j s")).toBe("deploy with Node.js");
    expect(apply("a vue j s component")).toBe("a Vue.js component");
    expect(apply("a view js component")).toBe("a Vue.js component");
    expect(apply("a view dot j s component")).toBe("a Vue.js component");
    expect(apply("render with three J S")).toBe("render with Three.js");
    expect(apply("nodejs server")).toBe("Node.js server");
  });

  it("rewrites common JavaScript ecosystem terms", () => {
    expect(apply("build with svelte kit and astro")).toBe("build with SvelteKit and Astro");
    expect(apply("solid j s and nest js")).toBe("SolidJS and NestJS");
    expect(apply("quick uses vite press")).toBe("quick uses VitePress");
    expect(apply("test with playwright vitest and cypress")).toBe(
      "test with Playwright Vitest and Cypress",
    );
  });

  it("rewrites common backend frameworks and CMS names", () => {
    expect(apply("ruby on rails and laravel")).toBe("Ruby on Rails and Laravel");
    expect(apply("word press with django and fast api")).toBe("WordPress with Django and FastAPI");
  });

  it("rewrites common language names", () => {
    expect(apply("ruby python go lang and php")).toBe("Ruby Python Go and PHP");
    expect(apply("c sharp c plus plus objective c")).toBe("C# C++ Objective-C");
    expect(apply("kotlin and elixir")).toBe("Kotlin and Elixir");
  });

  it("normalizes storage units", () => {
    expect(apply("the file is 5 megabytes")).toBe("the file is 5 MB");
    expect(apply("about 200 kilobytes")).toBe("about 200 KB");
  });

  it("rewrites webview and acronyms", () => {
    expect(apply("open the web view")).toBe("open the webview");
    expect(apply("return json from the api")).toBe("return JSON from the API");
  });

  it("is whitespace-flexible", () => {
    expect(apply("next   js")).toBe("Next.js");
  });

  it("only matches whole words", () => {
    expect(apply("contextual viewing")).toBe("contextual viewing"); // not "Vue"
    expect(apply("rapid")).toBe("rapid"); // 'api' inside a word untouched
    expect(apply("go to file")).toBe("go to file"); // avoid rewriting ordinary "go"
    expect(apply("maybe a rail backend")).toBe("maybe a rail backend");
    expect(apply("the next solid step")).toBe("the next solid step");
    expect(apply("just a jest about rails")).toBe("just a jest about rails");
    expect(apply("remix the track with ember and phoenix")).toBe("remix the track with ember and phoenix");
    expect(apply("rust and swift changes")).toBe("rust and swift changes");
  });

  it("is idempotent on already-correct text", () => {
    expect(apply("Next.js")).toBe("Next.js");
  });
});

describe("parseCustomRules", () => {
  it("parses 'spoken => Replacement' lines, skipping blanks and comments", () => {
    const rules = parseCustomRules("kubernetes => Kubernetes\n# a comment\n\n  k eights => Kubernetes  ");
    expect(rules).toEqual([
      { spoken: "kubernetes", replacement: "Kubernetes" },
      { spoken: "k eights", replacement: "Kubernetes" },
    ]);
  });

  it("ignores malformed lines", () => {
    expect(parseCustomRules("no arrow here\n=> no spoken\nspoken =>")).toEqual([]);
  });
});

describe("buildDictationRules", () => {
  it("applies custom rules with priority over defaults", () => {
    const rules = buildDictationRules("web view => WebView");
    // custom 'web view => WebView' comes before the default 'web view => webview'
    expect(applyDictationDictionary("the web view", rules)).toBe("the WebView");
  });

  it("can exclude defaults", () => {
    const rules = buildDictationRules("foo => Bar", false);
    expect(rules).toEqual([{ spoken: "foo", replacement: "Bar" }]);
  });
});

describe("dictation post-processing order", () => {
  function processFinalTranscript(raw: string): string {
    return convertSpokenNumbers(applyDictationDictionary(raw, buildDictationRules("")));
  }

  it("applies developer terms before spoken-number conversion", () => {
    expect(processFinalTranscript("three dot js")).toBe("Three.js");
    expect(processFinalTranscript("three J S")).toBe("Three.js");
    expect(processFinalTranscript("view J S")).toBe("Vue.js");
    expect(processFinalTranscript("wait fifty milliseconds")).toBe("wait 50 ms");
  });
});
