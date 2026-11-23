import { useState, type SubmitEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { api, ApiFailure, describeError } from "@/lib/api";
import { ME_KEY } from "@/lib/query";
import { useMe } from "@/lib/session";
import {
  checkNewPassword,
  checkPersonName,
  hasErrors,
  splitFieldMessage,
  type FieldErrors,
} from "@/lib/validate";
import { MAX_NAME_CHARS } from "@shared/limits";
import { LtiSettings } from "./lti/LtiSettings";
import type { Me } from "@shared/api";

const ROLE_LABEL: Record<Me["role"], string> = { teacher: "Викладач", student: "Студент" };

export function SettingsPage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 px-4 sm:px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[26px] leading-tight font-bold">Налаштування</h1>
        <p className="text-sm text-muted-foreground">
          Логін <span className="font-mono text-foreground">{me.data.login}</span>
          <span className="ml-2">{ROLE_LABEL[me.data.role]}</span>
        </p>
      </header>
      <NameCard me={me.data} />
      <PasswordCard />
      {me.data.role === "teacher" && (
        <Card title="LMS (LTI 1.3)">
          <LtiSettings />
        </Card>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function NameCard({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.name);
  const [errors, setErrors] = useState<FieldErrors<"name">>({});
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors<"name"> = { name: checkPersonName(name) };
    setErrors(found);
    if (hasErrors(found)) return;
    setPending(true);
    try {
      const updated = await api("PATCH /api/me", { body: { name: name.trim() } });
      queryClient.setQueryData(ME_KEY, updated);
      setName(updated.name);
      toast.success("Ім'я збережено");
    } catch (error) {
      setErrors({ form: describeError(error) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title="Ім'я">
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
        <Field
          label="Ім'я та прізвище"
          value={name}
          maxLength={MAX_NAME_CHARS}
          error={errors.name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors({});
          }}
        />
        {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
        <PendingButton type="submit" pending={pending} disabled={name.trim() === me.name} className="self-start">
          Зберегти
        </PendingButton>
      </form>
    </Card>
  );
}

type PasswordField = "old" | "next" | "repeat";

function PasswordCard() {
  const [old, setOld] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<FieldErrors<PasswordField>>({});
  const [pending, setPending] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors<PasswordField> = {
      old: old === "" ? "Введіть поточний пароль" : undefined,
      next: checkNewPassword(next),
      repeat: repeat !== next ? "Паролі не збігаються" : undefined,
    };
    setErrors(found);
    if (hasErrors(found)) return;
    setPending(true);
    try {
      await api("PATCH /api/me", { body: { password: { old, new: next } } });
      setOld("");
      setNext("");
      setRepeat("");
      toast.success("Пароль змінено");
    } catch (error) {
      setErrors(passwordErrors(error));
    } finally {
      setPending(false);
    }
  };

  const edit = (field: PasswordField, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors((previous) => ({ ...previous, [field]: undefined, form: undefined }));
  };

  return (
    <Card title="Пароль">
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
        <Field
          label="Поточний пароль"
          type="password"
          value={old}
          autoComplete="current-password"
          error={errors.old}
          onChange={(event) => edit("old", setOld)(event.target.value)}
        />
        <Field
          label="Новий пароль"
          type="password"
          value={next}
          autoComplete="new-password"
          error={errors.next}
          onChange={(event) => edit("next", setNext)(event.target.value)}
        />
        <Field
          label="Повторіть новий пароль"
          type="password"
          value={repeat}
          autoComplete="new-password"
          error={errors.repeat}
          onChange={(event) => edit("repeat", setRepeat)(event.target.value)}
        />
        {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
        <PendingButton type="submit" pending={pending} className="self-start">
          Змінити пароль
        </PendingButton>
      </form>
    </Card>
  );
}

/** A 400 without a field name is the wrong current password; other cases are form-level. */
function passwordErrors(error: unknown): FieldErrors<PasswordField> {
  if (error instanceof ApiFailure && error.status === 400) {
    const field = splitFieldMessage(error.message);
    if (field === null) return { old: error.message };
    return { next: error.message };
  }
  return { form: describeError(error) };
}
