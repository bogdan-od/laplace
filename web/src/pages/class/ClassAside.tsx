import { GitBranch, History } from "lucide-react";
import { Link } from "react-router";
import type { AssignmentSummary, StudentProgress } from "@shared/api";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { useHelpMoment } from "@/pages/student/use-help-moment";
import { agoText, studentHref } from "./student-view";

function totalOf(assignment: AssignmentSummary): number {
  return Object.values(assignment.counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

function HelpCard({ student, href, now }: { student: StudentProgress; href: string; now: number }) {
  const { opening, open } = useHelpMoment();
  const help = student.open_help;
  if (!help) return null;
  return (
    <div data-testid="help-card" className="flex flex-col gap-2 rounded-lg border border-status-stuck/30 bg-card p-3">
      <div className="flex items-baseline justify-between">
        <Link to={href} className="font-medium hover:underline">
          {student.name}
        </Link>
        <span className="text-[13px] text-muted-foreground">{agoText(help.created_at, now)}</span>
      </div>
      <p className="text-[13px]">{help.text}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to={href}>
            <History /> Переглянути момент
          </Link>
        </Button>
        <Button size="sm" variant="outline" data-testid="help-reply" disabled={opening === help.id} onClick={() => void open(help, true)}>
          <GitBranch /> Відповісти
        </Button>
      </div>
    </div>
  );
}

export function ClassAside({
  students,
  others,
  classId,
  assignmentId,
  now,
  onPick,
}: {
  students: readonly StudentProgress[];
  others: readonly AssignmentSummary[];
  classId: number;
  assignmentId: number;
  now: number;
  onPick: (assignmentId: number) => void;
}) {
  const asking = students.filter((student) => student.open_help);
  return (
    <aside data-testid="class-aside" className="flex w-full flex-col gap-6 lg:w-80 lg:shrink-0">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Просять допомоги <span className="ml-2 font-normal text-muted-foreground">{asking.length}</span></h2>
        {asking.map((student) => (
          <HelpCard key={student.user_id} student={student} href={studentHref(classId, assignmentId, student)} now={now} />
        ))}
      </section>
      {others.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Інші завдання класу</h2>
          <div className="flex flex-col divide-y rounded-lg border bg-card">
            {others.map((assignment) => (
              <button
                key={assignment.id}
                type="button"
                onClick={() => onPick(assignment.id)}
                className="flex flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-muted"
              >
                <span className="font-medium">{assignment.title}</span>
                <span className="text-[13px] text-muted-foreground">
                  Здали {assignment.counts.done ?? 0} з {totalOf(assignment)}
                  {assignment.due_at !== null && <>, термін {formatDate(assignment.due_at, now)}</>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
