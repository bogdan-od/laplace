import type { SubmissionSummary, VerifyStatus } from "@shared/api";

export const VERIFY_TEXT: Record<VerifyStatus, string> = {
  queued: "Перевіряється…",
  running: "Перевіряється…",
  ok: "Перевірку пройдено",
  failed: "Перевірка не пройшла",
  timeout: "Перевірка не пройшла",
  tail_unchecked: "Частину після останньої перевірки не перевірено",
};

export const VERIFY_TONE: Record<VerifyStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-muted-foreground",
  ok: "text-status-done",
  failed: "text-status-stuck",
  timeout: "text-status-stuck",
  tail_unchecked: "text-status-work",
};

export interface StateLabel {
  text: string;
  tone: string;
}

/**
 * The state of a submission in a list: a replay that did not pass shows as before; when the journal
 * is intact the line shows the result of the check commands (all passed, some, none), if there is one.
 */
export function submissionState({ verify_status: status, checks }: Pick<SubmissionSummary, "verify_status" | "checks">): StateLabel {
  if (status !== "ok" || checks === null) return { text: VERIFY_TEXT[status], tone: VERIFY_TONE[status] };
  const text = `Перевірки ${checks.passed}/${checks.total}`;
  if (checks.passed === checks.total) return { text, tone: "text-status-done" };
  return { text, tone: checks.passed === 0 ? "text-status-stuck" : "text-status-work" };
}
