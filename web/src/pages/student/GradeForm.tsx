import { useState } from "react";
import { toast } from "sonner";
import type { Submission } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, describeError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { lmsLine } from "./lms-line";
import { parseGrade } from "./submission-view";

export interface GradeFormProps {
  submission: Submission;
  /** Called after the grade is saved: the page reloads the attempt, the lists and this submission. */
  onSaved: () => Promise<void>;
}

/** The final grade and the note to the student, with the grade the server suggests from the opened hints. */
export function GradeForm({ submission, onSaved }: GradeFormProps) {
  const max = submission.assignment.max_grade;
  const [grade, setGrade] = useState(submission.grade === null ? "" : String(submission.grade));
  const [note, setNote] = useState(submission.note);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const graded = submission.grade !== null;
  // "pending" of a submission without a grade only means that the link exists.
  const lms = graded ? lmsLine(submission.lms_grade) : null;

  const save = async () => {
    const parsed = parseGrade(grade, max);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api("PUT /api/submissions/:id/grade", { params: { id: submission.id }, body: { grade: parsed.grade, note } });
      await onSaved();
      toast.success("Оцінку збережено");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="grade-section" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Оцінка</h3>
      <div className="flex max-w-xl flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="sr-only">Оцінка</span>
            <Input
              data-testid="grade-input"
              inputMode="numeric"
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              aria-invalid={error !== null}
              className="w-14 text-center tabular-nums"
            />
            <span className="text-muted-foreground">з {max}</span>
          </label>
          <span className="ml-2 flex items-center gap-2 text-[13px] text-muted-foreground">
            <span data-testid="grade-suggested">Запропоновано: {submission.suggested_grade}</span>
            <Button size="xs" variant="outline" data-testid="grade-accept" onClick={() => setGrade(String(submission.suggested_grade))}>
              Прийняти
            </Button>
          </span>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-muted-foreground">Примітка для студента, необов'язково</span>
          <textarea
            data-testid="grade-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            className="resize-y rounded-md border border-input bg-card px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring"
          />
        </label>
        {error !== null && (
          <p role="alert" data-testid="grade-error" className="text-sm text-status-stuck">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button variant={graded ? "outline" : "default"} data-testid="grade-save" disabled={saving} onClick={() => void save()}>
            {graded ? "Оновити оцінку" : "Зберегти"}
          </Button>
          {submission.graded_by !== null && (
            <span className="text-[13px] text-muted-foreground">Оцінка від: {submission.graded_by.name}</span>
          )}
        </div>
        {lms !== null && (
          <p
            data-testid="grade-lms"
            data-status={submission.lms_grade?.status}
            className={cn("text-[13px]", submission.lms_grade?.status === "failed" ? "text-status-stuck" : "text-muted-foreground")}
          >
            {lms}
          </p>
        )}
      </div>
    </section>
  );
}
