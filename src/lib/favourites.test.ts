// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createFavourites, FAVOURITES_KEY } from "./favourites";
import type { PreferenceStorage } from "./preferences";

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

/** What another tab's write looks like here: the storage changes, then the event fires. */
function otherTab(storage: ReturnType<typeof memoryStorage>, key: string | null, value?: string) {
  if (key === null) {
    storage.data.clear();
  } else if (value !== undefined) {
    storage.data.set(key, value);
  }
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

describe("createFavourites", () => {
  it("stars and unstars, storing the ids as a JSON array", () => {
    const storage = memoryStorage();
    const favourites = createFavourites(() => storage);
    expect(favourites.toggle("rain")).toBe(true);
    expect(favourites.toggle("wind")).toBe(true);
    expect(storage.data.get(FAVOURITES_KEY)).toBe('["rain","wind"]');
    expect(favourites.toggle("rain")).toBe(false);
    expect(favourites.has("rain")).toBe(false);
    expect([...favourites.get()]).toEqual(["wind"]);
    expect(FAVOURITES_KEY).toBe("auralfarm.favourites");
  });

  it("reads what an earlier visit stored, keeping ids it doesn't know", () => {
    const storage = memoryStorage();
    storage.setItem(FAVOURITES_KEY, '["rain","gone-sound"]');
    const favourites = createFavourites(() => storage);
    expect([...favourites.get()]).toEqual(["rain", "gone-sound"]);
    favourites.toggle("wind");
    expect(storage.data.get(FAVOURITES_KEY)).toBe('["rain","gone-sound","wind"]');
  });

  it.each(["not json", "{}", '[1, "rain"]'])("reads %s as its string ids", (raw) => {
    const storage = memoryStorage();
    storage.setItem(FAVOURITES_KEY, raw);
    expect([...createFavourites(() => storage).get()]).toEqual(
      raw.includes('"rain"') ? ["rain"] : [],
    );
  });

  it("returns the same set until something changes", () => {
    const favourites = createFavourites(() => undefined);
    const before = favourites.get();
    expect(favourites.get()).toBe(before);
    favourites.toggle("rain");
    expect(favourites.get()).not.toBe(before);
  });

  it("notifies subscribers of a change", () => {
    const favourites = createFavourites(() => undefined);
    const listener = vi.fn<() => void>();
    const unsubscribe = favourites.subscribe(listener);
    favourites.toggle("rain");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    favourites.toggle("rain");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows another tab's stars", () => {
    const storage = memoryStorage();
    const favourites = createFavourites(() => storage);
    const listener = vi.fn<() => void>();
    const unsubscribe = favourites.subscribe(listener);
    otherTab(storage, FAVOURITES_KEY, '["rain"]');
    expect([...favourites.get()]).toEqual(["rain"]);
    expect(listener).toHaveBeenCalledTimes(1);
    // Other keys, and a write that changes nothing, are ignored.
    otherTab(storage, "aural-farm.soundSort", "az");
    otherTab(storage, FAVOURITES_KEY, '["rain"]');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("follows another tab clearing the storage", () => {
    const storage = memoryStorage();
    storage.setItem(FAVOURITES_KEY, '["rain"]');
    const favourites = createFavourites(() => storage);
    const listener = vi.fn<() => void>();
    const unsubscribe = favourites.subscribe(listener);
    otherTab(storage, null);
    expect(favourites.get().size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops listening to other tabs once nothing subscribes", () => {
    const storage = memoryStorage();
    const favourites = createFavourites(() => storage);
    favourites.subscribe(() => undefined)();
    otherTab(storage, FAVOURITES_KEY, '["rain"]');
    expect(favourites.get().size).toBe(0);
  });

  it("falls back to memory when storage throws", () => {
    const fail = () => {
      throw new Error("blocked");
    };
    const favourites = createFavourites(() => ({ getItem: fail, setItem: fail }));
    expect(favourites.toggle("rain")).toBe(true);
    expect(favourites.has("rain")).toBe(true);
    expect(favourites.toggle("rain")).toBe(false);
  });

  it("falls back to memory when storage is missing", () => {
    const favourites = createFavourites(() => undefined);
    favourites.toggle("rain");
    expect([...favourites.get()]).toEqual(["rain"]);
  });
});
