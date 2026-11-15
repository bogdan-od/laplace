import type { AssignmentSummary, TileStatus } from "@shared/api";

const TEXT: Record<TileStatus, string> = {
  done: "Здано",
  stuck: "Потрібна допомога",
  work: "В роботі",
  idle: "Не розпочато",
};

/** A lesson is not handed in, it is gone through. */
export function statusText(status: TileStatus, kind: AssignmentSummary["kind"] = "task"): string {
  return status === "done" && kind === "lesson" ? "Пройдено" : TEXT[status];
}
