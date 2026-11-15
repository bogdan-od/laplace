import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import type { LessonSource } from "@/machine/lesson-session";
import { useLesson } from "@/machine/use-lesson";
import { LessonScreen } from "@/pages/work/LessonWork";
import { lessonNodeWithJournal } from "./lesson-markup";

function Notice({ title, hint, itemId }: { title: string; hint: string; itemId: number | null }) {
  return (
    <EmptyState
      title={title}
      hint={hint}
      action={
        <Button asChild variant="outline">
          <Link to={itemId === null ? "/library" : `/library/${itemId}`}>{itemId === null ? "До бібліотеки" : "До предмета"}</Link>
        </Button>
      }
    />
  );
}

/** "/library/:id/preview": the screen of a lesson as a student sees it, over the journal of the item. Nothing is saved or completed. */
export function LessonPreviewPage() {
  const id = Number(useParams()["id"]);
  const valid = Number.isInteger(id) && id > 0;
  const item = useQuery({ ...apiQuery("GET /api/library/:id", { params: { id } }), enabled: valid });
  if (!valid) return <Notice title="Предмет не знайдено" hint="Адреса неправильна." itemId={null} />;
  if (item.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (item.error) return <Notice title={describeError(item.error)} hint="Не вдалося відкрити предмет." itemId={null} />;
  if (item.data.kind !== "lesson") return <Notice title="Переглянути як студент можна лише урок" hint="Цей предмет не урок." itemId={id} />;
  if (lessonNodeWithJournal(item.data) === null) return <Notice title="Спершу додайте журнал" hint="Без журналу уроку нічого показувати." itemId={id} />;
  return <Preview id={id} title={item.data.title} brief={item.data.brief} />;
}

function Preview({ id, title, brief }: { id: number; title: string; brief: string }) {
  const source = useMemo<LessonSource>(() => ({ kind: "item", id }), [id]);
  const { session, view } = useLesson(source);
  const backTo = `/library/${id}`;
  return (
    <LessonScreen
      session={session}
      view={view}
      brief={brief}
      preview={{ backTo }}
      header={
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Link to={backTo} data-testid="preview-back" className="text-sm text-primary hover:underline">
            ← До предмета
          </Link>
          <h1 className="font-display text-[22px] leading-tight font-bold">{title}</h1>
          <span className="text-sm text-muted-foreground" data-testid="preview-badge">
            Перегляд як студент
          </span>
        </header>
      }
    />
  );
}
