import type { Journal } from "@core/core/journal.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import type { BranchDetail, HelpRequest } from "@shared/api";
import { describe, expect, it } from "vitest";
import { PlayerSession, type PlayerDeps } from "./player-session";

const STEP = 10_000;

function journal(): Journal {
  const lines = ["ls\n", "who\n", "date\n", "id\n"];
  return {
    header: { format: "v86-replay/9", profile: "buildroot", seed: 1, machine: "m1" },
    events: lines.map((data, i) => ({ t: "serial", c: 0, w: i * STEP, data })) as Journal["events"],
  };
}

function detail(): BranchDetail {
  return {
    branch: { id: 7, node: "m1", parent_id: null, kind: "start", fork_event: 0 } as BranchDetail["branch"],
    attempt_id: 3,
    assignment: { id: 4, title: "Налаштування мережі", class_id: 5 },
    student: { id: 6, name: "Лисенко Ірина" },
    machine: "m1",
    help_requests: [
      { id: 1, branch_id: 7, event_count: 2, text: "Не працює who", reply_branch_id: null } as HelpRequest,
      { id: 2, branch_id: 8, event_count: 1, text: "Інша гілка", reply_branch_id: null } as HelpRequest,
    ],
    teacher_inputs: [],
  };
}

class FakeMachine {
  readonly handlers = new Map<string, ((value: never) => void)[]>();
  readonly calls: string[] = [];
  readonly seeks: number[] = [];
  readonly gates: (() => void)[] = [];
  status: unknown = null;
  dead = false;
  failed = false;
  recovering = false;
  live = false;
  user_paused = false;
  mirror = [];

