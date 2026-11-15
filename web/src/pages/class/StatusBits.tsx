import type { StudentProgress, TileStatus } from "@shared/api";
import { cn } from "@/lib/utils";
import { countByStatus, STATUS_ORDER, STATUS_TEXT, STATUS_TEXT_MANY } from "./student-view";

const DOT: Record<TileStatus, string> = {
  stuck: "bg-status-stuck",
  work: "bg-status-work",
  done: "bg-status-done",
  idle: "bg-status-idle",
};

const TEXT: Record<TileStatus, string> = {
  stuck: "text-status-stuck",
  work: "text-status-work",
  done: "text-status-done",
  idle: "text-muted-foreground",
};

function StatusDot({ status }: { status: TileStatus }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status])} />;
}

/** A student's status in the class: the mock's words and colors (not the student screens' `StatusLabel`). */
export function StudentStatus({ status }: { status: TileStatus }) {
  return (
    <span data-status={status} className={cn("inline-flex items-center gap-1.5 font-medium", TEXT[status])}>
      <StatusDot status={status} />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function StatusSummary({ students }: { students: readonly StudentProgress[] }) {
  const counts = countByStatus(students);
  const total = students.length;
  return (
    <div data-testid="status-summary" className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-muted">
        {STATUS_ORDER.map((status) => (
          <div key={status} className={DOT[status]} style={{ width: `${total === 0 ? 0 : (counts[status] / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {STATUS_ORDER.map((status) => (
          <span key={status} data-count={status} className="inline-flex items-center gap-1.5">
            <StatusDot status={status} />
            <span className="font-semibold tabular-nums">{counts[status]}</span>
            <span className="text-muted-foreground">{STATUS_TEXT_MANY[status]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
