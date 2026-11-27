// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "../lib/preferences";
import {
  createSavedMixes,
  MAX_HASH_LENGTH,
  MAX_SAVED_MIXES,
  MIXES_KEY,
  sameName,
  type SavedMix,
} from "./mixes";

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

/** A clock that moves on a second each time it is read. */
function ticking(start = 1000) {
  let time = start;
  return () => {
    time += 1000;
    return time;
  };
}

function setup(storage = memoryStorage()) {
  const mixes = createSavedMixes(() => storage, ticking());
  const stored = () => JSON.parse(storage.data.get(MIXES_KEY) ?? "null") as SavedMix[] | null;
  return { storage, mixes, stored };
}

const names = (list: readonly SavedMix[]) => list.map((m) => m.name);

/** What another tab's write looks like here: the storage changes, then the event fires. */
function otherTab(storage: ReturnType<typeof memoryStorage>, key: string | null, value?: string) {
  if (key === null) {
    storage.data.clear();
  } else if (value !== undefined) {
    storage.data.set(key, value);
  }
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

/** Fills the store with `count` mixes named "Mix 1", "Mix 2", … */
function fill(count: number) {
  const storage = memoryStorage();
  const list = Array.from({ length: count }, (_, i) => ({
    name: `Mix ${String(i + 1)}`,
    hash: "#layers=a",
    savedAt: i,
  }));
  storage.setItem(MIXES_KEY, JSON.stringify(list));
  return setup(storage);
}

describe("saving", () => {
  it("stores mixes newest first as { name, hash, savedAt }", () => {
    const { mixes, stored } = setup();
    expect(mixes.save("Rain", "#layers=a")).toEqual({ ok: true, stored: true });
    expect(mixes.save("Wind", "#layers=b")).toEqual({ ok: true, stored: true });
    expect(stored()).toEqual([
      { name: "Wind", hash: "#layers=b", savedAt: 3000 },
      { name: "Rain", hash: "#layers=a", savedAt: 2000 },
    ]);
    expect(names(mixes.get())).toEqual(["Wind", "Rain"]);
    expect(MIXES_KEY).toBe("auralfarm.mixes");
  });

  it("sanitises the name and refuses an empty one", () => {
    const { mixes } = setup();
    mixes.save("  Night‮ \n", "#layers=a");
    expect(names(mixes.get())).toEqual(["Night"]);
    expect(mixes.save("​ ", "#layers=a")).toEqual({ ok: false, reason: "empty" });
  });

  it("replaces a mix of the same name, ignoring case, and moves it to the top", () => {
    const { mixes } = setup();
    mixes.save("Rain", "#layers=a");
    mixes.save("Wind", "#layers=b");
    mixes.save("RAIN", "#layers=c");
    expect(mixes.get()).toEqual([
      { name: "RAIN", hash: "#layers=c", savedAt: 4000 },
      { name: "Wind", hash: "#layers=b", savedAt: 3000 },
    ]);
    expect(mixes.find("rain")?.hash).toBe("#layers=c");
  });

  it("returns the same array until something changes", () => {
    const { mixes } = setup();
    const before = mixes.get();
    expect(mixes.get()).toBe(before);
    mixes.save("Rain", "#layers=a");
    expect(mixes.get()).not.toBe(before);
  });
});

describe("the 100-mix limit", () => {
  it("refuses a new mix once full", () => {
    const { mixes } = fill(MAX_SAVED_MIXES);
    expect(mixes.save("One more", "#layers=a")).toEqual({ ok: false, reason: "full" });
    expect(mixes.get()).toHaveLength(MAX_SAVED_MIXES);
  });

  it("still replaces a mix when full", () => {
    const { mixes } = fill(MAX_SAVED_MIXES);
    expect(mixes.save("Mix 7", "#layers=b")).toEqual({ ok: true, stored: true });
    expect(mixes.get()[0]).toMatchObject({ name: "Mix 7", hash: "#layers=b" });
    expect(mixes.get()).toHaveLength(MAX_SAVED_MIXES);
  });

  it("saves again once one is deleted", () => {
    const { mixes } = fill(MAX_SAVED_MIXES);
    mixes.remove("Mix 1");
    expect(mixes.save("One more", "#layers=a").ok).toBe(true);
  });

  it("keeps only the newest 100 of a larger stored list", () => {
    const { mixes } = fill(MAX_SAVED_MIXES + 5);
    expect(mixes.get()).toHaveLength(MAX_SAVED_MIXES);
    expect(mixes.get()[0]?.name).toBe("Mix 105");
  });
});

describe("rename", () => {
  it("renames in place", () => {
    const { mixes, stored } = setup();
    mixes.save("Rain", "#layers=a");
    mixes.save("Wind", "#layers=b");
    expect(mixes.rename("rain", " Rainy\nCabin ")).toEqual({ ok: true, stored: true });
    expect(names(stored() ?? [])).toEqual(["Wind", "Rainy Cabin"]);
  });

  it("changes the case of a name", () => {
    const { mixes } = setup();
    mixes.save("rain", "#layers=a");
    expect(mixes.rename("rain", "Rain").ok).toBe(true);
    expect(names(mixes.get())).toEqual(["Rain"]);
  });

  it.each([
    ["Wind", "taken"],
    ["wind", "taken"],
    [" ", "empty"],
  ])("refuses %j (%s)", (to, reason) => {
    const { mixes } = setup();
    mixes.save("Rain", "#layers=a");
    mixes.save("Wind", "#layers=b");
    expect(mixes.rename("Rain", to)).toEqual({ ok: false, reason });
    expect(names(mixes.get())).toEqual(["Wind", "Rain"]);
  });

  it("refuses a mix that isn't saved", () => {
    expect(setup().mixes.rename("Nope", "Other")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("delete with undo", () => {
  it("deletes and restores in the same place", () => {
    const { mixes, stored } = setup();
    mixes.save("A", "#layers=a");
    mixes.save("B", "#layers=b");
    mixes.save("C", "#layers=c");
    const removed = mixes.remove("b");
    expect(removed?.name).toBe("B");
    expect(names(stored() ?? [])).toEqual(["C", "A"]);
    expect(removed && mixes.restore(removed)).toEqual({ ok: true, stored: true });
    expect(names(stored() ?? [])).toEqual(["C", "B", "A"]);
  });

  it("returns nothing for a mix that isn't saved", () => {
    expect(setup().mixes.remove("Nope")).toBeUndefined();
  });

  it("won't restore over a mix saved since under the same name", () => {
    const { mixes } = setup();
    mixes.save("A", "#layers=a");
    const removed = mixes.remove("A");
    mixes.save("a", "#layers=b");
    expect(removed && mixes.restore(removed)).toEqual({ ok: false, reason: "taken" });
    expect(mixes.get()).toHaveLength(1);
  });

  it("won't restore once full", () => {
    const { mixes } = fill(MAX_SAVED_MIXES);
    const removed = mixes.remove("Mix 3");
    mixes.save("Other", "#layers=a");
    expect(removed && mixes.restore(removed)).toEqual({ ok: false, reason: "full" });
  });
});

describe("a storage failure", () => {
  const failing = () => {
    const fail = () => {
      throw new Error("QuotaExceededError");
    };
    return { getItem: () => null, setItem: fail };
  };

  it("keeps the mix in memory and says it wasn't stored", () => {
    const mixes = createSavedMixes(failing);
    expect(mixes.save("Rain", "#layers=a")).toEqual({ ok: true, stored: false });
    expect(names(mixes.get())).toEqual(["Rain"]);
    expect(mixes.rename("Rain", "Wind")).toEqual({ ok: true, stored: false });
    expect(mixes.remove("Wind")?.name).toBe("Wind");
  });

  it("says so when storage is missing", () => {
    const mixes = createSavedMixes(() => undefined);
    expect(mixes.save("Rain", "#layers=a")).toEqual({ ok: true, stored: false });
  });

  it("starts empty when reading throws", () => {
    const mixes = createSavedMixes(() => ({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    }));
    expect(mixes.get()).toEqual([]);
  });

  it.each([
    "not json",
    "{}",
    "[1, null, {}]",
    '[{"name": 1, "hash": "#layers=a", "savedAt": 1}]',
    '[{"name": "A", "hash": "layers=a", "savedAt": 1}]',
    '[{"name": "A", "hash": "#layers=a", "savedAt": "1"}]',
    '[{"name": "\\u200b", "hash": "#layers=a", "savedAt": 1}]',
  ])("skips unreadable stored data: %s", (raw) => {
    const storage = memoryStorage();
    storage.setItem(MIXES_KEY, raw);
    expect(setup(storage).mixes.get()).toEqual([]);
  });

  it("skips an over-long hash and a repeated name in stored data", () => {
    const storage = memoryStorage();
    storage.setItem(
      MIXES_KEY,
      JSON.stringify([
        { name: "A", hash: "#layers=a", savedAt: 2 },
        { name: "a", hash: "#layers=b", savedAt: 1 },
        { name: "B", hash: `#${"x".repeat(MAX_HASH_LENGTH)}`, savedAt: 1 },
      ]),
    );
    expect(names(setup(storage).mixes.get())).toEqual(["A"]);
  });
});

describe("cross-tab sync", () => {
  it("follows another tab's mixes", () => {
    const { storage, mixes } = setup();
    const listener = vi.fn<() => void>();
    const unsubscribe = mixes.subscribe(listener);
    otherTab(storage, MIXES_KEY, '[{"name":"Rain","hash":"#layers=a","savedAt":5}]');
    expect(names(mixes.get())).toEqual(["Rain"]);
    expect(listener).toHaveBeenCalledTimes(1);
    // Other keys, and a write that changes nothing, are ignored.
    otherTab(storage, "auralfarm.favourites", "[]");
    otherTab(storage, MIXES_KEY, '[{"name":"Rain","hash":"#layers=a","savedAt":5}]');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("follows another tab clearing the storage", () => {
    const { storage, mixes } = setup();
    mixes.save("Rain", "#layers=a");
    const listener = vi.fn<() => void>();
    const unsubscribe = mixes.subscribe(listener);
    otherTab(storage, null);
    expect(mixes.get()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("notifies subscribers of its own changes, and stops once unsubscribed", () => {
    const { storage, mixes } = setup();
    const listener = vi.fn<() => void>();
    const unsubscribe = mixes.subscribe(listener);
    mixes.save("Rain", "#layers=a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    mixes.save("Wind", "#layers=a");
    otherTab(storage, MIXES_KEY, "[]");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mixes.get()).toHaveLength(2);
  });
});

describe("merging imported mixes", () => {
  const incoming: SavedMix[] = [
    { name: "rain", hash: "#layers=b", savedAt: 50 },
    { name: "Wind", hash: "#layers=w", savedAt: 60 },
    { name: "Same", hash: "#layers=s", savedAt: 70 },
  ];

  function withSaved() {
    const context = setup();
    context.mixes.save("Rain", "#layers=a");
    context.mixes.save("Same", "#layers=s");
    return context;
  }

  it("lists the names it would replace", () => {
    expect(withSaved().mixes.conflicts(incoming)).toEqual(["Rain"]);
  });

  it("adds new names and keeps saved mixes when not replacing", () => {
    const { mixes } = withSaved();
    expect(mixes.merge(incoming, false)).toEqual({
      added: 1,
      replaced: 0,
      unchanged: 2,
      noRoom: 0,
      stored: true,
    });
    expect(mixes.find("rain")?.hash).toBe("#layers=a");
    expect(names(mixes.get())).toEqual(["Same", "Rain", "Wind"]);
  });

  it("replaces mixes of a taken name when asked", () => {
    const { mixes } = withSaved();
    expect(mixes.merge(incoming, true)).toMatchObject({ added: 1, replaced: 1, unchanged: 1 });
    expect(mixes.find("Rain")).toEqual({ name: "rain", hash: "#layers=b", savedAt: 50 });
  });

  it("stops adding at the limit", () => {
    const { mixes } = fill(MAX_SAVED_MIXES - 1);
    expect(mixes.merge(incoming, false)).toMatchObject({ added: 1, noRoom: 2 });
    expect(mixes.get()).toHaveLength(MAX_SAVED_MIXES);
  });

  it("writes nothing when nothing changes", () => {
    const { mixes, storage } = withSaved();
    const setItem = vi.spyOn(storage, "setItem");
    expect(mixes.merge(incoming.slice(2), true)).toMatchObject({ unchanged: 1 });
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("sameName", () => {
  it("ignores case", () => {
    expect(sameName("Rainy Cabin", "rainy CABIN")).toBe(true);
    expect(sameName("Rain", "Rainy")).toBe(false);
  });
});
