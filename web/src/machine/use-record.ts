import { useCallback, useSyncExternalStore } from "react";
import { acquireRecord, recordHub, recordKey, releaseRecord } from "./record-factory";
import { INITIAL_RECORD_VIEW, type RecordSession, type RecordView } from "./record-session";

/** The recording session of an item and its view; created and released like `useLesson` does it. */
export function useRecord(itemId: number): { session: RecordSession | null; view: RecordView } {
  const subscribe = useCallback(
    (listener: () => void) => {
      const off = acquireRecord(itemId).subscribe(listener);
      return () => {
        off();
        releaseRecord(itemId);
      };
    },
    [itemId],
  );
  const getSnapshot = useCallback(() => recordHub.peek(recordKey(itemId))?.getSnapshot() ?? INITIAL_RECORD_VIEW, [itemId]);
  const view = useSyncExternalStore(subscribe, getSnapshot);
  return { session: recordHub.peek(recordKey(itemId)) ?? null, view };
}
