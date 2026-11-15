import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Analytics } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { gradeColumns, minutesText, numberText, showsLabel, splitStudents, spreadText } from "./analytics-view";

const BARS_HEIGHT_PX = 160;

function Figure({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span data-testid={testId} className="text-xl font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** A count: a zero is grey, so the eye goes to the cells that have something. */
function Count({ value }: { value: number }) {
  return <TableCell className={cn("text-right tabular-nums", value === 0 && "text-muted-foreground")}>{value}</TableCell>;
}

function GradeBars({ analytics, maxGrade }: { analytics: Analytics; maxGrade: number }) {
  const columns = gradeColumns(analytics.grades, maxGrade);
  return (
    <div className="rounded-lg border bg-card p-4" data-testid="grade-bars">
      <h3 className="mb-3 text-sm font-semibold">Розподіл оцінок</h3>
      <div className="flex items-end gap-1" style={{ height: BARS_HEIGHT_PX }}>
        {columns.map((column) => (
          <div key={column.grade} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" data-testid="grade-bar" data-grade={column.grade} data-count={column.count}>
            <span className="text-xs tabular-nums text-muted-foreground">{column.count > 0 ? column.count : ""}</span>
            <div className="w-full rounded-t-sm bg-primary" style={{ height: `${column.percent}%`, minHeight: column.count > 0 ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {columns.map((column) => (
          <span key={column.grade} className="min-w-0 flex-1 text-center text-xs tabular-nums text-muted-foreground">
            {showsLabel(column.grade, columns.length) ? column.grade : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AnalyticsView({
  classId,
  assignmentId,
  maxGrade,
  idleIds,
}: {
  classId: number;
  assignmentId: number;
  maxGrade: number;
  idleIds?: ReadonlySet<number>;
}) {
  const query = useQuery(apiQuery("GET /api/assignments/:id/analytics", { params: { id: assignmentId } }));
  if (query.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (query.error) {
    return <EmptyState title={describeError(query.error)} action={<Button onClick={() => void query.refetch()}>Спробувати знову</Button>} />;
  }
  const data = query.data;
  const spread = data.minutes_to_submit;
  const { worked, idle } = splitStudents(data.per_student, idleIds);

  return (
    <div className="flex flex-col gap-5 px-6 py-5" data-testid="analytics-view">
      <div className="grid grid-cols-4 gap-4">
        <Figure label="Відкрили завдання" value={`${data.opened} з ${data.students}`} testId="an-opened" />
        <Figure label="Здали" value={`${data.submitted} з ${data.students}`} testId="an-submitted" />
        <Figure label="Медіана часу до здачі" value={minutesText(spread.median)} testId="an-median" />
        <Figure label="Розкид часу до здачі" value={spreadText(spread)} testId="an-spread" />
      </div>
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1 rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Студент</TableHead>
                <TableHead className="w-28 text-right">До здачі</TableHead>
                <TableHead className="w-20 text-right">Команд</TableHead>
                <TableHead className="w-24 text-right">Відкатів</TableHead>
                <TableHead className="w-28 text-right">"Не працює"</TableHead>
                <TableHead className="w-24 text-right">Підказок</TableHead>
                <TableHead className="w-24 text-right">Оцінка</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {worked.map((student) => (
                <TableRow key={student.user_id} data-testid="an-row" data-student={student.user_id}>
                  <TableCell className="font-medium">
                    <Link to={`/classes/${classId}/assignments/${assignmentId}/students/${student.user_id}`} className="hover:underline">
                      {student.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{minutesText(student.minutes_to_submit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{numberText(student.commands)}</TableCell>
                  <Count value={student.rollbacks} />
                  <Count value={student.help_requests} />
                  <Count value={student.hints_used} />
                  <TableCell className="text-right tabular-nums">{numberText(student.grade)}</TableCell>
                </TableRow>
              ))}
              {idle.length > 0 && (
                <TableRow data-testid="an-idle" className="hover:bg-transparent">
                  <TableCell colSpan={7} className="whitespace-normal text-muted-foreground">
                    Не почали: {idle.map((student, index) => (
                      <span key={student.user_id}>
                        {index > 0 && ", "}
                        <Link to={`/classes/${classId}/assignments/${assignmentId}/students/${student.user_id}`} className="hover:underline">
                          {student.name}
                        </Link>
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="w-96 shrink-0">
          <GradeBars analytics={data} maxGrade={maxGrade} />
        </div>
      </div>
    </div>
  );
}
