import { Link, Navigate, useNavigate } from "react-router";
import { useMe } from "@/lib/session";
import { AuthLayout } from "./AuthLayout";
import { RegisterForm } from "./RegisterForm";

export function RegisterPage() {
  const me = useMe();
  const navigate = useNavigate();
  if (me.data) return <Navigate to="/" replace />;
  return (
    <AuthLayout title="Реєстрація викладача">
      <RegisterForm submitLabel="Зареєструватися" onDone={() => void navigate("/", { replace: true })} />
      <p className="text-sm text-muted-foreground">
        Вже є акаунт?{" "}
        <Link to="/login" className="text-primary hover:underline">
          Увійти
        </Link>
      </p>
    </AuthLayout>
  );
}
