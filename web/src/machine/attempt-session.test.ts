import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalEvent } from "@core/core/journal.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import { TOPOLOGY_FORMAT } from "@core/net/topology.mjs";
import type { Assignment, Attempt, Branch, BranchKind } from "@shared/api";
import type { RoomSocket } from "./room-link";
import { ActionInProgressError, AttemptSession, type PageEvents, type SessionDeps } from "./attempt-session";

interface Call {
  route: string;
  params?: { id?: number; index?: number };
  body?: Record<string, unknown>;
}

const HEADER = { format: "v86-replay/9", profile: "buildroot", seed: 1 } as const;
const LIVE_STATUS = { mode: "live", paused: false, ended: false, vtime: 0, next: 0, total: 0, per_ms: 1, instructions: 0 };

function typedEvents(text: string, from: number): JournalEvent[] {
  return [...text, "\r"].map((data, i) => ({ t: "serial", c: (from + i) * 10, w: 0, data }));
}

class FakeMachine {
  readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  status: unknown = null;
  mirror: JournalEvent[];
  dead = false;
  failed = false;
  recovering = false;
  live = false;
  user_paused = false;
  stopped = 0;
  /** The replay of the journal stops with an error instead of reaching its end. */
  diverge = false;

  readonly options: MachineOptions;
  readonly log: string[];

  constructor(options: MachineOptions, log: string[]) {
    this.options = options;
    this.log = log;
    this.mirror = options.journal ? [...options.journal.events] : [];
  }

  on = (name: string, handler: (...args: unknown[]) => void): void => {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
  };

  emit(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name) ?? []) handler(...args);
  }

  #goLive(): void {
    this.live = true;
    this.status = LIVE_STATUS;
    this.emit("status", this.status);
  }

  start = async (): Promise<void> => {
    this.log.push("start");
    if (!this.options.journal) {
      this.#goLive();
      return;
    }
    this.status = { ...LIVE_STATUS, mode: "replay", next: 1, total: this.mirror.length };
    this.emit("status", this.status);
    queueMicrotask(() => {
      if (!this.diverge) {
        this.emit("end", { vtime: 0, events: this.mirror.length });
        return;
      }
      this.dead = true;
      this.emit("error", "розбіжність: подія 2 на 20/0, зараз 25/0");
    });
  };

  go_live = async (): Promise<void> => {
    this.log.push("go_live");
    this.#goLive();
  };

  stop = (): void => {
    this.stopped++;
  };
  set_speed = (): void => undefined;
  pause = (): void => undefined;
  resume = (): void => undefined;
  net_in = (): void => undefined;
  teacher_input = (): void => undefined;
  checked_journal = async () => this.journal();
  check = async (): Promise<number> => 0;

  type = (data: string): void => {
    this.mirror.push(...typedEvents(data.replace("\r", ""), this.mirror.length));
  };

  journal = async () => ({ header: HEADER, events: [...this.mirror] });
  header_now = () => (this.options.journal ? { ...HEADER, parent: { digest: "d", event: this.mirror.length } } : HEADER);

  begin_session = async (): Promise<null> => {
    this.log.push("begin_session");
    return null;
  };

  run_setup = async (command: string): Promise<{ rc: number; output: string }> => {
    this.log.push(`run_setup:${command}`);
    return { rc: 0, output: "" };
  };

  rollback = async (index: number): Promise<void> => {
    this.log.push(`rollback:${index}`);
    this.mirror = this.mirror.slice(0, index);
    this.emit("reset");
  };
}

function assignment(): Assignment {
  return {
    id: 7,
    topology: {
      format: TOPOLOGY_FORMAT,
      machines: [{ id: "m1", title: "Машина", profile: "buildroot", setup: "net {mac} {n}" }],
      switches: [],
      links: [],
    },
    journals: [],
    shared_lan: false,
    frozen: false,
  } as unknown as Assignment;
}

function branchOf(id: number, kind: BranchKind, parent: number | null, fork: number): Branch {
  return {
    id,
    node: "m1",
    parent_id: parent,
    fork_event: fork,
    kind,
    author: { id: 1, name: "S" },
    event_count: 0,
    bytes: 0,
    created_at: id,
    updated_at: id,
  };
}

