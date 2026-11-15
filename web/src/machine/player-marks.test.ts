import type { Journal, JournalEvent } from "@core/core/journal.mjs";
import type { Branch, Comment, HelpRequest, TeacherInput } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  commentMarks,
  currentCommand,
  eventCountAt,
  formatGuestTime,
  isPaste,
  matchTeacherInputs,
  mergeMarks,
  momentTime,
  rollbackPoints,
  stepTarget,
  type PlayerCommand,
} from "./player-marks";

const MS_STEP = 1000;

function serial(data: string, index: number, extra: { by?: string; p?: 0 | 1 | 2 } = {}): JournalEvent {
  return { t: "serial", c: 0, w: index * MS_STEP, data, ...extra } as JournalEvent;
}

function journalOf(events: JournalEvent[]): Journal {
  return { header: { format: "v86-replay/9", profile: "buildroot", seed: 1 }, events };
}

function input(node: string, port: 0 | 2, data: string, at = 0): TeacherInput {
  return { node, port, data, author: { id: 1, name: "Викладач" }, received_at: at };
}

describe("isPaste", () => {
  it("a keystroke and a short input are not a paste", () => {
    expect(isPaste(serial("l", 0))).toBe(false);
    expect(isPaste(serial("ls -la\n", 0))).toBe(false);
    expect(isPaste(serial("12345678", 0))).toBe(false);
  });

  it("an input longer than 8 characters is", () => {
    expect(isPaste(serial("123456789", 0))).toBe(true);
    expect(isPaste(serial("echo hello world\n", 0))).toBe(true);
  });

  it("the bracketed paste start is, whatever the length", () => {
    expect(isPaste(serial("\x1b[200~x", 0))).toBe(true);
  });

  it("only the student's console counts", () => {
    expect(isPaste(serial("echo hello world\n", 0, { by: "teacher" }))).toBe(false);
    expect(isPaste(serial("echo hello world\n", 0, { by: "system", p: 1 }))).toBe(false);
    expect(isPaste(serial("echo hello world\n", 0, { p: 2 }))).toBe(false);
    expect(isPaste(serial("echo hello world\n", 0, { by: "student" }))).toBe(true);
  });
});

describe("matchTeacherInputs", () => {
  it("a record that equals the event matches", () => {
    const events = [serial("ls\n", 0, { by: "teacher" })];
    expect([...matchTeacherInputs(events, [input("m1", 0, "ls\n")], "m1")]).toEqual([0]);
  });

  it("a record that several events share matches each of them in order", () => {
    const events = [serial("echo ", 0, { by: "teacher" }), serial("student\n", 1), serial("hi\n", 2, { by: "teacher" })];
    expect([...matchTeacherInputs(events, [input("m1", 0, "echo hi\n")], "m1")]).toEqual([0, 2]);
  });

  it("an event longer than what is left of the records does not match, and does not eat them", () => {
    const events = [serial("echo hi\nextra", 0, { by: "teacher" }), serial("echo hi\n", 1, { by: "teacher" })];
    expect([...matchTeacherInputs(events, [input("m1", 0, "echo hi\n")], "m1")]).toEqual([1]);
  });

  it("an event with no record is the student's", () => {
    const events = [serial("rm -rf x\n", 0, { by: "teacher" })];
    expect(matchTeacherInputs(events, [], "m1").size).toBe(0);
    expect(matchTeacherInputs(events, [input("m1", 0, "ls\n")], "m1").size).toBe(0);
  });

  it("records are kept apart by machine and port", () => {
    const events = [
      serial("b\n", 0, { by: "teacher" }),
      serial("c\n", 1, { by: "teacher", p: 2 }),
      serial("a\n", 2, { by: "teacher" }),
      serial("c\n", 3, { by: "teacher" }),
    ];
    const inputs = [input("m1", 0, "a\n"), input("m2", 0, "b\n"), input("m1", 2, "c\n")];
    expect([...matchTeacherInputs(events, inputs, "m1")]).toEqual([1, 2]);
    expect([...matchTeacherInputs([serial("b\n", 0, { by: "teacher" })], inputs, "m2")]).toEqual([0]);
  });

  it("records are joined in the order the server received them", () => {
    const events = [serial("one\n", 0, { by: "teacher" }), serial("two\n", 1, { by: "teacher" })];
    const inputs = [input("m1", 0, "two\n", 20), input("m1", 0, "one\n", 10)];
    expect([...matchTeacherInputs(events, inputs, "m1")]).toEqual([0, 1]);
  });
});

