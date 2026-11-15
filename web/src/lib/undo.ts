// Delete now, offer "Скасувати" for UNDO_MS. The server keeps the deleted
// object for longer than UNDO_MS and `restore` brings it back.

import { toast } from "sonner";
import { UNDO_MS } from "@shared/limits";
import { describeError } from "./api";

export interface UndoNotifier {
  /** Shows the message with an action button; the toast disappears after durationMs. */
  withAction(message: string, action: { label: string; onClick: () => void }, durationMs: number): void;
  success(message: string): void;
  error(message: string): void;
}

export const sonnerNotifier: UndoNotifier = {
  withAction: (message, action, durationMs) => {
    toast(message, { duration: durationMs, action });
  },
  success: (message) => {
    toast.success(message);
  },
  error: (message) => {
    toast.error(message);
  },
};

export interface DeleteWithUndo {
  /** Past-tense-free text of the toast, e.g. "Клас видалено". */
  message: string;
  remove: () => Promise<unknown>;
  restore: () => Promise<unknown>;
  /** Called after the delete and again after a successful undo (refresh lists here). */
  refresh?: () => void;
  /** Text after a successful undo. */
  restoredMessage?: string;
}

export const UNDO_LABEL = "Скасувати";

/** Resolves to true when the object was deleted (whether or not it was restored later). */
export async function deleteWithUndo(job: DeleteWithUndo, notifier: UndoNotifier = sonnerNotifier): Promise<boolean> {
  try {
    await job.remove();
  } catch (error) {
    notifier.error(describeError(error));
    return false;
  }
  job.refresh?.();
  notifier.withAction(
    job.message,
    {
      label: UNDO_LABEL,
      onClick: () => {
        job
          .restore()
          .then(() => {
            job.refresh?.();
            notifier.success(job.restoredMessage ?? "Відновлено");
          })
          .catch((error: unknown) => notifier.error(describeError(error)));
      },
    },
    UNDO_MS,
  );
  return true;
}
