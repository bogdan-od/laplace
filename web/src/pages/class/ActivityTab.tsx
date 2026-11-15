import { useInfiniteQuery } from "@tanstack/react-query";
import type { Activity, ClassDetail } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { queryKey } from "@/lib/query";
import { describeActivity } from "./activity-text";

/** The server answers with at most this many rows; a shorter page is the last one. */
const PAGE_SIZE = 50;

const FIRST_PAGE = 0;

function nextPage(page: readonly Activity[]): number | undefined {
  return page.length < PAGE_SIZE ? undefined : page.at(-1)?.id;
}

export function ActivityTab({ klass, now }: { klass: ClassDetail; now: number }) {
  const classId = klass.id;
  const log = useInfiniteQuery({
    queryKey: queryKey("GET /api/classes/:id/activity", { params: { id: classId } }),
    queryFn: ({ pageParam }) =>
      api("GET /api/classes/:id/activity", { params: { id: classId }, ...(pageParam === FIRST_PAGE ? {} : { query: { before: pageParam } }) }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: nextPage,
  });

  if (log.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (log.error) {
    return <EmptyState title={describeError(log.error)} action={<Button onClick={() => void log.refetch()}>Спробувати знову</Button>} />;
  }
  const rows = log.data.pages.flat();
  if (rows.length === 0) {
    return <EmptyState title="Журнал поки порожній" hint="Тут з'являться вступи студентів, відкриті завдання, здачі й оцінки." />;
  }
  const titleOf = (id: number) => klass.assignments.find((assignment) => assignment.id === id)?.title;

  return (
    <div className="flex flex-col gap-4 px-6 py-5" data-testid="activity-tab">
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-44">Час</TableHead>
              <TableHead className="w-56">Хто</TableHead>
              <TableHead>Що</TableHead>
              <TableHead className="w-56">Студент</TableHead>
              <TableHead className="w-72">Завдання</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((activity) => {
              const line = describeActivity(activity, titleOf);
              return (
                <TableRow key={activity.id} data-testid="activity-row" data-kind={activity.kind}>
                  <TableCell className="text-muted-foreground tabular-nums">{formatWhen(activity.at, now)}</TableCell>
                  <TableCell className="font-medium">{activity.actor.name}</TableCell>
                  <TableCell>
                    {line.action}
                    {line.note && <span className="text-muted-foreground"> · {line.note}</span>}
                  </TableCell>
                  <TableCell>{line.student ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="max-w-0 truncate">{line.assignment ?? <span className="text-muted-foreground">-</span>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {log.hasNextPage && (
        <PendingButton variant="outline" pending={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} className="self-center" data-testid="activity-more">
          Показати ще
        </PendingButton>
      )}
    </div>
  );
}
