/**
 * The user's saved mixes, kept in localStorage as a JSON array of
 * `{ name, hash, savedAt }`, newest first. Nothing leaves the device: sharing
 * goes through Copy link, and a backup through the mixes file.
 *
 * Names are unique, ignoring case. Saving in one tab reaches the others through
 * the `storage` event. If storage is missing, full or throws, the mixes live in
 * memory for the rest of the visit, and each change says it wasn't stored, so
 * the app can tell the user.
 */
import type { PreferenceStorage } from "../lib/preferences";
import { sanitizeName } from "./mix";

/** The localStorage key holding the saved mixes. */
export const MIXES_KEY = "auralfarm.mixes";
/** The most mixes there's room for; past that, one must be deleted first. */
export const MAX_SAVED_MIXES = 100;
/** The longest hash a saved mix keeps, in characters: eight layers of every param fit easily. */
export const MAX_HASH_LENGTH = 4000;

export interface SavedMix {
  name: string;
  /** The mix in the full hash form, with its leading `#`. */
  hash: string;
  /** When it was saved, in ms since the epoch. */
  savedAt: number;
}

/** What a change did. `stored` is false when it couldn't be written to storage. */
type MixesResult =
  | { ok: true; stored: boolean }
  | { ok: false; reason: "full" | "taken" | "missing" | "empty" };

/** What merging imported mixes did. */
interface MergeResult {
  added: number;
  replaced: number;
  /** Mixes the same as one already saved, or with a taken name that wasn't to be replaced. */
  unchanged: number;
  /** Mixes left out because there was no room. */
  noRoom: number;
  stored: boolean;
}

interface SavedMixes {
  /** The saved mixes, newest first. The same array comes back until something changes. */
  get: () => readonly SavedMix[];
  /** The mix saved under `name`, ignoring case. */
  find: (name: string) => SavedMix | undefined;
  /**
   * Saves `hash` as `name`, newest, replacing any mix of that name (ask first).
   * Fails with "full" for a new name once `MAX_SAVED_MIXES` are saved.
   */
  save: (name: string, hash: string) => MixesResult;
  /** Renames a mix, keeping its place. Fails with "taken" if another mix has the new name. */
  rename: (from: string, to: string) => MixesResult;
  /** Deletes a mix; returns it, to pass to `restore` for Undo. */
  remove: (name: string) => SavedMix | undefined;
  /** Puts a deleted mix back in its place, unless its name is taken by now or there's no room. */
  restore: (mix: SavedMix) => MixesResult;
  /** The names of `incoming` mixes that would replace a different saved mix. */
  conflicts: (incoming: readonly SavedMix[]) => string[];
  /** Adds imported mixes by name; mixes of a taken name replace the saved ones only if `replace`. */
  merge: (incoming: readonly SavedMix[], replace: boolean) => MergeResult;
  /** Calls `listener` after each change, here or in another tab; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

/** Two names match if they're the same ignoring case. */
export const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** A stored entry, if it has the right shape; anything else is skipped. */
function readEntry(value: unknown): SavedMix | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const name = "name" in value ? value.name : undefined;
  const hash = "hash" in value ? value.hash : undefined;
  const savedAt = "savedAt" in value ? value.savedAt : undefined;
  if (
    typeof name !== "string" ||
    typeof hash !== "string" ||
    typeof savedAt !== "number" ||
    !Number.isFinite(savedAt) ||
    !hash.startsWith("#") ||
    hash.length > MAX_HASH_LENGTH
  ) {
    return undefined;
  }
  const clean = sanitizeName(name);
  return clean === "" ? undefined : { name: clean, hash, savedAt };
}

/** Newest first; the stable sort keeps equal times in their order. */
const byNewest = (list: readonly SavedMix[]) => list.toSorted((a, b) => b.savedAt - a.savedAt);

