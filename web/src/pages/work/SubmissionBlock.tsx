import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { SubmissionSummary } from "@shared/api";
import { formatWhen } from "@/lib/format";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { VERIFY_TEXT, VERIFY_TONE } from "./verify-text";

export interface SubmissionBlockProps {
  /** The latest submission of the attempt. */
  latest: SubmissionSummary;
  maxGrade: number;
  /** The machines of the task: "Відкрити запис" plays the recording of each. */
  nodes: readonly string[];
}

/** The latest hand-in: the check, the grade and the teacher's comments. The caller refreshes the query on server messages. */
export function SubmissionBlock({ latest, maxGrade, nodes }: SubmissionBlockProps) {
  const detail = useQuery(apiQuery("GET /api/submissions/:id", { params: { id: latest.id } }));
  const submission = detail.data ?? latest;
  const verifyMessage = detail.data?.verify_message ?? null;
  const showMessage = verifyMessage && (submission.verify_status === "failed" || submission.verify_status === "timeout");

  return (
    <section
      data-testid="submission-block"
      data-submission={latest.id}
      data-verify={submission.verify_status}
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Остання здача</h2>
        <span className="text-[13px] text-muted-foreground tabular-nums">{formatWhen(submission.created_at)}</span>
        <span className="ml-auto flex flex-wrap items-baseline gap-x-3 text-[13px]">
          {nodes.map((node) => (
            <Link key={node} to={`/play/submission-${latest.id}-${node}`} className="text-primary hover:underline" data-testid="submission-open">
              Відкрити запис{nodes.length > 1 && <span className="font-mono"> {node}</span>}
            </Link>
          ))}
        </span>
      </div>
      <p data-testid="submission-verify" className={cn("text-sm font-medium", VERIFY_TONE[submission.verify_status])}>
        {VERIFY_TEXT[submission.verify_status]}
      </p>
      {showMessage && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{verifyMessage}</p>}
      <p data-testid="submission-grade" className="text-sm tabular-nums">
        {submission.grade === null ? (
          <span className="text-muted-foreground">Оцінки ще немає</span>
        ) : (
          <>
            Оцінка: <span className="font-semibold">{submission.grade}</span> з {maxGrade}
          </>
        )}
      </p>
      {detail.data && detail.data.note !== "" && (
        <p className="text-sm whitespace-pre-wrap" data-testid="submission-note">
          {detail.data.note}
        </p>
      )}
      {detail.data && detail.data.comments.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t pt-2" data-testid="submission-comments">
          {detail.data.comments.map((comment) => (
            <li key={comment.id} data-testid="submission-comment" className="text-sm">
              <span className="text-[13px] text-muted-foreground">
                {comment.author.name} · {formatWhen(comment.created_at)}
              </span>
              <p className="whitespace-pre-wrap">{comment.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
