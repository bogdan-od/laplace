import { useState, type SubmitEvent } from "react";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { api, ApiFailure, describeError } from "@/lib/api";
import { resetSession } from "@/lib/query";
import {
  checkLogin,
  checkNewPassword,
  checkPersonName,
  hasErrors,
  LOGIN_HINT,
  normalizeLogin,
  splitFieldMessage,
  type FieldErrors,
} from "@/lib/validate";
import { MAX_NAME_CHARS, MIN_PASSWORD_CHARS } from "@shared/limits";
import type { Me } from "@shared/api";

type RegisterField = "name" | "login" | "password";

/** Registration of a teacher (no code) or of a student (with the invite code from the link). */
export function RegisterForm({
  inviteCode,
  submitLabel,
  onDone,
  onBadInvite,
}: {
  inviteCode?: string;
  submitLabel: string;
  onDone: (me: Me) => void;
  onBadInvite?: () => void;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<RegisterField>>({});
  const [pending, setPending] = useState(false);

  const edit = (field: RegisterField, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors((old) => ({ ...old, [field]: undefined, form: undefined }));
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors<RegisterField> = {
      name: checkPersonName(name),
      login: checkLogin(login),
      password: checkNewPassword(password),
    };
    setErrors(found);
    if (hasErrors(found)) return;

    setPending(true);
    try {
      const user = await api("POST /api/auth/register", {
        body: {
          name: name.trim(),
          login: normalizeLogin(login),
          password,
          role: inviteCode === undefined ? "teacher" : "student",
          ...(inviteCode === undefined ? {} : { invite_code: inviteCode }),
        },
        redirectOn401: false,
      });
      resetSession(user);
      onDone(user);
    } catch (error) {
      setErrors(serverErrors(error));
      if (error instanceof ApiFailure && error.code === "bad_invite") onBadInvite?.();
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <Field
        label="Ім'я та прізвище"
        value={name}
        maxLength={MAX_NAME_CHARS}
        autoComplete="name"
        autoFocus
        error={errors.name}
        onChange={(event) => edit("name", setName)(event.target.value)}
      />
      <Field
        label="Логін"
        value={login}
        autoComplete="username"
        error={errors.login}
        hint={LOGIN_HINT}
        onChange={(event) => edit("login", setLogin)(event.target.value)}
      />
      <Field
        label="Пароль"
        type="password"
        value={password}
        autoComplete="new-password"
        error={errors.password}
        hint={`Щонайменше ${MIN_PASSWORD_CHARS} символів`}
        onChange={(event) => edit("password", setPassword)(event.target.value)}
      />
      {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
      <PendingButton type="submit" pending={pending} className="mt-1">
        {submitLabel}
      </PendingButton>
    </form>
  );
}

const FIELD_LABEL: Record<RegisterField, string> = { name: "Ім'я", login: "Логін", password: "Пароль" };

function isRegisterField(field: string): field is RegisterField {
  return field === "name" || field === "login" || field === "password";
}

function serverErrors(error: unknown): FieldErrors<RegisterField> {
  if (error instanceof ApiFailure) {
    if (error.code === "login_taken") return { login: "Цей логін уже зайнято" };
    if (error.code === "bad_invite") return { form: "Запрошення не знайдено" };
    const field = splitFieldMessage(error.message);
    if (field && isRegisterField(field.field)) return { [field.field]: `${FIELD_LABEL[field.field]} ${field.text}` };
  }
  return { form: describeError(error) };
}
