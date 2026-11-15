import { Link } from "react-router";
import type { SubmissionSummary } from "@shared/api";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { submissionState } from "@/pages/work/verify-text";
import { sortSubmissions } from "./attempt-view";

export interface SubmissionListProps {
  submissions: readonly SubmissionSummary[];
  maxGrade: number;
  /** The submission whose panel is open (`?submission=`), if any. */
  selected: number | null;
}

/** The student's submissions, newest first; a row opens its panel on this page (`?submission=<id>`). */
export function SubmissionList({ submissions, maxGrade, selected }: SubmissionListProps) {
  return (
    <section data-testid="submission-list" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Здачі</h2>
      {submissions.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">Студент ще не здавав роботу</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-card text-sm">
          {sortSubmissions(submissions).map((item) => (
            <li key={item.id}>
              <Link
                to={{ search: `?submission=${item.id}` }}
                data-testid="submission-row"
                data-submission={item.id}
                className={cn("flex items-baseline gap-3 px-3 py-2 hover:bg-muted", item.id === selected && "bg-primary/8")}
              >
                <span className="text-muted-foreground tabular-nums">{formatWhen(item.created_at)}</span>
                <span className={cn("font-medium", submissionState(item).tone)}>{submissionState(item).text}</span>
                <span className="ml-auto font-semibold tabular-nums">
                  {item.grade === null ? "-" : `${item.grade}/${maxGrade}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
