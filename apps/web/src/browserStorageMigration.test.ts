import { describe, expect, it } from "vite-plus/test";

import { migrateLegacyBrowserStorage } from "./browserStorageMigration";

const makeStorage = (initial: Record<string, string>): Storage => {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

describe("migrateLegacyBrowserStorage", () => {
  it("copies T3 Code values to empty Verne keys without modifying the source", () => {
    const storage = makeStorage({
      "t3code:theme": "grove",
      "t3code:client-settings:v1": '{"timestampFormat":"24-hour"}',
      "t3code.fileExplorerOpen": "true",
      unrelated: "keep",
    });

    expect(migrateLegacyBrowserStorage(storage)).toBe(3);
    expect(storage.getItem("t3code:theme")).toBe("grove");
    expect(storage.getItem("verne.fileExplorerOpen")).toBe("true");
    expect(storage.getItem("verne:client-settings:v1")).toBe('{"timestampFormat":"24-hour"}');
    expect(storage.getItem("verne:theme")).toBe("grove");
    expect(storage.getItem("unrelated")).toBe("keep");
  });

  it("keeps initialized Verne values and is idempotent", () => {
    const storage = makeStorage({
      "t3code:theme": "grove",
      "verne:theme": "verne",
    });

    expect(migrateLegacyBrowserStorage(storage)).toBe(0);
    expect(migrateLegacyBrowserStorage(storage)).toBe(0);
    expect(storage.getItem("verne:theme")).toBe("verne");
  });
});
