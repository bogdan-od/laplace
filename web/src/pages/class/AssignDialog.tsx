import { useState, type SubmitEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Assignment, LibraryItemSummary } from "@shared/api";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { apiQuery, invalidateRoute } from "@/lib/query";

/** The server's limit of `AssignBody.max_grade` (server/src/assignments/dto.ts: MAX_GRADE_LIMIT). */
const MAX_GRADE = 100;
const DEFAULT_GRADE = 10;
const KIND_TEXT = { task: "завдання", lesson: "урок" } as const;
const ASSIGNABLE = new Set(["task", "lesson"]);

/** "2037-11-14T23:59" from a datetime-local input, as milliseconds in the browser's time zone. */
function parseDue(text: string): number | null {
  if (text === "") return null;
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function optionText(item: LibraryItemSummary, classId: number): string {
  const given = item.assigned.some((entry) => entry.class_id === classId) ? ", вже видано цьому класу" : "";
  return `${item.title} (${KIND_TEXT[item.kind as keyof typeof KIND_TEXT]})${given}`;
}

export function AssignDialog({
  classId,
  open,
  onOpenChange,
  onAssigned,
}: {
  classId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned: (assignment: Assignment) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="assign-dialog">
        <DialogTitle>Видати завдання</DialogTitle>
        <DialogDescription>Предмет із бібліотеки буде видано всьому класу.</DialogDescription>
        <AssignForm classId={classId} onAssigned={onAssigned} />
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({ classId, onAssigned }: { classId: number; onAssigned: (assignment: Assignment) => void }) {
  const library = useQuery(apiQuery("GET /api/library"));
  const items = (library.data ?? []).filter((item) => ASSIGNABLE.has(item.kind));
  const [itemId, setItemId] = useState<number | null>(null);
  const [due, setDue] = useState("");
  const [maxGrade, setMaxGrade] = useState(String(DEFAULT_GRADE));
  const [sharedLan, setSharedLan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const item = items.find((entry) => entry.id === itemId) ?? items[0];
  const grade = Number(maxGrade);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item) return;
    if (!Number.isInteger(grade) || grade < 1 || grade > MAX_GRADE) {
      setError(`Максимум балів - ціле число від 1 до ${MAX_GRADE}`);
      return;
    }
    setPending(true);
    try {
      const assignment = await api("POST /api/library/:id/assign", {
        params: { id: item.id },
        body: { class_id: classId, due_at: parseDue(due), max_grade: grade, shared_lan: item.machines === 1 && sharedLan },
      });
      await Promise.all([invalidateRoute("GET /api/classes/:id"), invalidateRoute("GET /api/library")]);
      toast.success(`Видано: ${assignment.title}`);
      onAssigned(assignment);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  if (library.isPending) return <p className="text-sm text-muted-foreground">Завантаження…</p>;
  if (library.error) return <p className="text-sm text-destructive">{describeError(library.error)}</p>;
  if (!item) {
    return <p className="text-sm text-muted-foreground">У бібліотеці ще немає завдань чи уроків. Створіть предмет у розділі "Бібліотека".</p>;
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="assign-item" className="text-sm font-medium">
          Предмет
        </label>
        <select
          id="assign-item"
          data-testid="assign-item"
          value={item.id}
          onChange={(event) => {
            setItemId(Number(event.target.value));
            setError(null);
          }}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {items.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {optionText(entry, classId)}
            </option>
          ))}
        </select>
      </div>
      <Field label="Термін" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} hint="Можна не вказувати" />
      <Field
        label="Максимум балів"
        type="number"
        min={1}
        max={MAX_GRADE}
        value={maxGrade}
        onChange={(event) => {
          setMaxGrade(event.target.value);
          setError(null);
        }}
      />
      {item.machines === 1 && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sharedLan} onChange={(event) => setSharedLan(event.target.checked)} />
          Спільна мережа: машини студентів бачать одна одну
        </label>
      )}
      {error && <p className="text-[13px] text-destructive">{error}</p>}
      <PendingButton type="submit" pending={pending} className="self-end" data-testid="assign-submit">
        Видати
      </PendingButton>
    </form>
  );
}
