/**
 * The starred sounds, kept in localStorage as a JSON array of sound ids. Ids
 * that aren't registered stay stored, in case the sound returns, and the list
 * simply skips them. Starring in one tab reaches the others through the
 * `storage` event. If storage is missing or throws, the stars live in memory for
 * the rest of the visit.
 */
import type { PreferenceStorage } from "./preferences";

/** The localStorage key holding the starred ids. */
export const FAVOURITES_KEY = "auralfarm.favourites";

export interface Favourites {
  /** The starred ids. The same set comes back until something changes. */
  get: () => ReadonlySet<string>;
  has: (id: string) => boolean;
  /** Stars or unstars `id`; returns whether it is starred now. */
  toggle: (id: string) => boolean;
  /** Calls `listener` after each change, here or in another tab; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The ids in a stored value; anything unreadable reads as none. */
function parse(raw: string | null): Set<string> {
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
}

export function createFavourites(
  getStorage: () => PreferenceStorage | undefined = browserStorage,
): Favourites {
  /** The stored ids, or undefined when storage can't be read. */
  const read = (): Set<string> | undefined => {
    try {
      const storage = getStorage();
      return storage ? parse(storage.getItem(FAVOURITES_KEY)) : undefined;
    } catch {
      return undefined;
    }
  };
  let ids: ReadonlySet<string> = read() ?? new Set();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };
  const onStorage = (event: StorageEvent) => {
    // A null key means another tab cleared the whole storage.
    if (event.key !== FAVOURITES_KEY && event.key !== null) {
      return;
    }
    const next = read();
    if (next && !sameIds(next, ids)) {
      ids = next;
      notify();
    }
  };
  return {
    get: () => ids,
    has: (id) => ids.has(id),
    toggle(id) {
      const next = new Set(ids);
      const starred = !next.delete(id);
      if (starred) {
        next.add(id);
      }
      ids = next;
      try {
        getStorage()?.setItem(FAVOURITES_KEY, JSON.stringify([...next]));
      } catch {
        // Kept in memory only.
      }
      notify();
      return starred;
    },
    subscribe(listener) {
      if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") {
          window.removeEventListener("storage", onStorage);
        }
      };
    },
  };
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
