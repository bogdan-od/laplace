import type { Journal, LessonMark } from "@core/core/journal.mjs";
import { describe, expect, it } from "vitest";
import { LessonRun, type LessonMachine, type LessonPhase } from "./lesson-run";

const TOTAL = 100;
const NOTE_A: LessonMark = { t: "note", at: 0, text: "Спершу uname -r" };
const NOTE_B: LessonMark = { t: "note", at: 50, text: "Цикл відпрацював" };
const FIRST: LessonMark = { t: "self", from: 20, to: 40, text: "Виконайте: echo alpha" };
const SECOND: LessonMark = { t: "self", from: 60, to: 80, text: "Виконайте: echo beta" };

class FakeMachine {
  readonly calls: [string, ...unknown[]][] = [];
  readonly handlers = new Map<string, ((value: never) => void)[]>();
  startMode: "replay" | "live" = "replay";

  on = (name: string, handler: (value: never) => void): void => {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  };

  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value as never);
  }

  limit = (stop: number, liveAtStop: boolean): void => {
    this.calls.push(["limit", stop, liveAtStop]);
  };

  start = async (): Promise<never> => {
    this.calls.push(["start"]);
    return { status: { mode: this.startMode } } as never;
  };

  play_segment = async (segment: unknown): Promise<void> => {
    this.calls.push(["play_segment", segment]);
  };

  arrive(): void {
    this.emit("end", { op: "end" });
  }

  position(next: number): void {
    this.emit("status", { mode: "replay", next, total: TOTAL });
  }
}

function journalOf(marks: LessonMark[]): Pick<Journal, "header" | "events"> {
  return {
    header: { format: "v86-replay/9", profile: "buildroot", seed: 1, lesson: marks },
    events: Array.from({ length: TOTAL }, (_, i) => ({ t: "clock", c: i, w: 0, extra: 1 })) as never,
  };
}

async function started(marks: LessonMark[]): Promise<{ machine: FakeMachine; run: LessonRun }> {
  const machine = new FakeMachine();
  const run = new LessonRun(machine as unknown as LessonMachine, journalOf(marks));
  await run.begin();
  return { machine, run };
}

const phase = (run: LessonRun): LessonPhase => run.getSnapshot().phase;

describe("LessonRun", () => {
  it("limits the replay to the start of the first segment and goes live there", async () => {
    const { machine, run } = await started([NOTE_A, SECOND, FIRST]);
    expect(machine.calls).toEqual([["limit", 20, true], ["start"]]);
    expect(phase(run)).toBe("play");
    machine.arrive();
    expect(phase(run)).toBe("student");
    expect(run.getSnapshot().task).toBe("Виконайте: echo alpha");
  });

  it("walks play, student, retry, student, solution, solved, play, student, solution, solved, done", async () => {
    const { machine, run } = await started([FIRST, SECOND]);
    const seen: LessonPhase[] = [phase(run)];
    const arrive = () => {
      machine.arrive();
      seen.push(phase(run));
    };
    arrive();
    await run.retry();
    seen.push(phase(run));
    arrive();
    await run.showSolution();
    seen.push(phase(run));
    arrive();
    await run.next();
    seen.push(phase(run));
    arrive();
    await run.showSolution();
    seen.push(phase(run));
    arrive();
    await run.next();
    seen.push(phase(run));
    arrive();
    expect(seen).toEqual([
      "play", "student", "retry", "student", "solution", "solved",
      "play", "student", "solution", "solved", "play", "done",
    ]);
    expect(machine.calls.slice(2)).toEqual([
      ["play_segment", { from: 20, stop: 20, live_at_stop: true }],
      ["play_segment", { from: 20, stop: 40, live_at_stop: false }],
      ["play_segment", { from: 40, stop: 60, live_at_stop: true }],
      ["play_segment", { from: 60, stop: 80, live_at_stop: false }],
      ["play_segment", { from: 80, stop: TOTAL, live_at_stop: false }],
    ]);
    expect(run.getSnapshot().index).toBe(2);
  });

  it("retries from the solved phase too", async () => {
    const { machine, run } = await started([FIRST]);
    machine.arrive();
    await run.showSolution();
    machine.arrive();
    await run.retry();
    expect(phase(run)).toBe("retry");
    machine.arrive();
    expect(phase(run)).toBe("student");
  });

  it("a lesson without segments plays to the end", async () => {
    const { machine, run } = await started([NOTE_A]);
    expect(machine.calls[0]).toEqual(["limit", TOTAL, false]);
    expect(run.getSnapshot()).toMatchObject({ canAct: false, canNext: false, task: null });
    machine.arrive();
    expect(phase(run)).toBe("done");
  });

  it("a machine that is live right after start gives the student phase", async () => {
    const machine = new FakeMachine();
    machine.startMode = "live";
    const run = new LessonRun(machine as unknown as LessonMachine, journalOf([FIRST]));
    await run.begin();
    expect(phase(run)).toBe("student");
  });

  it("the note is the last one at or before the replay position", async () => {
    const { machine, run } = await started([NOTE_B, NOTE_A, FIRST]);
    let notifications = 0;
    run.subscribe(() => notifications++);
    expect(run.getSnapshot().note).toBeNull();
    machine.position(5);
    expect(run.getSnapshot().note).toBe("Спершу uname -r");
    machine.position(10);
    expect(notifications).toBe(1);
    machine.position(50);
    expect(run.getSnapshot().note).toBe("Цикл відпрацював");
  });

  it("the buttons do nothing outside their phases", async () => {
    const { machine, run } = await started([FIRST, SECOND]);
    const before = machine.calls.length;
    await run.retry();
    await run.showSolution();
    await run.next();
    expect(phase(run)).toBe("play");
    machine.arrive();
    await run.next();
    expect(phase(run)).toBe("student");
    await run.showSolution();
    expect(phase(run)).toBe("solution");
    await run.retry();
    await run.next();
    expect(phase(run)).toBe("solution");
    expect(machine.calls.length).toBe(before + 1);
    machine.arrive();
    expect(phase(run)).toBe("solved");
  });

  it("offers the buttons as the old page did", async () => {
    const { machine, run } = await started([FIRST]);
    expect(run.getSnapshot()).toMatchObject({ canAct: false, canNext: false, task: null });
    machine.arrive();
    expect(run.getSnapshot()).toMatchObject({ canAct: true, canNext: false, task: "Виконайте: echo alpha" });
    await run.showSolution();
    expect(run.getSnapshot()).toMatchObject({ canAct: false, canNext: false, task: "Виконайте: echo alpha" });
    machine.arrive();
    expect(run.getSnapshot()).toMatchObject({ canAct: true, canNext: true });
  });
});
