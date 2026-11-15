import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { apiQuery } from "@/lib/query";
import { CreateItemDialog } from "./CreateItemDialog";
import { assignedClasses, filterItems, KIND_FILTERS, KIND_LABEL, type KindFilter } from "./library-list";

/** "/library": the teacher's tasks, lessons and clips. */
export function LibraryPage() {
  const library = useQuery(apiQuery("GET /api/library"));
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  let body;
  if (library.error) {
    body = (
      <EmptyState
        title={describeError(library.error)}
        action={<Button variant="outline" onClick={() => void library.refetch()}>Спробувати знову</Button>}
      />
    );
  } else if (!library.data) {
    body = <p className="text-sm text-muted-foreground">Завантаження…</p>;
  } else if (library.data.length === 0) {
    body = (
      <div className="rounded-lg border bg-card">
        <EmptyState
          title="Бібліотека порожня"
          hint="Створіть перше завдання, а уроки й кліпи з'являться тут зі здач студентів."
          action={<Button onClick={() => setCreating(true)}>Створити завдання</Button>}
        />
      </div>
    );
  } else {
    const shown = filterItems(library.data, kind, query);
    body =
      shown.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState title="Нічого не знайдено" hint="Змініть вид або пошуковий запит." />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table data-testid="library-table">
            <TableHeader>
              <TableRow>
                <TableHead>Вид</TableHead>
                <TableHead>Назва</TableHead>
                <TableHead>Машини</TableHead>
                <TableHead>Видано</TableHead>
                <TableHead className="text-right">Змінено</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((item) => (
                <TableRow key={item.id} data-testid="library-row" data-kind={item.kind}>
                  <TableCell>
                    <Badge variant="secondary">{KIND_LABEL[item.kind]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link to={`/library/${item.id}`} data-testid="library-open" className="font-medium text-primary hover:underline">
                      {item.title}
                    </Link>
                  </TableCell>
                  <TableCell>{item.machines}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{assignedClasses(item).join(", ") || "-"}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatWhen(item.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6" data-testid="library-page">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-[26px] leading-tight font-bold">Бібліотека</h1>
        <Button className="ml-auto" onClick={() => setCreating(true)} data-testid="create-item">
          <Plus /> Створити завдання
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={kind} onValueChange={(value) => setKind(value as KindFilter)}>
          <TabsList variant="line" data-testid="kind-filter" className="h-auto justify-start">
            {KIND_FILTERS.map((filter) => (
              <TabsTrigger key={filter.value} value={filter.value} data-testid="kind-tab" data-kind={filter.value} className="flex-none px-3">
                {filter.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input
          className="ml-auto w-64"
          placeholder="Пошук за назвою"
          aria-label="Пошук за назвою"
          data-testid="library-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {body}
      <CreateItemDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
