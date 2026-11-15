import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { refreshClassData } from "./class-refresh";

export function AssistantDialog({ classId, open, onOpenChange }: { classId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="assistant-dialog">
        <DialogTitle>Додати асистента</DialogTitle>
        <DialogDescription>
          Асистентом може стати будь-який зареєстрований користувач, крім власника класу. Він бачитиме клас і оцінюватиме роботи.
        </DialogDescription>
        <AssistantForm classId={classId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AssistantForm({ classId, onDone }: { classId: number; onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = login.trim();
    if (value === "") {
      setError("Введіть логін користувача.");
      return;
    }
    setPending(true);
    try {
      await api("POST /api/classes/:id/assistants", { params: { id: classId }, body: { login: value } });
      await refreshClassData();
      toast.success(`Асистента додано: ${value}`);
      onDone();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <Field
        label="Логін"
        value={login}
        onChange={(event) => {
          setLogin(event.target.value);
          setError(null);
        }}
        error={error ?? undefined}
        autoComplete="off"
        data-testid="assistant-login"
      />
      <PendingButton type="submit" pending={pending} className="self-end" data-testid="assistant-submit">
        Додати
      </PendingButton>
    </form>
  );
}
