import { useCallback, useSyncExternalStore } from "react";
import type { AttemptSession } from "./attempt-session";
import { EMPTY_NET, type NetSnapshot } from "./net-monitor";

const NO_UNSUBSCRIBE = (): void => undefined;

/** The frame counters and logs of the session; they change at most every `NET_PUBLISH_MS`. */
export function useNet(session: AttemptSession | null): NetSnapshot {
  const subscribe = useCallback((listener: () => void) => session?.net.subscribe(listener) ?? NO_UNSUBSCRIBE, [session]);
  const getSnapshot = useCallback(() => session?.net.getSnapshot() ?? EMPTY_NET, [session]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
