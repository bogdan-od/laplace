import { useQueries } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Link } from "react-router";
import type { AssignmentSummary } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import { buildGradesTable, type GradeCell } from "./grades-table";

function Cell({ cell, maxGrade }: { cell: GradeCell; maxGrade: number }) {
  if (cell.kind === "graded") {
    return (
      <span className="font-semibold tabular-nums">
        {cell.grade}
        <span className="font-normal text-muted-foreground">/{maxGrade}</span>
      </span>
    );
  }
  if (cell.kind === "submitted") return <span className="text-status-done">здано</span>;
  return null;
}

export function GradesTab({ classId, assignments }: { classId: number; assignments: readonly AssignmentSummary[] }) {
  // Lessons have no grades; the columns go oldest first, as in the server's grades.csv.
  const tasks = assignments
    .filter((assignment) => assignment.kind === "task")
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const lists = useQueries({
    queries: tasks.map((task) => apiQuery("GET /api/assignments/:id/students", { params: { id: task.id } })),
  });
  const failed = lists.find((list) => list.error);
  const rows = buildGradesTable(lists.map((list) => list.data));

  const exportButton = (
    <Button variant="outline" asChild>
      <a href={`/api/classes/${classId}/grades.csv`} download data-testid="grades-export">
        <Download /> Експорт CSV
      </a>
    </Button>
  );

  if (tasks.length === 0) {
    return <EmptyState title="У класі ще немає завдань з оцінками" hint="Видайте завдання, і тут з'явиться таблиця оцінок." />;
  }
  return (
    <div className="flex flex-col gap-4 px-6 py-5" data-testid="grades-tab">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg font-bold">Оцінки</h2>
        <span className="ml-auto">{exportButton}</span>
      </div>
      {failed?.error && <p className="text-sm text-destructive">{describeError(failed.error)}</p>}
      {lists.some((list) => list.isPending) && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Завантаження…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="У класі ще немає студентів" hint="Імпортуйте список або надішліть студентам посилання-запрошення." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 text-right">№</TableHead>
                <TableHead>ПІБ</TableHead>
                {tasks.map((task) => (
                  <TableHead key={task.id} className="max-w-48 text-right">
                    <div className="truncate" title={task.title}>
                      {task.title}
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.userId} data-testid="grade-row" data-student={row.userId}>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{row.number}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  {tasks.map((task, column) => {
                    const cell = row.cells[column] ?? { kind: "none" as const };
                    return (
                      <TableCell key={task.id} className="p-0 text-right" data-testid="grade-cell" data-cell={cell.kind}>
                        <Link
                          to={`/classes/${classId}/assignments/${task.id}/students/${row.userId}`}
                          className="block px-2 py-2 hover:bg-muted/50"
                          aria-label={`${row.name}: ${task.title}`}
                        >
                          <Cell cell={cell} maxGrade={task.max_grade} />
                          {cell.kind === "none" && <span className="sr-only">немає здачі</span>}
                        </Link>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
