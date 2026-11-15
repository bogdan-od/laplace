import type { Journal, LessonMark } from "@core/core/journal.mjs";
import { describe, expect, it } from "vitest";
import {
  addNote,
  addSelf,
  lessonCounts,
  lessonNodeWithJournal,
  lessonJournal,
  markSpans,
  removeMark,
  sameMarks,
  sortedMarks,
  startProblem,
  SELF_END_BEFORE_START,
  SELF_NOT_OPEN,
  SELF_START_INSIDE,
  SELF_TEXT_REQUIRED,
  NOTE_TEXT_REQUIRED,
} from "./lesson-markup";

const TOTAL = 10;
const NOTE: LessonMark = { t: "note", at: 3, text: "Спершу uname" };
const SELF: LessonMark = { t: "self", from: 4, to: 8, text: "echo alpha" };

function items(result: ReturnType<typeof addNote>): LessonMark[] {
  if (!result.ok) throw new Error(result.error);
  return result.items;
}

describe("lesson markup rules", () => {
  it("adds a note at the place with the trimmed text and does not touch the list it got", () => {
    const before = [SELF];
    const after = items(addNote(before, 3, "  Пояснення  ", TOTAL));
    expect(after).toEqual([SELF, { t: "note", at: 3, text: "Пояснення" }]);
    expect(before).toEqual([SELF]);
  });

  it("refuses an empty text and a place outside the journal", () => {
    expect(addNote([], 3, "   ", TOTAL)).toEqual({ ok: false, error: NOTE_TEXT_REQUIRED });
    expect(addNote([], TOTAL + 1, "x", TOTAL)).toMatchObject({ ok: false });
    expect(addSelf([], 2, 4, "", TOTAL)).toEqual({ ok: false, error: SELF_TEXT_REQUIRED });
  });

  it("adds a segment closed after its start", () => {
    expect(items(addSelf([NOTE], 4, 8, " echo alpha ", TOTAL))).toEqual([NOTE, SELF]);
  });

  it("refuses a segment that was not begun, that ends at or before its start", () => {
    expect(addSelf([], null, 5, "x", TOTAL)).toEqual({ ok: false, error: SELF_NOT_OPEN });
    expect(addSelf([], 5, 5, "x", TOTAL)).toEqual({ ok: false, error: SELF_END_BEFORE_START });
    expect(addSelf([], 5, 2, "x", TOTAL)).toEqual({ ok: false, error: SELF_END_BEFORE_START });
  });

  it("refuses crossing segments with the text of the core and touching ones are fine", () => {
    const crossing = addSelf([SELF], 6, 9, "x", TOTAL);
    expect(crossing).toMatchObject({ ok: false });
    expect(crossing.ok ? "" : crossing.error).toContain("перетинаються");
    expect(addSelf([SELF], 8, 9, "x", TOTAL)).toMatchObject({ ok: true });
    expect(addSelf([SELF], 1, 4, "x", TOTAL)).toMatchObject({ ok: true });
  });

  it("refuses to begin a segment strictly inside another one, on its edges it is allowed", () => {
    expect(startProblem([SELF], 5)).toBe(SELF_START_INSIDE);
    expect(startProblem([SELF], 4)).toBeNull();
    expect(startProblem([SELF], 8)).toBeNull();
    expect(startProblem([NOTE], 5)).toBeNull();
  });

  it("removes exactly the mark that was clicked", () => {
    const twin: LessonMark = { ...NOTE };
    expect(removeMark([NOTE, twin, SELF], twin)).toEqual([NOTE, SELF]);
    expect(removeMark([NOTE, twin, SELF], twin)[0]).toBe(NOTE);
  });

  it("keeps the marks in the order of the journal", () => {
    const late: LessonMark = { t: "note", at: 9, text: "late" };
    expect(sortedMarks([late, SELF, NOTE])).toEqual([NOTE, SELF, late]);
    expect(sameMarks([late, NOTE], [NOTE, late])).toBe(true);
    expect(sameMarks([NOTE], [NOTE, late])).toBe(false);
  });
});

describe("lesson markup and the journal", () => {
  const journal: Journal = {
    header: { format: "v86-replay/9", profile: "buildroot", seed: 1, lesson: [NOTE] },
    events: Array.from({ length: TOTAL }, (_, i) => ({ t: "clock", c: i, w: 0, extra: 1 })) as never,
  };

  it("builds the journal to save: a new header.lesson in order, the source journal stays as it was", () => {
    const saved = lessonJournal(journal, [SELF, NOTE]);
    expect(saved.header.lesson).toEqual([NOTE, SELF]);
    expect(saved.events).toBe(journal.events);
    expect(journal.header.lesson).toEqual([NOTE]);
    expect(saved.header).toMatchObject({ profile: "buildroot", seed: 1 });
  });

  it("keeps an empty list as [] (the server needs the key)", () => {
    const saved = lessonJournal(journal, []);
    expect(saved.header.lesson).toEqual([]);
    expect(Object.keys(saved.header)).toContain("lesson");
  });

  it("counts explanations and segments for the lesson block", () => {
    expect(lessonCounts(undefined)).toEqual({ notes: 0, selfs: 0 });
    expect(lessonCounts([NOTE, SELF, { t: "note", at: 9, text: "x" }])).toEqual({ notes: 2, selfs: 1 });
  });

  it("names the machine of a lesson only when it is one and has a start journal", () => {
    const topology = (ids: string[]) => ({ format: "v86-topology/1", machines: ids.map((id) => ({ id, profile: "buildroot" })), switches: [], links: [] }) as never;
    const start = { node: "m1", role: "start", size: 1 } as const;
    expect(lessonNodeWithJournal({ topology: topology(["m1"]), journals: [start] })).toBe("m1");
    expect(lessonNodeWithJournal({ topology: topology(["m1"]), journals: [] })).toBeNull();
    expect(lessonNodeWithJournal({ topology: topology(["m1"]), journals: [{ ...start, role: "reference" }] })).toBeNull();
    expect(lessonNodeWithJournal({ topology: topology(["m1", "m2"]), journals: [start] })).toBeNull();
    expect(lessonNodeWithJournal({ topology: topology([]), journals: [] })).toBeNull();
  });

  it("places the marks on the guest time and a note is a point", () => {
    const times = Float64Array.from({ length: TOTAL }, (_, i) => (i + 1) * 100);
    const spans = markSpans([SELF, NOTE], times);
    expect(spans.map((span) => [span.kind, span.from, span.to, span.label])).toEqual([
      ["note", 300, 300, "Спершу uname"],
      ["self", 400, 800, "echo alpha"],
    ]);
    expect(markSpans([{ t: "note", at: 0, text: "start" }], times)[0]).toMatchObject({ from: 0, to: 0 });
  });
});
