import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, ApiFailure, describeError } from "@/lib/api";
import { invalidateRoute } from "@/lib/query";
import { checkTitle, hasErrors, splitFieldMessage, type FieldErrors } from "@/lib/validate";
import { MAX_TITLE_CHARS } from "@shared/limits";

export function CreateClassDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Новий клас</DialogTitle>
        <DialogDescription>Після створення з'явиться код запрошення для студентів.</DialogDescription>
        <CreateClassForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type ClassField = "name" | "subject";

function CreateClassForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [errors, setErrors] = useState<FieldErrors<ClassField>>({});
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors<ClassField> = {
      name: checkTitle(name, "назву класу"),
      subject: subject.trim().length > MAX_TITLE_CHARS ? `Не більше ${MAX_TITLE_CHARS} символів` : undefined,
    };
    setErrors(found);
    if (hasErrors(found)) return;
    setPending(true);
    try {
      const created = await api("POST /api/classes", { body: { name: name.trim(), subject: subject.trim() } });
      await invalidateRoute("GET /api/classes");
      toast.success(`Клас ${created.name} створено`);
      onDone();
      await navigate(`/classes/${created.id}`);
    } catch (error) {
      const field = error instanceof ApiFailure ? splitFieldMessage(error.message) : null;
      if (field?.field === "name" || field?.field === "subject") setErrors({ [field.field]: field.text });
      else setErrors({ form: describeError(error) });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <Field
        label="Назва"
        value={name}
        maxLength={MAX_TITLE_CHARS}
        autoFocus
        error={errors.name}
        onChange={(event) => {
          setName(event.target.value);
          setErrors({});
        }}
      />
      <Field
        label="Предмет"
        value={subject}
        maxLength={MAX_TITLE_CHARS}
        error={errors.subject}
        onChange={(event) => {
          setSubject(event.target.value);
          setErrors({});
        }}
      />
      {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
      <PendingButton type="submit" pending={pending} className="self-end">
        Створити
      </PendingButton>
    </form>
  );
}
