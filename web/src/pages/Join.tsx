import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/PendingButton";
import { api, ApiFailure, describeError, NetworkFailure } from "@/lib/api";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { useLogout, useMe } from "@/lib/session";
import { AuthLayout } from "./AuthLayout";
import { RegisterForm } from "./RegisterForm";

export function JoinPage() {
  const { code = "" } = useParams();
  const invite = useQuery(apiQuery("GET /api/invites/:code", { params: { code } }));
  const me = useMe();

  if (invite.isPending) return <AuthLayout title="Запрошення">Завантаження…</AuthLayout>;

  if (invite.error instanceof NetworkFailure || (invite.error instanceof ApiFailure && invite.error.status >= 500)) {
    return (
      <AuthLayout title="Запрошення">
        <p className="text-sm text-destructive">{describeError(invite.error)}</p>
        <Button variant="outline" onClick={() => void invite.refetch()}>
          Спробувати знову
        </Button>
      </AuthLayout>
    );
  }

  if (invite.error || !invite.data) {
    return (
      <AuthLayout title="Запрошення не знайдено">
        <p className="text-sm text-muted-foreground">Перевірте посилання або попросіть викладача надіслати нове.</p>
        <Link to={me.data ? "/" : "/login"} className="text-sm text-primary hover:underline">
          {me.data ? "На головну" : "Перейти до входу"}
        </Link>
      </AuthLayout>
    );
  }

  const info = invite.data;
  return (
    <AuthLayout title={`Клас ${info.class_name}`}>
      <p className="-mt-2 flex flex-col text-sm text-muted-foreground">
        {info.subject && <span>{info.subject}</span>}
        <span>Викладач: {info.teacher_name}</span>
      </p>
      {me.isPending ? null : me.data === null || me.data === undefined ? (
        <GuestJoin code={code} />
      ) : me.data.role === "student" ? (
        <StudentJoin code={code} />
      ) : (
        <TeacherNotice code={code} />
      )}
    </AuthLayout>
  );
}

function GuestJoin({ code }: { code: string }) {
  const navigate = useNavigate();
  const [badInvite, setBadInvite] = useState(false);
  if (badInvite) {
    return <p className="text-sm text-destructive">Запрошення не знайдено або більше не діє.</p>;
  }
  return (
    <>
      <RegisterForm
        inviteCode={code}
        submitLabel="Зареєструватися та приєднатися"
        onDone={() => void navigate("/", { replace: true })}
        onBadInvite={() => setBadInvite(true)}
      />
      <p className="text-sm text-muted-foreground">
        Вже є акаунт?{" "}
        <Link to={`/login?next=${encodeURIComponent(`/join/${code}`)}`} className="text-primary hover:underline">
          Увійти
        </Link>
      </p>
    </>
  );
}

function StudentJoin({ code }: { code: string }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const accept = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api("POST /api/invites/:code/accept", { params: { code } });
      await invalidateRoute("GET /api/classes");
      await navigate("/", { replace: true });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PendingButton pending={pending} onClick={() => void accept()}>
        Приєднатися
      </PendingButton>
      {error && <p className="text-[13px] text-destructive">{error}</p>}
    </>
  );
}

function TeacherNotice({ code }: { code: string }) {
  const { logout, pending } = useLogout(`/login?next=${encodeURIComponent(`/join/${code}`)}`);
  return (
    <>
      <p className="text-sm">
        Ви увійшли як викладач. Приєднатися до класу за запрошенням може лише студент.
      </p>
      <PendingButton variant="outline" pending={pending} onClick={() => void logout()}>
        Вийти й увійти як студент
      </PendingButton>
    </>
  );
}