describe("buildTimeline", () => {
  const events = [
    serial("ls\n", 0),
    serial("echo hello world\n", 2),
    serial("who\n", 4, { by: "teacher" }),
    serial("pw", 6, { by: "teacher" }),
  ];

  it("lists the commands with the time of the jump after the output", () => {
    const { commands, duration } = buildTimeline({ journal: journalOf(events), teacherInputs: [input("m1", 0, "who\npw")], node: "m1", help: [] });
    expect(commands.map((c) => [c.number, c.text, c.by])).toEqual([
      [1, "ls", "student"],
      [2, "echo hello world", "student"],
      [3, "who", "teacher"],
    ]);
    expect(duration).toBe(6 * MS_STEP);
    expect(commands.map((c) => c.target)).toEqual([2 * MS_STEP - 100, 4 * MS_STEP - 100, 6 * MS_STEP]);
  });

  it("a teacher event the server did not record is the student's", () => {
    const { commands, marks } = buildTimeline({ journal: journalOf(events), teacherInputs: [], node: "m1", help: [] });
    expect(commands.every((c) => c.by === "student")).toBe(true);
    expect(marks.some((m) => m.kind === "teacher")).toBe(false);
  });

  it("marks commands, teacher typing outside commands, pastes and help requests", () => {
    const help = { id: 9, text: "не виходить", event_count: 2 } as HelpRequest;
    const { marks } = buildTimeline({ journal: journalOf(events), teacherInputs: [input("m1", 0, "who\npw")], node: "m1", help: [help] });
    expect(marks.map((m) => [m.kind, m.time])).toEqual([
      ["command", 0],
      ["command", 2 * MS_STEP],
      ["paste", 2 * MS_STEP],
      ["help", 2 * MS_STEP],
      ["teacher", 4 * MS_STEP],
      ["teacher", 6 * MS_STEP],
    ]);
    expect(marks.find((m) => m.kind === "help")?.label).toBe("Не працює: не виходить");
    expect(marks.find((m) => m.kind === "paste")?.label).toBe("Вставка з буфера: 17 символів");
  });
});

describe("stepping through commands", () => {
  const list = [0, 1000, 2000].map((time, i) => ({ number: i + 1, time, target: time + 500 }) as PlayerCommand);

  it("finds the command the position is on", () => {
    expect(currentCommand(list, -1)).toBe(-1);
    expect(currentCommand(list, 0)).toBe(0);
    expect(currentCommand(list, 1900)).toBe(1);
    expect(currentCommand(list, 9999)).toBe(2);
  });

  it("→ goes to the output of the current command if it is not reached, then to the next one", () => {
    expect(stepTarget(list, 0, 1)).toBe(500);
    expect(stepTarget(list, 500, 1)).toBe(1500);
    expect(stepTarget(list, 480, 1)).toBe(1500);
    expect(stepTarget(list, 700, 1)).toBe(1500);
    expect(stepTarget(list, 1500, 1)).toBe(2500);
    expect(stepTarget(list, 2500, 1)).toBeNull();
  });

  it("→ before the first command goes to the first one", () => {
    expect(stepTarget([{ number: 1, time: 300, target: 800 } as PlayerCommand], 100, 1)).toBe(800);
  });

  it("← goes back to the output of the current command first, then to the one before", () => {
    expect(stepTarget(list, 1800, -1)).toBe(1500);
    expect(stepTarget(list, 1500, -1)).toBe(500);
    expect(stepTarget(list, 500, -1)).toBe(0);
    expect(stepTarget(list, 0, -1)).toBeNull();
  });
});

