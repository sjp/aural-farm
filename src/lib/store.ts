/** A value that can be read at any time and notifies subscribers when it changes. */
interface Store<T> {
  get: () => T;
  set: (value: T) => void;
  /** Calls `listener` after each change; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

/** A tiny external store: holds one value and notifies on every change. */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) {
        return;
      }
      value = next;
      // A copy, so listeners that unsubscribe while being notified don't skip others.
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