function attemptOf(branches: Branch[], heads: Record<string, number>): Attempt {
  return { id: 3, assignment_id: 7, variant: 2, heads, branches, help: [], submissions: [] } as unknown as Attempt;
}

class FakeRoomSocket {
  readonly handlers = new Map<string, Set<(message: never) => void>>();
  joins = 0;
  left = 0;
  on = (type: string, handler: (message: never) => void): (() => void) => {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  };
  send = (): boolean => true;
  join = (): void => {
    this.joins++;
  };
  leave = (): void => {
    this.left++;
  };
  receive(message: { type: string; frozen?: boolean }): void {
    for (const handler of this.handlers.get(message.type) ?? []) handler(message as never);
  }
}

class Harness {
  readonly log: string[] = [];
  readonly calls: Call[] = [];
  readonly machines: FakeMachine[] = [];
  readonly page: { hidden: () => void; pagehide: () => void }[] = [];
  attempt: Attempt = attemptOf([], {});
  headJournal: JournalEvent[] = [];
  /** The assignment's start journal (the teacher's prepared state); null - the assignment has none. */
  startJournal: JournalEvent[] | null = null;
  submitGate: Promise<void> = Promise.resolve();
  nextBranch = 10;
  /** The next machine that replays a journal diverges. */
  divergeNext = false;
  hintsOpened: number[] = [];
  /** What `GET /api/assignments/:id` says about the freeze. */
  frozen = false;
  session: AttemptSession;

  constructor(socket: FakeRoomSocket | null = null, frozen = false) {
    this.frozen = frozen;
    const pageEvents: PageEvents = {
      subscribe: (handlers) => {
        this.page.push(handlers);
        return () => undefined;
      },
    };
    const deps: SessionDeps = {
      api: this.#api as unknown as SessionDeps["api"],
      createMachine: (options) => {
        const machine = new FakeMachine(options, this.log);
        if (options.journal && this.divergeNext) {
          machine.diverge = true;
          this.divergeNext = false;
        }
        this.machines.push(machine);
        return machine as unknown as ReturnType<SessionDeps["createMachine"]>;
      },
      loadImagesRoot: async () => "/images/",
      socket: socket as unknown as RoomSocket | null,
      page: pageEvents,
      randomMac: () => "aa:bb:cc:dd:ee:ff",
      snapshotBytes: 1 << 20,
      newBackoff: () => ({ next: () => 1, reset: () => undefined }),
    };
    this.session = new AttemptSession(7, deps);
  }

  #api = async (route: string, options: Omit<Call, "route"> = {}): Promise<unknown> => {
    this.calls.push({ route, ...options });
    switch (route) {
      case "GET /api/assignments/:id":
        return {
          ...assignment(),
          frozen: this.frozen,
          journals: this.startJournal ? [{ node: "m1", role: "start", size: 1 }] : [],
          hints: this.hintsOpened.map((index) => ({ index, penalty: 2, text: "підказка" })),
        };
      case "GET /api/assignments/:id/journals/:node":
        return { header: HEADER, events: this.startJournal ?? [] };
      case "POST /api/assignments/:id/attempt":
      case "GET /api/attempts/:id":
        return this.attempt;
      case "GET /api/branches/:id/journal":
        return { header: HEADER, events: this.headJournal };
      case "POST /api/attempts/:id/branches": {
        const body = options.body ?? {};
        const parent = body.parent as { branch_id: number; event: number } | null;
        const branch = branchOf(this.nextBranch++, body.kind as BranchKind, parent?.branch_id ?? null, parent?.event ?? 0);
        this.attempt = attemptOf([...this.attempt.branches, branch], { ...this.attempt.heads, m1: branch.id });
        return branch;
      }
      case "PUT /api/branches/:id/events": {
        const body = options.body as { from: number; events: unknown[] };
        return { event_count: body.from + body.events.length };
      }
      case "POST /api/attempts/:id/submit":
        await this.submitGate;
        return { id: 1, attempt_id: 3, created_at: 0, verify_status: "queued", grade: null };
      case "POST /api/attempts/:id/hints/:index":
        this.hintsOpened.push(options.params?.index ?? -1);
        return { index: 0, penalty: 2, text: "підказка" };
      case "POST /api/attempts/:id/help":
        return { id: 1, text: options.body?.text };
      default:
        throw new Error(`unexpected route ${route}`);
    }
  };

  routes(name: string): Call[] {
    return this.calls.filter((call) => call.route === name);
  }

  async ready(): Promise<void> {
    this.session.start();
    await vi.waitFor(() => {
      const view = this.session.getSnapshot();
      expect(view.phase).toBe("ready");
      expect(view.machines[0]?.network).toMatch(/ready|none/);
      expect(view.machines[0]?.sync).not.toBeNull();
    });
  }
}

