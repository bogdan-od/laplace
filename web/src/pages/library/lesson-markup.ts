// The markup of a lesson: explanations ("note") and "now on your own" segments ("self") over the events of
// the teacher's journal. Pure rules; the final word on a set of marks is `check_lesson`.

import { check_lesson, type Journal, type LessonMark } from "@core/core/journal.mjs";
import type { LibraryItem } from "@shared/api";
import { momentTime } from "@/machine/player-marks";

export type MarkResult = { ok: true; items: LessonMark[] } | { ok: false; error: string };

export const NOTE_TEXT_REQUIRED = "Введіть текст пояснення";
export const SELF_TEXT_REQUIRED = "Введіть текст завдання";
export const SELF_NOT_OPEN = "Спершу натисніть \"Сам: початок\"";
export const SELF_END_BEFORE_START = "Кінець відрізка має бути після початку";
export const SELF_START_INSIDE = "Початок потрапляє всередину наявного відрізка";
export const SELF_STILL_OPEN = "Закрийте відрізок кнопкою \"Сам: кінець\"";

/** The event index a mark starts at: the place of a note, the start of a segment. */
export function startOf(mark: LessonMark): number {
  return mark.t === "note" ? mark.at : mark.from;
}

/** In the order of the journal; the list, the timeline and the saved header all use it. */
export function sortedMarks(items: readonly LessonMark[]): LessonMark[] {
  return [...items].sort((a, b) => startOf(a) - startOf(b));
}

function check(items: LessonMark[], total: number): MarkResult {
  try {
    check_lesson(items, total);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, items };
}

export function addNote(items: readonly LessonMark[], at: number, text: string, total: number): MarkResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: NOTE_TEXT_REQUIRED };
  return check([...items, { t: "note", at, text: trimmed }], total);
}

/** The reason why a segment cannot begin at event `here`, or null: any end would then overlap the segment it begins in. */
export function startProblem(items: readonly LessonMark[], here: number): string | null {
  const inside = items.some((mark) => mark.t === "self" && mark.from < here && here < mark.to);
  return inside ? SELF_START_INSIDE : null;
}

/** "Сам: кінець" at event `to` for a segment that began at `from` (null: it did not begin). */
export function addSelf(items: readonly LessonMark[], from: number | null, to: number, text: string, total: number): MarkResult {
  if (from === null) return { ok: false, error: SELF_NOT_OPEN };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: SELF_TEXT_REQUIRED };
  if (to <= from) return { ok: false, error: SELF_END_BEFORE_START };
  return check([...items, { t: "self", from, to, text: trimmed }], total);
}

export function removeMark(items: readonly LessonMark[], mark: LessonMark): LessonMark[] {
  return items.filter((other) => other !== mark);
}

/** Same marks in the same order: nothing to save. */
export function sameMarks(a: readonly LessonMark[], b: readonly LessonMark[]): boolean {
  return JSON.stringify(sortedMarks(a)) === JSON.stringify(sortedMarks(b));
}

/** The journal to `PUT`: a copy with the new `header.lesson` (an empty list is kept as `[]`, the server wants the key). */
export function lessonJournal(journal: Journal, items: readonly LessonMark[]): Journal {
  return { header: { ...journal.header, lesson: sortedMarks(items) }, events: journal.events };
}

export interface LessonCounts {
  notes: number;
  selfs: number;
}

export function lessonCounts(lesson: readonly LessonMark[] | undefined): LessonCounts {
  const marks = lesson ?? [];
  return {
    notes: marks.filter((mark) => mark.t === "note").length,
    selfs: marks.filter((mark) => mark.t === "self").length,
  };
}

/** Guest ms of the state with `index` events played: where a click on the mark goes and where the timeline draws it. */
export function placeOf(times: ArrayLike<number>, index: number): number {
  return momentTime(times, index);
}

export interface MarkSpan {
  id: string;
  kind: LessonMark["t"];
  from: number;
  to: number;
  label: string;
}

/** The marks as intervals of guest time (a note has `to = from`). */
export function markSpans(items: readonly LessonMark[], times: ArrayLike<number>): MarkSpan[] {
  return sortedMarks(items).map((mark, i) => {
    const from = placeOf(times, startOf(mark));
    return {
      id: `lesson-${i}`,
      kind: mark.t,
      from,
      to: mark.t === "self" ? placeOf(times, mark.to) : from,
      label: mark.text,
    };
  });
}

/** The one machine of a lesson when it has a start journal (the markup and the preview play it); null otherwise. */
export function lessonNodeWithJournal(item: Pick<LibraryItem, "topology" | "journals">): string | null {
  const [machine, ...rest] = item.topology.machines;
  if (machine === undefined || rest.length > 0) return null;
  return item.journals.some((ref) => ref.node === machine.id && ref.role === "start") ? machine.id : null;
}
