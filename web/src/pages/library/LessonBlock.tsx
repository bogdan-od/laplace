import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { read_journal, type LessonMark } from "@core/core/journal.mjs";
import type { LibraryItem } from "@shared/api";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { queryKey } from "@/lib/query";
import { lessonCounts, lessonNodeWithJournal } from "./lesson-markup";

/** The marks of the start journal; asked again whenever the item changes (a journal was loaded, recorded or deleted). */
function useLessonMarks(item: LibraryItem, node: string | null): readonly LessonMark[] | undefined {
  const params = { id: item.id, node: node ?? "" };
  const query = { role: "start" } as const;
  const journal = useQuery({
    queryKey: [...queryKey("GET /api/library/:id/journals/:node", { params, query }), item.updated_at],
    queryFn: async () => read_journal(await api("GET /api/library/:id/journals/:node", { params, query })),
    enabled: node !== null,
  });
  return journal.data?.header.lesson;
}

/** The block "Урок" on the page of a lesson: what the markup holds and the two ways in. */
export function LessonBlock({ item }: { item: LibraryItem }) {
  const node = lessonNodeWithJournal(item);
  const marks = useLessonMarks(item, node);
  const counts = lessonCounts(marks);
  return (
    <div className="flex flex-col gap-3" data-testid="lesson-block">
      {node === null ? (
        <p className="text-sm text-muted-foreground" data-testid="lesson-no-journal">
          Спершу додайте журнал
        </p>
      ) : (
        <p className="text-sm" data-testid="lesson-counts">
          Пояснень: <span data-testid="lesson-notes">{marks === undefined ? "…" : counts.notes}</span>
          {", "}відрізків "Тепер сам": <span data-testid="lesson-selfs">{marks === undefined ? "…" : counts.selfs}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {node === null ? (
          <>
            <Button variant="outline" disabled data-testid="lesson-markup">
              Розмітити урок
            </Button>
            <Button variant="outline" disabled data-testid="lesson-preview">
              Переглянути як студент
            </Button>
          </>
        ) : (
          <>
            <Button asChild>
              <Link to={`/library/${item.id}/markup`} data-testid="lesson-markup">
                Розмітити урок
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/library/${item.id}/preview`} data-testid="lesson-preview">
                Переглянути як студент
              </Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