let harness: Harness | null = null;
afterEach(() => {
  harness?.session.dispose();
  harness = null;
});

describe("AttemptSession: new attempt", () => {
  it("opens the start branch, then begin_session, then the setup with mac and variant", async () => {
    harness = new Harness();
    await harness.ready();

    const branches = harness.routes("POST /api/attempts/:id/branches");
    expect(branches).toHaveLength(1);
    expect(branches[0]?.body).toMatchObject({ node: "m1", kind: "start", parent: null, make_head: true });
    expect(harness.log).toEqual(["start", "begin_session", "run_setup:net aa:bb:cc:dd:ee:ff 2"]);
    expect(harness.machines[0]?.options.journal).toBeUndefined();
    expect(harness.session.getSnapshot().machines[0]?.state).toBe("live");
  });
});

describe("AttemptSession: frozen assignment", () => {
  it("starts nothing and sends no branch request while frozen with no branch, then starts on the unfreeze", async () => {
    const socket = new FakeRoomSocket();
    harness = new Harness(socket, true);
    harness.session.start();
    await vi.waitFor(() => expect(harness?.session.getSnapshot().waitingForUnfreeze).toBe(true));

    expect(harness.machines).toHaveLength(0);
    expect(harness.routes("POST /api/attempts/:id/branches")).toHaveLength(0);
    expect(socket.joins).toBe(1);

    harness.frozen = false;
    socket.receive({ type: "frozen", frozen: false });
    await vi.waitFor(() => {
      const view = harness?.session.getSnapshot();
      expect(view?.phase).toBe("ready");
      expect(view?.machines[0]?.sync).not.toBeNull();
    });
    const view = harness.session.getSnapshot();
    expect(view.waitingForUnfreeze).toBe(false);
    expect(view.frozen).toBe(false);
    expect(harness.routes("POST /api/attempts/:id/branches")).toHaveLength(1);
  });

  it("keeps waiting on a repeated freeze message", async () => {
    const socket = new FakeRoomSocket();
    harness = new Harness(socket, true);
    harness.session.start();
    await vi.waitFor(() => expect(harness?.session.getSnapshot().waitingForUnfreeze).toBe(true));
    socket.receive({ type: "frozen", frozen: true });
    expect(harness.machines).toHaveLength(0);
    expect(harness.session.getSnapshot().waitingForUnfreeze).toBe(true);
  });

  it("does not change the behaviour of a machine that already has a branch", async () => {
    harness = new Harness(null, true);
    harness.attempt = attemptOf([branchOf(5, "start", null, 0)], { m1: 5 });
    harness.headJournal = typedEvents("ls", 0);
    await harness.ready();
    const view = harness.session.getSnapshot();
    expect(view.waitingForUnfreeze).toBe(false);
    expect(view.frozen).toBe(true);
    expect(view.machines[0]?.state).toBe("frozen");
    expect(harness.routes("POST /api/attempts/:id/branches")).toHaveLength(0);
  });
});

describe("AttemptSession: restore", () => {
  it("replays the head journal, does not open a branch and goes on saving into the same one", async () => {
    harness = new Harness();
    harness.headJournal = typedEvents("ls", 0);
    harness.attempt = attemptOf([branchOf(5, "start", null, 0)], { m1: 5 });
    await harness.ready();

    expect(harness.machines[0]?.options.journal?.events).toHaveLength(3);
    expect(harness.machines[0]?.options.on_journal_end).toBe("pause");
    expect(harness.routes("POST /api/attempts/:id/branches")).toHaveLength(0);
    expect(harness.session.getSnapshot().machines[0]?.branchId).toBe(5);
    // After the replay: the date and the network again.
    expect(harness.log.slice(-2)).toEqual(["begin_session", "run_setup:net aa:bb:cc:dd:ee:ff 2"]);
  });
});

