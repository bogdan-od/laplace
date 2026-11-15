import type { AssignmentSummary, TileStatus } from "@shared/api";
import { cn } from "@/lib/utils";
import { statusText } from "./status-text";

const COLOR: Record<TileStatus, string> = {
  done: "text-status-done",
  stuck: "text-status-stuck",
  work: "text-status-work",
  idle: "text-muted-foreground",
};

const DOT: Record<TileStatus, string> = {
  done: "bg-status-done",
  stuck: "bg-status-stuck",
  work: "bg-status-work",
  idle: "bg-status-idle",
};

/** The student's own status of an assignment: a colored dot and the word (color alone is not enough). */
export function StatusLabel({ status, kind, className }: { status: TileStatus; kind?: AssignmentSummary["kind"]; className?: string }) {
  return (
    <span data-status={status} className={cn("inline-flex items-center gap-1.5 font-medium", COLOR[status], className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[status])} />
      {statusText(status, kind)}
    </span>
  );
}
