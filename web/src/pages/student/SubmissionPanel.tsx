import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Clock, Play, RotateCw, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { Assignment, LibraryItem } from "@shared/api";
import { Button } from "@/components/ui/button";
import { api, ApiFailure, describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { socket } from "@/lib/live";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { cn } from "@/lib/utils";
import { VERIFY_TONE } from "@/pages/work/verify-text";
import { CheckRunBlock } from "./CheckRunBlock";
import { GradeForm } from "./GradeForm";
import { GrowthChartView } from "./GrowthChart";
import { MachineActions } from "./MachineActions";
import { verifyLine } from "./submission-view";

const LMS_POLL_MS = 2000;

export interface SubmissionPanelProps {
  submissionId: number;
  /** The attempt the page shows: a submission of another attempt is not this student's. */
  attemptId: number;
  assignment: Assignment;
  /** Reloads what the page shows (attempt, class and review lists, the submission itself). */
  refresh: () => Promise<void>;
  onClose: () => void;
}

/** One hand-in of the student: the journal check, its growth, the teacher's commands and the grade. */
export function SubmissionPanel({ submissionId, attemptId, assignment, refresh, onClose }: SubmissionPanelProps) {
  const detail = useQuery({
    ...apiQuery("GET /api/submissions/:id", { params: { id: submissionId } }),
    // The grade goes to the LMS in the background: follow it until it is sent or has failed.
    refetchInterval: (query) =>
      query.state.data?.grade !== null && query.state.data?.lms_grade?.status === "pending" ? LMS_POLL_MS : false,
  });
  const [verifying, setVerifying] = useState(false);
  const [lesson, setLesson] = useState<LibraryItem | null>(null);
  const [creating, setCreating] = useState(false);
  // The reference journal is in the item the assignment was made from.
  const referenceNodes = new Set(assignment.journals.filter((journal) => journal.role === "reference").map((journal) => journal.node));

  // The server says "submission" when the check of the journal moves on or ends.
  useEffect(
    () =>
      socket.on("submission", (message) => {
        if (message.submission.id === submissionId) void refresh();
      }),
    [submissionId, refresh],
  );

  const frame = (children: ReactNode) => (
    <section data-testid="submission-panel" data-submission={submissionId} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      {children}
    </section>
  );

  if (detail.isPending) return frame(<p className="text-sm text-muted-foreground">Завантаження…</p>);
  if (detail.error || detail.data.attempt_id !== attemptId) {
    const missing = !detail.error || (detail.error instanceof ApiFailure && detail.error.status === 404);
    return frame(
      <div className="flex items-center gap-2">
        <p className="text-sm">{missing ? "Здачу не знайдено" : describeError(detail.error)}</p>
        <CloseButton onClose={onClose} />
      </div>,
    );
  }

  const submission = detail.data;
  const verifyRunning = submission.verify_status === "queued" || submission.verify_status === "running";
  const machines = assignment.topology.machines;

  const verifyAgain = async () => {
    setVerifying(true);
    try {
      await api("POST /api/submissions/:id/verify", { params: { id: submissionId } });
      await refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setVerifying(false);
    }
  };

  const makeLesson = async (node: string) => {
    setCreating(true);
    try {
      setLesson(await api("POST /api/library/lesson-from-submission", { body: { submission_id: submissionId, node } }));
      toast.success("Урок створено");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setCreating(false);
    }
  };

  const onSettled = () => void invalidateRoute("GET /api/submissions/:id");

  return frame(
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Здача {formatWhen(submission.created_at)}</h2>
          <CloseButton onClose={onClose} />
        </div>
        <p
          data-testid="verify-status"
          data-verify={submission.verify_status}
          className={cn("flex items-start gap-2 text-sm", VERIFY_TONE[submission.verify_status])}
        >
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span className="whitespace-pre-wrap">{verifyLine(submission.verify_status, submission.verify_message, submission.commands_count)}</span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            data-testid="verify-again"
            disabled={verifying || verifyRunning}
            onClick={() => void verifyAgain()}
          >
            <RotateCw /> Перевірити ще раз
          </Button>
        </p>
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4 shrink-0" />
            Журнал надходив на сервер частинами, а не одним файлом наприкінці
          </p>
          <GrowthChartView growth={submission.growth} />
        </div>
      </div>

      <CheckRunBlock submissionId={submissionId} saved={submission.check_runs.at(-1) ?? null} checks={assignment.checks ?? []} onSettled={onSettled} />

      <GradeForm key={submissionId} submission={submission} onSaved={refresh} />

      <div data-testid="submission-players" className="flex flex-col gap-3 border-t pt-4">
        {machines.map((machine) => (
          <div key={machine.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Button asChild size="sm">
              <Link to={`/play/submission-${submissionId}-${machine.id}`} data-testid="submission-open">
                <Play /> Відкрити запис{machines.length > 1 && <span className="font-mono">{machine.id}</span>}
              </Link>
            </Button>
            <MachineActions
              submissionId={submissionId}
              studentId={submission.student.id}
              node={machine.id}
              referenceItem={referenceNodes.has(machine.id) ? assignment.item_id : null}
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {machines.length === 1 && machines[0] !== undefined ? (
            <Button variant="outline" size="sm" data-testid="make-lesson" disabled={creating} onClick={() => void makeLesson(machines[0]?.id ?? "")}>
              <BookOpen /> Зробити урок
            </Button>
          ) : (
            <span className="text-[13px] text-muted-foreground">Урок можна створити лише зі здачі з однією машиною</span>
          )}
          {lesson !== null && (
            <p data-testid="lesson-created" className="text-sm">
              Урок створено:{" "}
              <Link to={`/library/${lesson.id}`} className="text-primary hover:underline">
                {lesson.title}
              </Link>
            </p>
          )}
        </div>
      </div>
    </>,
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button size="icon-sm" variant="ghost" className="ml-auto" data-testid="submission-close" aria-label="Закрити панель здачі" onClick={onClose}>
      <X />
    </Button>
  );
}
