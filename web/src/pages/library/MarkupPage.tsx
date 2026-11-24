import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useParams } from "react-router";
import { toast } from "sonner";
import { event_times, read_journal, type Journal, type LessonMark } from "@core/core/journal.mjs";
import type { LibraryItem } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { apiQuery, invalidateRoute, queryClient } from "@/lib/query";
import type { PlaySource } from "@/machine/play-source";
import { PlayerScreen } from "@/pages/play/PlayerPage";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  addNote,
  addSelf,
  lessonJournal,
  lessonNodeWithJournal,
  markSpans,
  removeMark,
  sameMarks,
  SELF_STILL_OPEN,
  startProblem,
} from "./lesson-markup";
import { MarkupPanel } from "./MarkupPanel";

function NoLesson({ title, hint, itemId }: { title: string; hint: string; itemId: number | null }) {
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

/**
 * "/library/:id/markup": the start journal of a lesson in the player with a panel for the explanations and the
 * segments.
 */
export function MarkupPage() {
  const id = Number(useParams()["id"]);
  const valid = Number.isInteger(id) && id > 0;
  const item = useQuery({ ...apiQuery("GET /api/library/:id", { params: { id } }), enabled: valid });
  const node = item.data !== undefined && item.data.kind === "lesson" ? lessonNodeWithJournal(item.data) : null;
  // The journal may have been replaced a moment ago on the page of the item: nothing is kept after the page is left, and
  // the copy being marked is never reloaded under the teacher's hands.
  const raw = useQuery({
    ...apiQuery("GET /api/library/:id/journals/:node", { params: { id, node: node ?? "" }, query: { role: "start" } }),
    enabled: node !== null,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (!valid) return <NoLesson title="Предмет не знайдено" hint="Адреса неправильна." itemId={null} />;
  if (item.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (item.error) return <NoLesson title={describeError(item.error)} hint="Не вдалося відкрити предмет." itemId={null} />;
  if (item.data.kind !== "lesson") return <NoLesson title="Розмітка є лише в уроків" hint="Цей предмет не урок." itemId={id} />;
  if (node === null) return <NoLesson title="Спершу додайте журнал" hint="Урок розмічають по журналу його єдиної машини." itemId={id} />;
  if (raw.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (raw.error) return <NoLesson title={describeError(raw.error)} hint="Не вдалося відкрити журнал." itemId={id} />;
  return <MarkupEditor key={id} item={item.data} node={node} raw={raw.data} />;
}

function MarkupEditor({ item, node, raw }: { item: LibraryItem; node: string; raw: unknown }) {
  const journal = useMemo<Journal | Error>(() => {
    try {
      return read_journal(raw);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [raw]);
  if (journal instanceof Error) return <NoLesson title="Журнал не відкрито" hint={journal.message} itemId={item.id} />;
  return <Marking item={item} node={node} journal={journal} />;
}

function Marking({ item, node, journal }: { item: LibraryItem; node: string; journal: Journal }) {
  const [saved, setSaved] = useState<readonly LessonMark[]>(() => journal.header.lesson ?? []);
  const [items, setItems] = useState<readonly LessonMark[]>(saved);
  const [openFrom, setOpenFrom] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const times = useMemo(() => event_times(journal), [journal]);
  const spans = useMemo(() => markSpans(items, times), [items, times]);
  const source = useMemo<PlaySource>(() => ({ kind: "item", id: item.id, node, role: "start" }), [item.id, node]);
  const total = journal.events.length;
  const dirty = !sameMarks(items, saved);
  // A change of `?t=` is not a departure: only another page asks.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const accept = (result: ReturnType<typeof addNote>): boolean => {
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError("");
    setText("");
    setItems(result.items);
    return true;
  };

  const save = async () => {
    if (openFrom !== null) {
      setError(SELF_STILL_OPEN);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = lessonJournal(journal, items);
      read_journal(body);
      const updated = await api("PUT /api/library/:id/journals/:node", { params: { id: item.id, node }, query: { role: "start" }, body });
      queryClient.setQueryData(apiQuery("GET /api/library/:id", { params: { id: item.id } }).queryKey, updated);
      void invalidateRoute("GET /api/library");
      setSaved(items);
      toast.success("Урок збережено");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PlayerScreen
        text={`item-${item.id}-${node}-start`}
        source={source}
        spans={spans}
        side={({ session, view, beside }) => (
          <MarkupPanel
            items={items}
            times={times}
            text={text}
            openFrom={openFrom}
            error={error}
            ready={view.phase === "ready" && !view.seeking}
            dirty={dirty}
            saving={saving}
            beside={beside}
            actions={{
              onText: setText,
              onNote: () => accept(addNote(items, view.eventCount, text, total)),
              onStart: () => {
                const problem = startProblem(items, view.eventCount);
                setError(problem ?? "");
                if (problem === null) setOpenFrom(view.eventCount);
              },
              onEnd: () => {
                if (accept(addSelf(items, openFrom, view.eventCount, text, total))) setOpenFrom(null);
              },
              onRemove: (mark) => setItems(removeMark(items, mark)),
              onGo: (ms) => void session?.seek(ms, { resume: false }),
              onSave: () => void save(),
            }}
          />
        )}
      />
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Є незбережені зміни"
        text="Якщо піти зараз, розмітку, яку ви не зберегли, буде втрачено."
        confirm="Піти без збереження"
        cancel="Залишитися"
        onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
        onCancel={() => blocker.state === "blocked" && blocker.reset()}
        testId="markup-leave-dialog"
      />
    </>
  );
}
