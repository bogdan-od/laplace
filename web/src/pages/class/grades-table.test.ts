import { describe, expect, test } from "vitest";
import type { StudentProgress } from "@shared/api";
import { buildGradesTable, gradeCell } from "./grades-table";

function student(id: number, number: number, submission: { grade: number | null } | null): StudentProgress {
  return {
    user_id: id,
    name: `Студент ${id}`,
    number,
    status: submission ? "done" : "idle",
    attempt_id: null,
    started_at: null,
    last_activity_at: null,
    commands: 0,
    last_command: "",
    rollbacks: 0,
    open_help: null,
    latest_submission: submission && { id: id, attempt_id: id, created_at: 0, verify_status: "ok", grade: submission.grade, checks: null },
  };
}

describe("gradeCell", () => {
  test("a graded submission gives the grade, zero included", () => {
    expect(gradeCell(student(1, 1, { grade: 9 }))).toEqual({ kind: "graded", grade: 9 });
    expect(gradeCell(student(1, 1, { grade: 0 }))).toEqual({ kind: "graded", grade: 0 });
  });
  test("a submission without a grade is 'submitted'", () => {
    expect(gradeCell(student(1, 1, { grade: null }))).toEqual({ kind: "submitted" });
  });
  test("no submission or no student gives an empty cell", () => {
    expect(gradeCell(student(1, 1, null))).toEqual({ kind: "none" });
    expect(gradeCell(undefined)).toEqual({ kind: "none" });
  });
});

describe("buildGradesTable", () => {
  test("a student in only some assignments has empty cells in the others", () => {
    const first = [student(10, 1, { grade: 8 }), student(11, 2, { grade: null })];
    const second = [student(11, 2, null), student(12, 3, { grade: 5 })];
    const rows = buildGradesTable([first, second]);
    expect(rows.map((row) => row.userId)).toEqual([10, 11, 12]);
    expect(rows[0]?.cells).toEqual([{ kind: "graded", grade: 8 }, { kind: "none" }]);
    expect(rows[1]?.cells).toEqual([{ kind: "submitted" }, { kind: "none" }]);
    expect(rows[2]?.cells).toEqual([{ kind: "none" }, { kind: "graded", grade: 5 }]);
  });
  test("a list that has not loaded leaves its column empty", () => {
    const rows = buildGradesTable([[student(10, 1, { grade: 7 })], undefined]);
    expect(rows[0]?.cells).toEqual([{ kind: "graded", grade: 7 }, { kind: "none" }]);
  });
  test("rows follow the class numbers", () => {
    const rows = buildGradesTable([[student(20, 3, null), student(21, 1, null), student(22, 2, null)]]);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
  });
  test("no assignments, no rows", () => {
    expect(buildGradesTable([])).toEqual([]);
  });
});
