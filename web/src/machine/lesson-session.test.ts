import type { Journal, LessonMark } from "@core/core/journal.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import type { Assignment, Attempt } from "@shared/api";
import { describe, expect, it } from "vitest";
import { LessonSession, type LessonDeps, type LessonSource } from "./lesson-session";

const SELF: LessonMark = { t: "self", from: 2, to: 4, text: "Виконайте: echo mine" };

function journal(): Journal {
  return {
    header: { format: "v86-replay/9", profile: "buildroot", seed: 1, lesson: [SELF] },
    events: Array.from({ length: 6 }, (_, i) => ({ t: "clock", c: i, w: 0, extra: 1 })) as never,
  };
}

class FakeMachine {
  readonly handlers = new Map<string, ((value: never) => void)[]>();
  readonly calls: string[] = [];
  status: unknown = null;
  dead = false;
  failed = false;
  recovering = false;
  live = false;
  user_paused = false;
  mirror = [];
  stopped = 0;

  on = (name: string, handler: (value: never) => void): void => {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  };
  limit = (stop: number, live: boolean): void => void this.calls.push(`limit:${stop}:${live}`);
  start = async (): Promise<never> => {
    this.calls.push("start");
    return { status: { mode: "replay" } } as never;
  };
  play_segment = async (): Promise<void> => undefined;
  stop = (): void => void this.stopped++;
}

function setup(patch: Partial<Assignment> = {}, source: LessonSource = { kind: "assignment", id: 7 }) {
  const calls: string[] = [];
  const machines: FakeMachine[] = [];
  const options: MachineOptions[] = [];
  const assignment = {
    id: 7,
    kind: "lesson",
    topology: { format: "v86-topology/1", machines: [{ id: "m1", profile: "buildroot" }], switches: [], links: [] },
    journals: [{ node: "m1", role: "start", size: 1 }],
    ...patch,
  } as unknown as Assignment;
  let attempt = { id: 3, completed_at: null } as unknown as Attempt;
  const api = async (route: string): Promise<unknown> => {
    calls.push(route);
    switch (route) {
      case "GET /api/assignments/:id":
        return assignment;
      case "POST /api/assignments/:id/attempt":
        return attempt;
      case "GET /api/assignments/:id/journals/:node":
      case "GET /api/library/:id/journals/:node":
        return journal();
      case "GET /api/library/:id":
        return assignment;
      case "POST /api/attempts/:id/complete":
        attempt = { ...attempt, completed_at: 123 } as Attempt;
        return attempt;
      default:
        throw new Error(`unexpected ${route}`);
    }
  };
  const deps: LessonDeps = {
    api: api as unknown as LessonDeps["api"],
    createMachine: (option) => {
      options.push(option);
      const machine = new FakeMachine();
      machines.push(machine);
      return machine as unknown as ReturnType<LessonDeps["createMachine"]>;
    },
    loadImagesRoot: async () => "/images/",
    snapshotBytes: 1 << 20,
  };
  return { session: new LessonSession(source, deps), calls, machines, options };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LessonSession", () => {
  it("opens the attempt, plays the teacher's journal as a timeline and limits it to the first segment", async () => {
    const { session, calls, machines, options } = setup();
    session.start();
    await settle();
    expect(calls).toEqual([
      "GET /api/assignments/:id",
      "POST /api/assignments/:id/attempt",
      "GET /api/assignments/:id/journals/:node",
    ]);
    expect(options[0]).toMatchObject({ root: "/images/", on_journal_end: "pause", timeline_only: true, name: "m1" });
    expect(machines[0]?.calls).toEqual(["limit:2:true", "start"]);
    const view = session.getSnapshot();
    expect(view.phase).toBe("ready");
    expect(view.lesson?.phase).toBe("play");
    expect(session.runtime()?.context).toBe("player");
    session.dispose();
  });

  it("previews a library item: no attempt, the journal of the item, nothing to complete", async () => {
    const { session, calls, machines } = setup({}, { kind: "item", id: 7 });
    session.start();
    await settle();
    expect(calls).toEqual(["GET /api/library/:id", "GET /api/library/:id/journals/:node"]);
    expect(machines).toHaveLength(1);
    const view = session.getSnapshot();
    expect(view).toMatchObject({ phase: "ready", assignment: null, attempt: null });
    expect(view.lesson?.phase).toBe("play");
    await session.complete();
    expect(calls).toHaveLength(2);
    session.dispose();
  });

  it("completes the attempt", async () => {
    const { session, calls } = setup();
    session.start();
    await settle();
    await session.complete();
    expect(calls.at(-1)).toBe("POST /api/attempts/:id/complete");
    expect(session.getSnapshot().attempt?.completed_at).toBe(123);
    session.dispose();
  });

  it("refuses an assignment that is not a lesson with one machine and a journal", async () => {
    const lonely = setup({ journals: [] });
    lonely.session.start();
    await settle();
    expect(lonely.session.getSnapshot()).toMatchObject({ phase: "failed", error: "В уроку немає журналу викладача" });
    expect(lonely.machines).toHaveLength(0);
    const task = setup({ kind: "task" });
    task.session.start();
    await settle();
    expect(task.session.getSnapshot().phase).toBe("failed");
  });

  it("restart drops the machine and boots again", async () => {
    const { session, machines } = setup();
    session.start();
    await settle();
    session.restart();
    await settle();
    expect(machines).toHaveLength(2);
    expect(machines[0]?.stopped).toBe(1);
    expect(session.getSnapshot().phase).toBe("ready");
    session.dispose();
  });
});