  on = (name: string, handler: (value: never) => void): void => {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  };
  start = async (): Promise<never> => {
    this.calls.push("start");
    return { status: { mode: "replay" } } as never;
  };
  stop = (): void => void this.calls.push("stop");
  pause = (): void => {
    this.calls.push("pause");
    this.user_paused = true;
  };
  resume = (): void => {
    this.calls.push("resume");
    this.user_paused = false;
  };
  set_speed = (x: number): void => void this.calls.push(`speed:${x}`);
  /** Holds the seek until the test lets it finish, like a machine that is busy replaying. */
  seek = (target: number): Promise<number> => {
    this.seeks.push(target);
    this.user_paused = true;
    return new Promise((resolve) => this.gates.push(() => resolve(target)));
  };
  emitStatus(status: unknown): void {
    this.status = status;
    for (const handler of this.handlers.get("status") ?? []) handler(status as never);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(startMs: number | null = null, played: Partial<BranchDetail["branch"]> = {}) {
  const machines: FakeMachine[] = [];
  const options: MachineOptions[] = [];
  const calls: string[] = [];
  const api = async (route: string): Promise<unknown> => {
    calls.push(route);
    switch (route) {
      case "GET /api/branches/:id/journal":
        return journal();
      case "GET /api/branches/:id":
        return { ...detail(), branch: { ...detail().branch, ...played } };
      case "GET /api/attempts/:id":
        return {
          branches: [
            { id: 6, parent_id: null, kind: "start", fork_event: 0 },
            { id: 7, parent_id: 6, kind: "rollback", fork_event: 2 },
          ],
        };
      default:
        throw new Error(`unexpected ${route}`);
    }
  };
  const deps: PlayerDeps = {
    api: api as unknown as PlayerDeps["api"],
    createMachine: (option) => {
      options.push(option);
      const machine = new FakeMachine();
      machines.push(machine);
      return machine as unknown as ReturnType<PlayerDeps["createMachine"]>;
    },
    loadImagesRoot: async () => "/images/",
    snapshotBytes: 1 << 20,
  };
  const session = new PlayerSession({ kind: "branch", id: 7 }, deps, startMs);
  return { session, machines, options, calls };
}

async function ready(startMs: number | null = null, played: Partial<BranchDetail["branch"]> = {}) {
  const kit = setup(startMs, played);
  kit.session.start();
  await settle();
  const machine = kit.machines[0];
  if (!machine) throw new Error("no machine");
  return { ...kit, machine };
}

describe("PlayerSession", () => {
  it("loads the journal of the branch and starts the machine paused, as a player", async () => {
    const { session, machine, options, calls } = await ready();
    expect(calls).toEqual(["GET /api/branches/:id/journal", "GET /api/branches/:id"]);
    expect(options[0]).toMatchObject({ root: "/images/", on_journal_end: "pause", timeline_only: true, name: "m1" });
    expect(machine.calls).toEqual(["pause", "start"]);
    const view = session.getSnapshot();
    expect(view.phase).toBe("ready");
    expect(view.paused).toBe(true);
    expect(view.duration).toBe(3 * STEP);
    expect(view.commands.map((c) => c.text)).toEqual(["ls", "who", "date", "id"]);
    expect(session.runtime()?.context).toBe("player");
    session.dispose();
  });

  it("marks where the student rolled back on the way to a branch that has a parent", async () => {
    const { session, calls } = await ready(null, { parent_id: 6, kind: "rollback", fork_event: 2 });
    expect(calls).toContain("GET /api/attempts/:id");
    const rollback = session.getSnapshot().marks.filter((mark) => mark.kind === "rollback");
    expect(rollback.map((mark) => mark.time)).toEqual([STEP]);
    session.dispose();
  });

  it("opens at ?t= and stays paused there", async () => {
    const { session, machine } = await ready(15_000);
    expect(machine.seeks).toEqual([15_000]);
    expect(session.getSnapshot()).toMatchObject({ seeking: true, position: 15_000 });
    machine.gates[0]?.();
    await settle();
    const view = session.getSnapshot();
    expect(view.seeking).toBe(false);
    expect(view.position).toBe(15_000);
    expect(view.paused).toBe(true);
    expect(machine.calls).not.toContain("resume");
    session.dispose();
  });

  it("without ?t= it does not seek", async () => {
    const { session, machine } = await ready();
    expect(machine.seeks).toEqual([]);
    session.dispose();
  });

  it("merges seeks that arrive while one runs: the last one wins", async () => {
    const { session, machine } = await ready();
    const first = session.seek(5_000);
    expect(session.getSnapshot().seeking).toBe(true);
    void session.seek(8_000);
    const last = session.seek(12_000);
    expect(machine.seeks).toEqual([5_000]);
    expect(session.getSnapshot().position).toBe(12_000);
    machine.gates[0]?.();
    await settle();
    expect(machine.seeks).toEqual([5_000, 12_000]);
    expect(session.getSnapshot().seeking).toBe(true);
    machine.gates[1]?.();
    await Promise.all([first, last]);
    const view = session.getSnapshot();
    expect(view.seeking).toBe(false);
    expect(view.position).toBe(12_000);
    session.dispose();
  });

  it("plays on after a seek only when it was playing", async () => {
    const { session, machine } = await ready();
    session.play();
    machine.emitStatus({ vtime: 1000, ended: false });
    expect(session.getSnapshot().paused).toBe(false);
    const playing = session.seek(5_000);
    machine.gates[0]?.();
    await playing;
    expect(machine.calls.filter((call) => call === "resume")).toHaveLength(2);

    session.pause();
    machine.calls.length = 0;
    const stopped = session.seek(1_000);
    machine.gates[1]?.();
    await stopped;
    expect(machine.calls).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ paused: true, position: 1_000 });
    session.dispose();
  });

  it("goes to the output of the next and the previous command", async () => {
    const { session, machine } = await ready();
    machine.emitStatus({ vtime: 0, ended: false });
    const next = session.step(1);
    machine.gates[0]?.();
    await next;
    expect(machine.seeks.at(-1)).toBe(STEP - 100);
    machine.emitStatus({ vtime: STEP - 100, ended: false });
    const again = session.step(1);
    machine.gates[1]?.();
    await again;
    expect(machine.seeks.at(-1)).toBe(2 * STEP - 100);
    machine.emitStatus({ vtime: 2 * STEP - 100, ended: false });
    const back = session.step(-1);
    machine.gates[2]?.();
    await back;
    expect(machine.seeks.at(-1)).toBe(STEP - 100);
    session.dispose();
  });

  it("at the end of the journal Play starts over", async () => {
    const { session, machine } = await ready();
    machine.emitStatus({ vtime: 3 * STEP, ended: true });
    expect(session.getSnapshot()).toMatchObject({ ended: true, paused: true });
    session.play();
    expect(machine.seeks).toEqual([0]);
    machine.gates[0]?.();
    await settle();
    expect(machine.calls.at(-1)).toBe("resume");
    session.dispose();
  });

  it("passes the speed to the machine", async () => {
    const { session, machine } = await ready();
    session.setSpeed(0);
    expect(machine.calls).toContain("speed:0");
    expect(session.getSnapshot().speed).toBe(0);
    session.dispose();
  });

  it("says why a source cannot be opened", async () => {
    const failing = new PlayerSession(
      { kind: "branch", id: 9 },
      {
        api: (async () => {
          throw new Error("boom");
        }) as unknown as PlayerDeps["api"],
        createMachine: () => {
          throw new Error("no machine");
        },
        loadImagesRoot: async () => "/",
        snapshotBytes: 1,
      },
      null,
    );
    failing.start();
    await settle();
    expect(failing.getSnapshot()).toMatchObject({ phase: "failed" });
    expect(failing.getSnapshot().error).not.toBeNull();
  });
});
