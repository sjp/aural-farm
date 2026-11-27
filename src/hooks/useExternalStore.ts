import { useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * Reads an external store's snapshot and re-renders when it changes. A minimal
 * `useSyncExternalStore`: the snapshot is re-read right after subscribing, so a
 * change between the render and the subscription isn't missed.
 */
export function useExternalStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T {
  const value = getSnapshot();
  const [, forceRender] = useState(0);
  const latest = useRef({ value, getSnapshot });
  useLayoutEffect(() => {
    latest.current = { value, getSnapshot };
  });
  useLayoutEffect(() => {
    const check = () => {
      if (!Object.is(latest.current.getSnapshot(), latest.current.value)) {
        forceRender((n) => n + 1);
      }
    };
    const unsubscribe = subscribe(check);
    check();
    return unsubscribe;
  }, [subscribe]);
  return value;
}
