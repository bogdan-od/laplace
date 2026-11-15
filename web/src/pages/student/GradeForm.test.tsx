import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LmsGrade, Submission } from "@shared/api";
import { GradeForm } from "./GradeForm";

function submission(lms: LmsGrade | null, grade: number | null = 8): Submission {
  return {
    id: 1,
    attempt_id: 1,
    created_at: 0,
    verify_status: "ok",
    grade,
    checks: null,
    assignment: { id: 1, title: "Мережа", class_id: 1, class_name: "КН-21", max_grade: 10, due_at: null },
    student: { id: 2, name: "Студент" },
    journals: [],
    verify_message: null,
    commands_count: 3,
    hints_used: [],
    suggested_grade: 10,
    note: "",
    graded_by: null,
    graded_at: null,
    comments: [],
    teacher_inputs: [],
    growth: [],
    check_runs: [],
    lms_grade: lms,
  };
}

const render = (lms: LmsGrade | null, grade: number | null = 8): string =>
  renderToString(<GradeForm submission={submission(lms, grade)} onSaved={() => Promise.resolve()} />).replaceAll("<!-- -->", "");

describe("GradeForm LMS line", () => {
  it("is not shown for a student who did not come through LTI", () => {
    expect(render(null)).not.toContain("grade-lms");
  });

  it("shows that the grade was passed", () => {
    const html = render({ status: "sent", error: null, sent_at: 5 });
    expect(html).toContain('data-testid="grade-lms"');
    expect(html).toContain("LMS: оцінку передано");
  });

  it("shows the reason when the transfer failed", () => {
    const html = render({ status: "failed", error: "Платформа не відповіла за 10 с", sent_at: null });
    expect(html).toContain("LMS: не передано - Платформа не відповіла за 10 с");
    expect(html).toContain('data-status="failed"');
  });

  it("shows that the grade is being sent", () => {
    expect(render({ status: "pending", error: null, sent_at: null })).toContain("LMS: оцінка передається…");
  });

  it("is not shown before the first grade, when the link is only waiting", () => {
    expect(render({ status: "pending", error: null, sent_at: null }, null)).not.toContain("grade-lms");
  });
});
