import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";

export function NotFoundPage() {
  return (
    <EmptyState
      className="min-h-[60vh] justify-center"
      title="Сторінку не знайдено"
      hint="Адреса неправильна або сторінку вилучено."
      action={
        <Link to="/" className="text-primary hover:underline">
          На головну
        </Link>
      }
    />
  );
}
