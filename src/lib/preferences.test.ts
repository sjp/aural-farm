import { describe, expect, it } from "vitest";
import { createPreferences, type PreferenceStorage } from "./preferences";

function memoryStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("createPreferences", () => {
  it("stores values under a prefix", () => {
    const storage = memoryStorage();
    const prefs = createPreferences(() => storage);
    prefs.set("x", "1");
    expect(storage.data.get("aural-farm.x")).toBe("1");
    expect(prefs.get("x")).toBe("1");
    expect(prefs.get("missing")).toBeNull();
  });

  it("falls back to memory when storage throws", () => {
    const prefs = createPreferences(() => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    }));
    prefs.set("x", "1");
    expect(prefs.get("x")).toBe("1");
  });

  it("falls back to memory when storage is missing", () => {
    const prefs = createPreferences(() => undefined);
    prefs.setSet("s", new Set(["a", "b"]));
    expect([...prefs.getSet("s")]).toEqual(["a", "b"]);
  });

  it.each(["not json", "{}", '[1, "a"]'])("reads %s as a set of its strings", (raw) => {
    const storage = memoryStorage();
    storage.setItem("aural-farm.s", raw);
    const prefs = createPreferences(() => storage);
    expect([...prefs.getSet("s")]).toEqual(raw.includes('"a"') ? ["a"] : []);
  });
});
