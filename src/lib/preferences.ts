/**
 * Small settings kept between visits in localStorage. Every access is guarded:
 * storage can be missing, disabled or full (private browsing, blocked cookies),
 * and then values live in memory for the rest of the visit instead.
 */

/** The subset of the Storage API used here. */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const PREFIX = "aural-farm.";

interface Preferences {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  /** A set of strings stored as a JSON array; anything unreadable reads as empty. */
  getSet: (key: string) => Set<string>;
  setSet: (key: string, value: ReadonlySet<string>) => void;
}

function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function createPreferences(
  getStorage: () => PreferenceStorage | undefined = browserStorage,
): Preferences {
  const memory = new Map<string, string>();
  const get = (key: string): string | null => {
    try {
      const stored = getStorage()?.getItem(PREFIX + key);
      if (stored !== undefined && stored !== null) {
        return stored;
      }
    } catch {
      // Fall through to the in-memory copy.
    }
    return memory.get(key) ?? null;
  };
  const set = (key: string, value: string): void => {
    memory.set(key, value);
    try {
      getStorage()?.setItem(PREFIX + key, value);
    } catch {
      // Kept in memory only.
    }
  };
  return {
    get,
    set,
    getSet(key) {
      const raw = get(key);
      if (raw === null) {
        return new Set();
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        return new Set(
          Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
        );
      } catch {
        return new Set();
      }
    },
    setSet(key, value) {
      set(key, JSON.stringify([...value]));
    },
  };
}
