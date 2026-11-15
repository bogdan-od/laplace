import { useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { Assignment, Attempt } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/format";
import { isOverdue } from "@/lib/my-assignments";
import { invalidateRoute } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { LessonSession, LessonSessionView, LessonSource } from "@/machine/lesson-session";
import type { LessonView } from "@/machine/lesson-run";
import { MachineTerminal } from "@/machine/MachineTerminal";
import { useLesson } from "@/machine/use-lesson";
import { reportActionError } from "./action-error";
import { useAsideBeside } from "./use-aside-beside";
import { Brief, WorkHeader } from "./work-layout";

/** The screen of a lesson (`kind = lesson`): the teacher's journal at 1x and the segments the student tries on their own. */
export function LessonWork({ assignment }: { assignment: Assignment }) {
  const source = useMemo<LessonSource>(() => ({ kind: "assignment", id: assignment.id }), [assignment.id]);
  const [now] = useState(() => Date.now());
  const { session, view } = useLesson(source);
  const completedAt = view.attempt?.completed_at ?? null;
  const overdue = isOverdue({ ...assignment, my_status: completedAt === null ? null : "done" }, now);
  return <LessonScreen session={session} view={view} header={<WorkHeader assignment={assignment} overdue={overdue} />} brief={assignment.brief} />;
}

interface LessonScreenProps {
  session: LessonSession | null;
  view: LessonSessionView;
  header: ReactNode;
  brief: string;
  /** The teacher's preview of a library item: nothing is completed, the last button leads back to `backTo`. */
  preview?: { backTo: string };
}

/** The lesson of `session` below `header`; the same screen for a student and for the teacher's preview. */
export function LessonScreen({ session, view, header, brief, preview }: LessonScreenProps) {
  const { beside, container, terminal } = useAsideBeside();
  const { lesson, machine } = view;
  const runtime = session?.runtime() ?? null;

  return (
    <div data-testid="work-page" data-phase={view.phase} data-kind="lesson" className={cn("flex min-h-[34rem] flex-col gap-3 p-4", beside ? "h-full" : "min-h-full")}>
      {header}

      {view.error !== null && (
        <div role="alert" data-testid="work-error" className="flex flex-wrap items-center gap-3 rounded-lg border border-status-stuck/40 bg-status-stuck/5 px-3 py-2 text-sm">
          <span className="text-status-stuck">{view.error}</span>
          {session && (
            <Button size="sm" data-testid="lesson-restart" onClick={() => session.restart()}>
              Почати урок знову
            </Button>
          )}
        </div>
      )}

      <div ref={container} data-testid="work-columns" data-beside={beside} className={cn("flex gap-4", beside ? "min-h-0 flex-1" : "flex-col")}>
        <div ref={terminal} className={cn("flex w-min max-w-full shrink-0 flex-col gap-3", beside ? "min-h-0" : "h-[34rem]")}>
          {session && lesson && <LessonPanel session={session} lesson={lesson} attempt={view.attempt} completing={view.completing} preview={preview} />}
          {machine && runtime ? (
            <MachineTerminal runtime={runtime} view={machine} className="min-h-80 flex-1" />
          ) : (
            <div className="flex min-h-80 flex-1 items-center justify-center rounded-lg bg-terminal text-sm text-terminal-foreground">
              {view.phase === "failed" ? "Машину не запущено" : "Завантаження…"}
            </div>
          )}
          {machine?.notice && (
            <p data-testid="machine-notice" className="text-[13px] text-status-work">
              {machine.notice}
            </p>
          )}
        </div>

        <aside data-testid="aside" className={cn("flex min-w-0 flex-1 flex-col gap-3", beside && "min-h-0 min-w-80 overflow-y-auto")}>
          {brief.trim() !== "" && <Brief text={brief} />}
          {lesson && <SegmentList lesson={lesson} view={view} preview={preview !== undefined} />}
        </aside>
      </div>
    </div>
  );
}

interface LessonPanelProps {
  session: LessonSession;
  lesson: LessonView;
  attempt: Attempt | null;
  completing: boolean;
  preview: { backTo: string } | undefined;
}

/** Above the terminal, as wide as it: the note of the teacher, the task of the segment, the buttons. */
function LessonPanel({ session, lesson, attempt, completing, preview }: LessonPanelProps) {
  const done = lesson.phase === "done";
  const completedAt = attempt?.completed_at ?? null;
  const hasSegments = lesson.segments.length > 0 && !done;
  const run = (job: () => Promise<void>) => () => void job().catch(reportActionError);
  const complete = () =>
    void session
      .complete()
      .then(() => invalidateRoute("GET /api/me/assignments"))
      .then(() => toast.success("Урок завершено"))
      .catch(reportActionError);

  return (
    <section data-testid="lesson-panel" data-lesson-phase={lesson.phase} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
      {lesson.note !== null && (
        <p data-testid="lesson-note" className="whitespace-pre-wrap">
          {lesson.note}
        </p>
      )}
      {lesson.task !== null && (
        <p data-testid="lesson-task" className="rounded-md border border-primary/50 bg-primary/5 px-3 py-2 font-medium whitespace-pre-wrap">
          Тепер сам: {lesson.task}
        </p>
      )}
      {hasSegments && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" data-testid="lesson-retry" disabled={!lesson.canAct} onClick={run(() => session.retry())}>
            Спробувати знову
          </Button>
          <Button size="sm" variant="outline" data-testid="lesson-solution" disabled={!lesson.canAct} onClick={run(() => session.showSolution())}>
            Показати розв&apos;язок
          </Button>
          <Button size="sm" data-testid="lesson-next" disabled={!lesson.canNext} onClick={run(() => session.next())}>
            Далі
          </Button>
        </div>
      )}
      {done && (
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="lesson-end" className="font-medium">
            Кінець уроку
          </span>
          {preview !== undefined ? (
            <Button asChild size="sm" data-testid="lesson-preview-back">
              <Link to={preview.backTo}>До предмета</Link>
            </Button>
          ) : completedAt === null ? (
            <PendingButton size="sm" pending={completing} data-testid="lesson-complete" onClick={complete}>
              Завершити урок
            </PendingButton>
          ) : (
            <span data-testid="lesson-passed-panel" className="text-muted-foreground tabular-nums">
              Урок пройдено {formatWhen(completedAt)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** "Відрізок N з M" and the list of segments with the passed ones marked; below, the state of the completion. */
function SegmentList({ lesson, view, preview }: { lesson: LessonView; view: LessonSessionView; preview: boolean }) {
  const total = lesson.segments.length;
  const current = Math.min(lesson.index + 1, total);
  const completedAt = view.attempt?.completed_at ?? null;

  return (
    <section data-testid="lesson-progress" data-index={lesson.index} className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm">
      <h2 className="font-semibold">{total === 0 ? "Урок без відрізків \"тепер сам\"" : `Відрізок ${current} з ${total}`}</h2>
      {total > 0 && (
        <ol className="flex flex-col gap-1">
          {lesson.segments.map((text, index) => {
            const passed = index < lesson.index;
            return (
              <li
                key={`${index}:${text}`}
                data-testid="lesson-segment"
                data-passed={passed}
                data-current={index === lesson.index && lesson.phase !== "done"}
                className={cn("flex items-start gap-2", passed ? "text-muted-foreground" : index === lesson.index && "font-medium")}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {passed ? <Check className="size-4 text-status-done" aria-label="Пройдено" /> : <span className="tabular-nums">{index + 1}.</span>}
                </span>
                <span>{text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {preview ? null : completedAt !== null ? (
        <p data-testid="lesson-passed" className="text-status-done tabular-nums">
          Урок пройдено {formatWhen(completedAt)}
        </p>
      ) : (
        <p data-testid="lesson-not-passed" className="text-muted-foreground">
          Урок ще не завершено
        </p>
      )}
    </section>
  );
}
