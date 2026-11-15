import { Link, Navigate, Outlet, useLocation, useParams } from "react-router";
import { PlayerPage } from "@/pages/play/PlayerPage";
import { Button } from "@/components/ui/button";
import { describeError, loginAddress } from "@/lib/api";
import { useMe } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";
import { Shell } from "./Shell";

/** Everything behind the login: waits for "who am I", sends visitors to /login?next=. */
export function SignedInLayout() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (me.error) {
    return (
      <EmptyState
        className="min-h-screen justify-center"
        title={describeError(me.error)}
        action={<Button onClick={() => void me.refetch()}>Спробувати знову</Button>}
      />
    );
  }
  if (!me.data) {
    return <Navigate to={loginAddress(`${location.pathname}${location.search}`)} replace />;
  }
  return <Shell me={me.data} />;
}

/** Pages that only a teacher (owner or assistant) can use. */
export function TeacherOnly() {
  const me = useMe();
  if (me.data?.role !== "teacher") {
    return (
      <EmptyState
        title="Ця сторінка доступна лише викладачам"
        hint="Поверніться до списку своїх завдань."
        action={
          <Button asChild variant="outline">
            <Link to="/">Мої завдання</Link>
          </Button>
        }
      />
    );
  }
  return <Outlet />;
}

/**
 * `/play/:source`: a published player (`embed-<token>`) is open to everyone and has no shell; every other recording is
 * behind the login and shown inside the shell (the child route).
 */
export function PlayEntry() {
  const { source = "" } = useParams();
  return source.startsWith("embed-") ? <PlayerPage /> : <SignedInLayout />;
}