describe("AttemptSession: actions", () => {
  it("rolls back into a new branch rollback forked at the chosen event", async () => {
    harness = new Harness();
    await harness.ready();
    harness.session.type("m1", "ls\r");
    const options = await harness.session.rollbackOptions("m1");
    expect(options.map((option) => option.label)[0]).toBe("До початку");
    expect(options).toHaveLength(2);

    await harness.session.rollback("m1", 0);

    const last = harness.routes("POST /api/attempts/:id/branches").at(-1);
    expect(last?.body).toMatchObject({ kind: "rollback", parent: { branch_id: 10, event: 0 }, make_head: true });
    expect(harness.log).toContain("rollback:0");
    expect(harness.session.getSnapshot().machines[0]?.branchId).toBe(11);
  });

  it("rejects a second submit while the first is being sent", async () => {
    harness = new Harness();
    await harness.ready();
    let release: () => void = () => undefined;
    harness.submitGate = new Promise((resolve) => {
      release = resolve;
    });

    const first = harness.session.submit();
    await vi.waitFor(() => expect(harness?.session.getSnapshot().busy).toBe("submit"));
    await expect(harness.session.submit()).rejects.toBeInstanceOf(ActionInProgressError);
    await expect(harness.session.rollback("m1", 0)).rejects.toBeInstanceOf(ActionInProgressError);
    release();
    const summary = await first;

    expect(summary.verify_status).toBe("queued");
    expect(harness.routes("POST /api/attempts/:id/submit")).toHaveLength(1);
    expect(harness.session.getSnapshot().submitted?.verify_status).toBe("queued");
    expect(harness.session.getSnapshot().busy).toBeNull();
  });

  it("sends the heads with the saved event counts on submit", async () => {
    harness = new Harness();
    await harness.ready();
    harness.session.type("m1", "ls\r");

    await harness.session.submit();

    const [submit] = harness.routes("POST /api/attempts/:id/submit");
    expect(submit?.body).toEqual({ heads: [{ node: "m1", branch_id: 10, event_count: 3 }] });
  });

  it("saves to the end and then asks for help at that place", async () => {
    harness = new Harness();
    await harness.ready();
    harness.session.type("m1", "ls\r");
    harness.calls.length = 0;

    await expect(harness.session.requestHelp("m1", "  ")).rejects.toThrow();
    harness.calls.length = 0;
    await harness.session.requestHelp("m1", "не працює");

    const routes = harness.calls.map((call) => call.route);
    expect(routes.indexOf("PUT /api/branches/:id/events")).toBeLessThan(routes.indexOf("POST /api/attempts/:id/help"));
    expect(harness.routes("POST /api/attempts/:id/help")[0]?.body).toEqual({
      node: "m1",
      branch_id: 10,
      event_count: 3,
      text: "не працює",
    });
  });

  it("opens a hint and shows the reloaded assignment", async () => {
    harness = new Harness();
    await harness.ready();

    await harness.session.openHint(0);

    expect(harness.hintsOpened).toEqual([0]);
    expect(harness.session.getSnapshot().assignment?.hints[0]?.text).toBe("підказка");
  });

  it("stops the machines and forgets the listeners on dispose", async () => {
    harness = new Harness();
    await harness.ready();

    harness.session.dispose();

    expect(harness.machines[0]?.stopped).toBe(1);
  });
});

