import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { ApiFailure, describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import { ItemScreen } from "./ItemScreen";

function BackToLibrary() {
  return (
    <Button asChild variant="outline">
      <Link to="/library">До бібліотеки</Link>
    </Button>
  );
}

/** "/library/:id": one task, lesson or clip. */
export function ItemPage() {
  const id = Number(useParams()["id"]);
  const item = useQuery({ ...apiQuery("GET /api/library/:id", { params: { id } }), enabled: Number.isInteger(id) });
  if (!Number.isInteger(id)) return <EmptyState title="Предмет не знайдено" hint="Адреса неправильна." action={<BackToLibrary />} />;
  if (item.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (item.error) {
    const missing = item.error instanceof ApiFailure && item.error.status === 404;
    return missing ? (
      <EmptyState title="Предмет не знайдено" hint="Його видалено або він належить іншому викладачу." action={<BackToLibrary />} />
    ) : (
      <EmptyState title={describeError(item.error)} action={<Button onClick={() => void item.refetch()}>Спробувати знову</Button>} />
    );
  }
  return <ItemScreen key={item.data.id} item={item.data} />;
}
