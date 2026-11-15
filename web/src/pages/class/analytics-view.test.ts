import { describe, expect, test } from "vitest";
import type { Analytics } from "@shared/api";
import { gradeColumns, hasNotStarted, minutesText, showsLabel, splitStudents, spreadText } from "./analytics-view";

describe("gradeColumns", () => {
  test("a column for every grade 0..max, heights relative to the tallest", () => {
    const columns = gradeColumns([{ grade: 8, count: 4 }, { grade: 10, count: 2 }, { grade: 0, count: 1 }], 10);
    expect(columns).toHaveLength(11);
    expect(columns[8]).toEqual({ grade: 8, count: 4, percent: 100 });
    expect(columns[10]).toEqual({ grade: 10, count: 2, percent: 50 });
    expect(columns[9]).toEqual({ grade: 9, count: 0, percent: 0 });
    expect(columns[0]?.percent).toBe(25);
  });
  test("no grades: all columns empty, no division by zero", () => {
    const columns = gradeColumns([], 5);
    expect(columns).toHaveLength(6);
    expect(columns.every((column) => column.count === 0 && column.percent === 0)).toBe(true);
  });
  test("a grade above the maximum still gets a column", () => {
    const columns = gradeColumns([{ grade: 12, count: 1 }], 10);
    expect(columns).toHaveLength(13);
    expect(columns[12]?.count).toBe(1);
  });
  test("labels: every column when few, every tenth when many", () => {
    expect(showsLabel(3, 11)).toBe(true);
    expect(showsLabel(3, 101)).toBe(false);
    expect(showsLabel(30, 101)).toBe(true);
  });
});

describe("minutes", () => {
  test("decimal comma and a dash for nothing", () => {
    expect(minutesText(12.5)).toBe("12,5 хв");
    expect(minutesText(7)).toBe("7 хв");
    expect(minutesText(null)).toBe("-");
  });
  test("under a minute: seconds", () => {
    expect(minutesText(0.2)).toBe("12 с");
    expect(minutesText(0.67)).toBe("40 с");
    expect(minutesText(0)).toBe("0 с");
    expect(minutesText(0.999)).toBe("1 хв");
  });
  test("a minute and more: one decimal at most", () => {
    expect(minutesText(1)).toBe("1 хв");
    expect(minutesText(12.53)).toBe("12,5 хв");
  });
  test("spread", () => {
    expect(spreadText({ median: 10, min: 4, max: 31.5 })).toBe("від 4 до 31,5 хв");
    expect(spreadText({ median: null, min: null, max: null })).toBe("-");
  });
  test("spread that starts under a minute names its unit", () => {
    expect(spreadText({ median: 5, min: 0.2, max: 31.5 })).toBe("від 12 с до 31,5 хв");
  });
});

describe("students who have not started", () => {
  const row = (patch: Partial<Analytics["per_student"][number]>): Analytics["per_student"][number] => ({
    user_id: 1,
    name: "Студент",
    minutes_to_submit: null,
    commands: null,
    rollbacks: 0,
    help_requests: 0,
    hints_used: 0,
    grade: null,
    ...patch,
  });
  test("an empty row is idle, any trace of work is not", () => {
    expect(hasNotStarted(row({}))).toBe(true);
    expect(hasNotStarted(row({ rollbacks: 1 }))).toBe(false);
    expect(hasNotStarted(row({ help_requests: 2 }))).toBe(false);
    expect(hasNotStarted(row({ commands: 0 }))).toBe(false);
    expect(hasNotStarted(row({ grade: 0 }))).toBe(false);
  });
  test("the split keeps the order of both groups", () => {
    const split = splitStudents([row({ user_id: 1 }), row({ user_id: 2, grade: 9 }), row({ user_id: 3 })]);
    expect(split.worked.map((r) => r.user_id)).toEqual([2]);
    expect(split.idle.map((r) => r.user_id)).toEqual([1, 3]);
  });
  test("the room strip decides when it is known", () => {
    const split = splitStudents([row({ user_id: 1 }), row({ user_id: 2, rollbacks: 1 })], new Set([2]));
    expect(split.worked.map((r) => r.user_id)).toEqual([1]);
    expect(split.idle.map((r) => r.user_id)).toEqual([2]);
  });
});
