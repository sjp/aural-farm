/** On-demand loading of sound implementations. */
import type { SoundDefinition } from "./types";

/** A registry entry: the sound's metadata plus how to load its implementation. */
interface Loadable {
  id: string;
  load: () => Promise<SoundDefinition>;
}

interface SoundLoader {
  /** The definition, if it has finished loading. */
  get: (id: string) => SoundDefinition | undefined;
  /** Loads once per id; a failed load is forgotten so it can be retried. */
  load: (entry: Loadable) => Promise<SoundDefinition>;
  /** Starts a load and ignores the outcome. */
  prefetch: (entry: Loadable) => void;
}

export function createSoundLoader(): SoundLoader {
  const pending = new Map<string, Promise<SoundDefinition>>();
  const loaded = new Map<string, SoundDefinition>();
  const load = (entry: Loadable): Promise<SoundDefinition> => {
    let promise = pending.get(entry.id);
    if (!promise) {
      promise = entry.load().then(
        (definition) => {
          if (definition.id !== entry.id) {
            throw new Error(`Loaded sound "${definition.id}" for "${entry.id}"`);
          }
          loaded.set(entry.id, definition);
          return definition;
        },
        (error: unknown) => {
          pending.delete(entry.id);
          throw error;
        },
      );
      pending.set(entry.id, promise);
    }
    return promise;
  };
  return {
    get: (id) => loaded.get(id),
    load,
    prefetch(entry) {
      load(entry).catch(() => undefined);
    },
  };
}

/** Delivers only the newest of several overlapping loads; older results are dropped. */
interface Latest<T> {
  run: (promise: Promise<T>, onLoad: (value: T) => void, onError: (error: unknown) => void) => void;
  /** Drops whatever is in flight. */
  cancel: () => void;
}

export function createLatest<T>(): Latest<T> {
  let generation = 0;
  return {
    run(promise, onLoad, onError) {
      const current = ++generation;
      // Both outcomes are handled, so the chain never rejects.
      promise
        .then((value) => {
          if (current === generation) {
            onLoad(value);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (current === generation) {
            onError(error);
          }
        });
    },
    cancel() {
      generation++;
    },
  };
}

/**
 * Runs `fn` when the browser is idle (or after a short delay where
 * `requestIdleCallback` is missing). Returns a function that cancels it.
 */
export function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(fn, { timeout: 2000 });
    return () => {
      cancelIdleCallback(handle);
    };
  }
  const timer = setTimeout(fn, 200);
  return () => {
    clearTimeout(timer);
  };
}
