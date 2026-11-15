import { useState, type SubmitEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Assignment, LibraryItem } from "@shared/api";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { DEFAULT_MAX_GRADE, MAX_GRADE, parseAssignForm, sharedLanAvailable } from "./assign-form";
import { CONTROL_CLASS } from "./controls";

export function AssignItemDialog({
  item,
  open,
  onOpenChange,
  onAssigned,
}: {
  item: LibraryItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned: (assignment: Assignment) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="assign-item-dialog">
        <DialogTitle>Видати класу</DialogTitle>
        <DialogDescription>Завдання буде видано всьому класу; подальші зміни в бібліотеці його не зачеплять.</DialogDescription>
        <AssignItemForm item={item} onAssigned={onAssigned} />
      </DialogContent>
    </Dialog>
  );
}

function AssignItemForm({ item, onAssigned }: { item: LibraryItem; onAssigned: (assignment: Assignment) => void }) {
  const classes = useQuery(apiQuery("GET /api/classes"));
  const mine = (classes.data ?? []).filter((klass) => klass.my_role !== "student");
  const [chosen, setChosen] = useState<number | null>(null);
  const [due, setDue] = useState("");
  const [maxGrade, setMaxGrade] = useState(String(DEFAULT_MAX_GRADE));
  const [sharedLan, setSharedLan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const classId = chosen ?? mine[0]?.id ?? null;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseAssignForm({ classId, due, maxGrade, sharedLan }, item.topology);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setPending(true);
    try {
      const assignment = await api("POST /api/library/:id/assign", { params: { id: item.id }, body: parsed.body });
      await Promise.all([invalidateRoute("GET /api/library"), invalidateRoute("GET /api/classes")]);
      onAssigned(assignment);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  if (classes.isPending) return <p className="text-sm text-muted-foreground">Завантаження…</p>;
  if (classes.error) return <p className="text-sm text-destructive">{describeError(classes.error)}</p>;
  if (mine.length === 0) return <p className="text-sm text-muted-foreground">У вас ще немає класів. Створіть клас у меню ліворуч.</p>;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="assign-class" className="text-sm font-medium">
          Клас
        </label>
        <select
          id="assign-class"
          data-testid="assign-class"
          className={CONTROL_CLASS}
          value={classId ?? ""}
          onChange={(event) => {
            setChosen(Number(event.target.value));
            setError(null);
          }}
        >
          {mine.map((klass) => (
            <option key={klass.id} value={klass.id}>
              {klass.name}
              {klass.subject && ` ${klass.subject}`}
            </option>
          ))}
        </select>
      </div>
      <Field label="Строк" type="datetime-local" value={due} data-testid="assign-due" onChange={(event) => setDue(event.target.value)} hint="Можна не вказувати" />
      <Field
        label="Максимум балів"
        type="number"
        min={1}
        max={MAX_GRADE}
        value={maxGrade}
        data-testid="assign-max-grade"
        onChange={(event) => {
          setMaxGrade(event.target.value);
          setError(null);
        }}
      />
      {sharedLanAvailable(item.topology) && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid="assign-shared-lan" checked={sharedLan} onChange={(event) => setSharedLan(event.target.checked)} />
          Спільна мережа: машини студентів бачать одна одну
        </label>
      )}
      {error && (
        <p className="text-[13px] text-destructive" data-testid="assign-error">
          {error}
        </p>
      )}
      <PendingButton type="submit" pending={pending} className="self-end" data-testid="assign-item-submit">
        Видати
      </PendingButton>
    </form>
  );
}
