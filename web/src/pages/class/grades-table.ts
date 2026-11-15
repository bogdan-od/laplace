import type { StudentProgress } from "@shared/api";

export type GradeCell = { kind: "graded"; grade: number } | { kind: "submitted" } | { kind: "none" };

export interface GradeRow {
  userId: number;
  number: number;
  name: string;
  /** One cell per assignment, in the order the assignments were given. */
  cells: GradeCell[];
}

const NO_CELL: GradeCell = { kind: "none" };

/** The grade comes from the latest submission: a number, "submitted" when it is not graded yet, nothing without one. */
export function gradeCell(student: StudentProgress | undefined): GradeCell {
  const submission = student?.latest_submission ?? null;
  if (submission === null) return NO_CELL;
  return submission.grade === null ? { kind: "submitted" } : { kind: "graded", grade: submission.grade };
}

/**
 * Students x assignments. `lists[i]` is the student list of the i-th assignment (undefined while it is loading
 * or failed). A student missing from a list gets an empty cell there, so a late joiner still has a row.
 */
export function buildGradesTable(lists: readonly (readonly StudentProgress[] | undefined)[]): GradeRow[] {
  const rows = new Map<number, GradeRow>();
  lists.forEach((list, column) => {
    for (const student of list ?? []) {
      let row = rows.get(student.user_id);
      if (!row) {
        row = { userId: student.user_id, number: student.number, name: student.name, cells: lists.map(() => NO_CELL) };
        rows.set(student.user_id, row);
      }
      row.cells[column] = gradeCell(student);
    }
  });
  return [...rows.values()].sort((a, b) => a.number - b.number || a.userId - b.userId);
}