describe("small helpers", () => {
  it("momentTime is the time of the last of the first N events", () => {
    const times = Float64Array.of(0, 100, 250);
    expect(momentTime(times, 0)).toBe(0);
    expect(momentTime(times, 2)).toBe(100);
    expect(momentTime(times, 99)).toBe(250);
    expect(momentTime(new Float64Array(), 3)).toBe(0);
  });

  it("formatGuestTime is minutes and seconds", () => {
    expect(formatGuestTime(0)).toBe("00:00");
    expect(formatGuestTime(187_900)).toBe("03:07");
    expect(formatGuestTime(3_725_000)).toBe("62:05");
  });
});

describe("comments", () => {
  const comment = (id: number, node: string, vtime: number, text: string): Comment => ({
    id,
    submission_id: 1,
    node,
    event_index: 3,
    vtime_ms: vtime,
    author: { id: 5, name: "Викладач" },
    text,
    created_at: 0,
  });

  it("makes a mark at the moment of each comment of the machine, with the text and the author", () => {
    const marks = commentMarks([comment(1, "m1", 4000, "Тут помилка"), comment(2, "m2", 100, "інша машина")], "m1");
    expect(marks).toEqual([
      { id: "comment-1", kind: "comment", time: 4000, target: 4000, label: "Викладач: Тут помилка", command: null, comment: { id: 1, author: 5 } },
    ]);
  });

  it("merges the marks of comments into the others in time order", () => {
    const base = buildTimeline({ journal: journalOf([serial("ls\n", 0), serial("who\n", 4)]), teacherInputs: [], node: "m1", help: [] }).marks;
    const merged = mergeMarks(base, commentMarks([comment(1, "m1", 2000, "a")], "m1"));
    expect(merged.map((mark) => [mark.kind, mark.time])).toEqual([
      ["command", 0],
      ["comment", 2000],
      ["command", 4000],
    ]);
  });
});

describe("eventCountAt", () => {
  const times = Float64Array.of(0, 1000, 1000, 2500);

  it("counts the events at or before the position", () => {
    expect(eventCountAt(times, -1)).toBe(0);
    expect(eventCountAt(times, 0)).toBe(1);
    expect(eventCountAt(times, 999)).toBe(1);
    expect(eventCountAt(times, 1000)).toBe(3);
    expect(eventCountAt(times, 9999)).toBe(4);
    expect(eventCountAt(new Float64Array(), 5)).toBe(0);
  });

  it("takes a rounded position as the event it was rounded from", () => {
    expect(eventCountAt(Float64Array.of(1000.4), 1000)).toBe(1);
  });
});

describe("rollbacks", () => {
  const branch = (id: number, parent: number | null, fork: number, kind: Branch["kind"]) =>
    ({ id, parent_id: parent, fork_event: fork, kind }) as Branch;
  const path = [branch(1, null, 0, "start"), branch(2, 1, 5, "rollback"), branch(3, 2, 8, "rollback"), branch(4, 3, 3, "rollback")];

  it("each rollback branch of the path is a point, in time order", () => {
    expect(rollbackPoints(path, 3)).toEqual([5, 8]);
    expect(rollbackPoints(path, 1)).toEqual([]);
  });

  it("a rollback below the fork of a later one is cut out of the journal, so it is no point", () => {
    expect(rollbackPoints(path, 4)).toEqual([3]);
  });

  it("a continuation or a reply is not a rollback", () => {
    expect(rollbackPoints([branch(1, null, 0, "start"), branch(2, 1, 4, "continue"), branch(3, 2, 6, "reply")], 3)).toEqual([]);
  });

  it("makes a mark at the last event kept, and a different label for the start", () => {
    const journal = journalOf([serial("ls\n", 0), serial("who\n", 4)]);
    const { marks } = buildTimeline({ journal, teacherInputs: [], node: "m1", help: [], rollbacks: [0, 2] });
    expect(marks.filter((m) => m.kind === "rollback").map((m) => [m.time, m.label, m.target])).toEqual([
      [0, "Відкат до початку", 0],
      [4000, "Відкат до цього місця", 4000],
    ]);
  });
});
