import { useCallback, useMemo, useSyncExternalStore } from "react";
import { acquireLesson, lessonHub, lessonKey, releaseLesson } from "./lesson-factory";
import { INITIAL_LESSON_VIEW, type LessonSession, type LessonSessionView, type LessonSource } from "./lesson-session";

/** The lesson session of an assignment (or of a previewed item) and its view; created and released like `useAttempt` does it. */
export function useLesson(source: LessonSource): { session: LessonSession | null; view: LessonSessionView } {
  const { kind, id } = source;
  const stable = useMemo<LessonSource>(() => ({ kind, id }), [kind, id]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const off = acquireLesson(stable).subscribe(listener);
      return () => {
        off();
        releaseLesson(stable);
      };
    },
    [stable],
  );
  const getSnapshot = useCallback(() => lessonHub.peek(lessonKey(stable))?.getSnapshot() ?? INITIAL_LESSON_VIEW, [stable]);
  const view = useSyncExternalStore(subscribe, getSnapshot);
  return { session: lessonHub.peek(lessonKey(stable)) ?? null, view };
}
