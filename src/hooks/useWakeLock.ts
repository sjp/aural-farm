import { useEffect, useState } from "preact/hooks";
import { createScreenWakeLock, type WakeLockLike } from "../lib/wake-lock";

/** Keeps the screen on while `wanted`, where the browser offers a wake lock. */
export function useWakeLock(wanted: boolean, wakeLock: WakeLockLike | undefined): void {
  const [lock] = useState(() => (wakeLock ? createScreenWakeLock(wakeLock) : undefined));
  useEffect(
    () => () => {
      lock?.dispose();
    },
    [lock],
  );
  useEffect(() => {
    lock?.set(wanted);
  }, [lock, wanted]);
}