/** The mixes in a stored value: well-formed entries with unique names, at most `MAX_SAVED_MIXES`. */
function parse(raw: string | null): SavedMix[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: SavedMix[] = [];
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const entry = readEntry(value);
    if (entry && !out.some((m) => sameName(m.name, entry.name))) {
      out.push(entry);
    }
  }
  return byNewest(out).slice(0, MAX_SAVED_MIXES);
}

export function createSavedMixes(
  getStorage: () => PreferenceStorage | undefined = browserStorage,
  now: () => number = Date.now,
): SavedMixes {
  /** The stored mixes, or undefined when storage can't be read. */
  const read = (): SavedMix[] | undefined => {
    try {
      const storage = getStorage();
      return storage ? parse(storage.getItem(MIXES_KEY)) : undefined;
    } catch {
      return undefined;
    }
  };
  let mixes: readonly SavedMix[] = read() ?? [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };
  /** Keeps `next` and writes it; returns whether it was stored. */
  const commit = (next: SavedMix[]): boolean => {
    mixes = next;
    let stored = false;
    try {
      const storage = getStorage();
      if (storage) {
        storage.setItem(MIXES_KEY, JSON.stringify(next));
        stored = true;
      }
    } catch {
      // Full or blocked: kept in memory only.
    }
    notify();
    return stored;
  };
  const find = (name: string) => mixes.find((m) => sameName(m.name, name));
  const onStorage = (event: StorageEvent) => {
    // A null key means another tab cleared the whole storage.
    if (event.key !== MIXES_KEY && event.key !== null) {
      return;
    }
    const next = read();
    if (next && JSON.stringify(next) !== JSON.stringify(mixes)) {
      mixes = next;
      notify();
    }
  };

  return {
    get: () => mixes,
    find,
    save(name, hash) {
      const clean = sanitizeName(name);
      if (clean === "") {
        return { ok: false, reason: "empty" };
      }
      const others = mixes.filter((m) => !sameName(m.name, clean));
      if (others.length === mixes.length && mixes.length >= MAX_SAVED_MIXES) {
        return { ok: false, reason: "full" };
      }
      return { ok: true, stored: commit([{ name: clean, hash, savedAt: now() }, ...others]) };
    },
    rename(from, to) {
      const clean = sanitizeName(to);
      const current = find(from);
      if (!current) {
        return { ok: false, reason: "missing" };
      }
      if (clean === "") {
        return { ok: false, reason: "empty" };
      }
      if (mixes.some((m) => m !== current && sameName(m.name, clean))) {
        return { ok: false, reason: "taken" };
      }
      const next = mixes.map((m) => (m === current ? { ...m, name: clean } : m));
      return { ok: true, stored: commit(next) };
    },
    remove(name) {
      const current = find(name);
      if (current) {
        commit(mixes.filter((m) => m !== current));
      }
      return current;
    },
    restore(mix) {
      if (find(mix.name)) {
        return { ok: false, reason: "taken" };
      }
      if (mixes.length >= MAX_SAVED_MIXES) {
        return { ok: false, reason: "full" };
      }
      return { ok: true, stored: commit(byNewest([...mixes, mix])) };
    },
    conflicts: (incoming) =>
      incoming.flatMap((mix) => {
        const current = find(mix.name);
        return current && current.hash !== mix.hash ? [current.name] : [];
      }),
    merge(incoming, replace) {
      const next = [...mixes];
      const result = { added: 0, replaced: 0, unchanged: 0, noRoom: 0 };
      for (const mix of incoming) {
        const index = next.findIndex((m) => sameName(m.name, mix.name));
        const current = index === -1 ? undefined : next.at(index);
        if (current) {
          if (replace && current.hash !== mix.hash) {
            next[index] = mix;
            result.replaced++;
          } else {
            result.unchanged++;
          }
        } else if (next.length < MAX_SAVED_MIXES) {
          next.push(mix);
          result.added++;
        } else {
          result.noRoom++;
        }
      }
      const changed = result.added + result.replaced > 0;
      return { ...result, stored: changed ? commit(byNewest(next)) : true };
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
