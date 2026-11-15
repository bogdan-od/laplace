import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { invalidateRoute } from "@/lib/query";
import { checkTitle } from "@/lib/validate";
import { MAX_TITLE_CHARS } from "@shared/limits";
import { defaultTopology } from "./library-list";

export function CreateItemDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-item-dialog">
        <DialogTitle>Нове завдання</DialogTitle>
        <DialogDescription>Спочатку з однією машиною; умову, підказки й перевірки ви додасте на сторінці завдання.</DialogDescription>
        <CreateItemForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateItemForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = checkTitle(title, "назву завдання");
    setError(problem);
    if (problem) return;
    setPending(true);
    try {
      const item = await api("POST /api/library", { body: { kind: "task", title: title.trim(), topology: defaultTopology() } });
      await invalidateRoute("GET /api/library");
      onDone();
      await navigate(`/library/${item.id}`);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <Field
        label="Назва"
        value={title}
        maxLength={MAX_TITLE_CHARS}
        autoFocus
        error={error}
        data-testid="create-item-title"
        onChange={(event) => {
          setTitle(event.target.value);
          setError(undefined);
        }}
      />
      <PendingButton type="submit" pending={pending} className="self-end" data-testid="create-item-submit">
        Створити
      </PendingButton>
    </form>
  );
}
