import { useCallback, useSyncExternalStore } from "react";
import { acquireAttempt, attemptKey, attemptHub, releaseAttempt } from "./attempt-factory";
import { INITIAL_VIEW, type AttemptSession, type AttemptView } from "./attempt-session";

/**
 * The attempt session of an assignment and its view. The session is created and counted in `subscribe`
 * (after the commit), not while rendering, so StrictMode's double mount reuses one session; it is disposed
 * 1 s after the last component let go. `session` is null until the first subscription.
 */
export function useAttempt(assignmentId: number): { session: AttemptSession | null; view: AttemptView } {
  const subscribe = useCallback(
    (listener: () => void) => {
      const off = acquireAttempt(assignmentId).subscribe(listener);
      return () => {
        off();
        releaseAttempt(assignmentId);
      };
    },
    [assignmentId],
  );
  const getSnapshot = useCallback(
    () => attemptHub.peek(attemptKey(assignmentId))?.getSnapshot() ?? INITIAL_VIEW,
    [assignmentId],
  );
  const view = useSyncExternalStore(subscribe, getSnapshot);
  return { session: attemptHub.peek(attemptKey(assignmentId)) ?? null, view };
}