describe("AttemptSession: replay divergence", () => {
  it("offers a restart, then opens a rollback branch at the beginning and replays that prefix", async () => {
    harness = new Harness();
    harness.headJournal = typedEvents("ls", 0);
    harness.attempt = attemptOf([branchOf(5, "start", null, 0)], { m1: 5 });
    harness.divergeNext = true;
    harness.session.start();

    await vi.waitFor(() => expect(harness?.session.getSnapshot().phase).toBe("failed"));
    const failed = harness.session.getSnapshot();
    expect(failed.error).toContain("Не вдалося відновити");
    expect(failed.machines[0]?.error).toContain("розбіжність");
    expect(failed.restartNode).toBe("m1");
    expect(failed.machines[0]?.state).toBe("failed");
    expect(harness.routes("POST /api/attempts/:id/branches")).toHaveLength(0);

    await harness.session.restartFromBeginning("m1");
    await harness.ready();

    const [rollback] = harness.routes("POST /api/attempts/:id/branches");
    expect(rollback?.body).toMatchObject({ node: "m1", kind: "rollback", parent: { branch_id: 5, event: 0 }, make_head: true });
    expect(harness.machines).toHaveLength(2);
    expect(harness.machines[0]?.stopped).toBe(1);
    const restarted = harness.machines[1];
    expect(restarted?.options.journal?.events).toHaveLength(0);
    expect(restarted?.options.journal?.header).toEqual(HEADER);
    const view = harness.session.getSnapshot();
    expect(view.phase).toBe("ready");
    expect(view.error).toBeNull();
    expect(view.restartNode).toBeNull();
    expect(view.machines[0]?.state).toBe("live");
    expect(view.machines[0]?.canType).toBe(true);
    expect(view.machines[0]?.branchId).toBe(10);
    expect(harness.session.type("m1", "ls\r")).toBe(true);
  });

  it("starts over after the assignment's start journal, not from a clean boot", async () => {
    harness = new Harness();
    harness.startJournal = typedEvents("cd", 0);
    harness.headJournal = [...typedEvents("cd", 0), ...typedEvents("ls", 3)];
    harness.attempt = attemptOf([branchOf(5, "start", null, 0)], { m1: 5 });
    harness.divergeNext = true;
    harness.session.start();
    await vi.waitFor(() => expect(harness?.session.getSnapshot().restartNode).toBe("m1"));

    await harness.session.restartFromBeginning("m1");
    await harness.ready();

    const [rollback] = harness.routes("POST /api/attempts/:id/branches");
    expect(rollback?.body).toMatchObject({ kind: "rollback", parent: { branch_id: 5, event: 3 }, make_head: true });
    expect(harness.machines[1]?.options.journal?.events).toHaveLength(3);
    const options = await harness.session.rollbackOptions("m1");
    expect(options.map((option) => option.index)).toEqual([3]);
  });

  it("refuses a restart when nothing diverged", async () => {
    harness = new Harness();
    await harness.ready();

    await expect(harness.session.restartFromBeginning("m1")).rejects.toThrow();
    expect(harness.machines).toHaveLength(1);
  });
});

describe("AttemptSession: continue from the teacher's reply", () => {
  it("restarts the screen from the reply as a continue branch that becomes the head", async () => {
    harness = new Harness();
    harness.headJournal = typedEvents("ls", 0);
    harness.attempt = attemptOf([branchOf(5, "start", null, 0), branchOf(6, "reply", 5, 3)], { m1: 5 });
    await harness.ready();

    await harness.session.continueFromReply("m1", 6);
    await harness.ready();

    const journals = harness.routes("GET /api/branches/:id/journal").map((call) => call.params?.id);
    expect(journals).toEqual([5, 6]);
    const last = harness.routes("POST /api/attempts/:id/branches").at(-1);
    expect(last?.body).toMatchObject({ node: "m1", kind: "continue", parent: { branch_id: 6, event: 3 }, make_head: true });
    expect(harness.machines).toHaveLength(2);
    expect(harness.machines[0]?.stopped).toBe(1);
    expect(harness.machines[1]?.options.journal?.events).toHaveLength(3);
    expect(harness.session.getSnapshot().machines[0]?.branchId).toBe(10);
    expect(harness.session.getSnapshot().busy).toBeNull();
  });

  it("refuses a branch that is not a teacher's reply", async () => {
    harness = new Harness();
    harness.attempt = attemptOf([branchOf(5, "start", null, 0)], { m1: 5 });
    await harness.ready();

    await expect(harness.session.continueFromReply("m1", 5)).rejects.toThrow("Відповідь викладача не знайдено");
  });
});
