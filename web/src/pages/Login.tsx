import { useState, type SubmitEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { Field } from "@/components/Field";
import { PendingButton } from "@/components/PendingButton";
import { api, ApiFailure, describeError, safeNext } from "@/lib/api";
import { resetSession } from "@/lib/query";
import { isLoggedOutState, useMe } from "@/lib/session";
import { hasErrors, normalizeLogin, type FieldErrors } from "@/lib/validate";
import { AuthLayout } from "./AuthLayout";

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const me = useMe();
  const navigate = useNavigate();
  const leftOnPurpose = isLoggedOutState(useLocation().state);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"login" | "password">>({});
  const [pending, setPending] = useState(false);

  if (me.data && !leftOnPurpose) return <Navigate to={next} replace />;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors<"login" | "password"> = {};
    if (login.trim() === "") found.login = "Введіть логін";
    if (password === "") found.password = "Введіть пароль";
    setErrors(found);
    if (hasErrors(found)) return;

    setPending(true);
    try {
      const user = await api("POST /api/auth/login", {
        body: { login: normalizeLogin(login), password },
        redirectOn401: false,
      });
      resetSession(user);
      await navigate(next, { replace: true });
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) setErrors({ password: error.message });
      else setErrors({ form: describeError(error) });
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout title="Вхід">
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
        <Field
          label="Логін"
          value={login}
          autoComplete="username"
          autoFocus
          error={errors.login}
          onChange={(event) => {
            setLogin(event.target.value);
            setErrors((old) => ({ ...old, login: undefined }));
          }}
        />
        <Field
          label="Пароль"
          type="password"
          value={password}
          autoComplete="current-password"
          error={errors.password}
          onChange={(event) => {
            setPassword(event.target.value);
            setErrors((old) => ({ ...old, password: undefined }));
          }}
        />
        {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
        <PendingButton type="submit" pending={pending} className="mt-1">
          Увійти
        </PendingButton>
      </form>
      <p className="text-sm text-muted-foreground">
        Немає акаунта?{" "}
        <Link to="/register" className="text-primary hover:underline">
          Зареєструватися як викладач
        </Link>
      </p>
    </AuthLayout>
  );
}
