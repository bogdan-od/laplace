import { toast } from "sonner";
import { describeError } from "@/lib/api";
import { ActionInProgressError, SessionStateError } from "@/machine/attempt-session";

/** The session's own errors carry a text for the person; everything else goes through `describeError`. */
export function actionErrorText(error: unknown): string {
  if (error instanceof SessionStateError || error instanceof ActionInProgressError) return error.message;
  return describeError(error);
}

export function reportActionError(error: unknown): void {
  toast.error(actionErrorText(error));
}
