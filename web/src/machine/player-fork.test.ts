import type { Journal } from "@core/core/journal.mjs";
import type { Comment, HelpRequest } from "@shared/api";
import { describe, expect, it } from "vitest";
import type { ForkChoice } from "./continue-from";
import { PlayerSession, type PlayerDeps } from "./player-session";

const STEP = 10_000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function journal(): Journal {
  return {
    header: { format: "v86-replay/9", profile: "buildroot", seed: 1, machine: "m1", lesson: [{ t: "note", at: 0, text: "x" }] },
    events: ["ls\n", "who\n", "id\n"].map((data, i) => ({ t: "serial", c: 0, w: i * STEP, data })) as Journal["events"],
  };
}

class QuietMachine {
  status = null;
  user_paused = true;
  mirror = [];
  on = (): void => undefined;
  start = async (): Promise<never> => ({ status: { mode: "replay" } }) as never;
  stop = (): void => undefined;
  pause = (): void => undefined;
  resume = (): void => undefined;
  set_speed = (): void => undefined;
  seek = async (target: number): Promise<number> => target;
}

interface Call {
  route: string;
  args: { params?: Record<string, number>; body?: unknown } | undefined;
}

function kit(source: PlayerSession["source"], respond: (call: Call) => unknown, machine: () => QuietMachine = () => new QuietMachine()) {
  const calls: Call[] = [];
  const api = async (route: string, args?: Call["args"]): Promise<unknown> => {
    const call = { route, args };
    calls.push(call);
    return respond(call);
  };
  const deps: PlayerDeps = {
    api: api as unknown as PlayerDeps["api"],
    createMachine: () => machine() as unknown as ReturnType<PlayerDeps["createMachine"]>,
    loadImagesRoot: async () => "/images/",
    snapshotBytes: 1 << 20,
  };
  const session = new PlayerSession(source, deps, null);
  session.start();
  return { session, calls };
}

const HELP = { id: 1, branch_id: 7, event_count: 2, text: "Не працює", reply_branch_id: null } as HelpRequest;

function branchApi(call: Call): unknown {
  switch (call.route) {
    case "GET /api/branches/:id/journal":
      return journal();
    case "GET /api/branches/:id":
      return {
        branch: { id: 7, parent_id: null, kind: "start", fork_event: 0 },
        attempt_id: 3,
        assignment: { id: 4, title: "Мережа", class_id: 5 },
        student: { id: 6, name: "Іра" },
        machine: "m1",
        help_requests: [HELP],
        teacher_inputs: [],
      };
    case "POST /api/attempts/:id/branches":
      return { id: 50 };
    case "POST /api/help/:id/reply":
      return { ...HELP, reply_branch_id: 50 };
    default:
      throw new Error(`unexpected ${call.route}`);
  }
}

describe("PlayerSession of a branch", () => {
  it("takes the title and the moments of help from the attempt of the branch", async () => {
    const { session } = kit({ kind: "branch", id: 7 }, branchApi);
    await settle();
    const view = session.getSnapshot();
    expect(view.title).toBe("Мережа");
    expect(view.subtitle).toBe("Іра · машина m1");
    expect(view.marks.filter((mark) => mark.kind === "help")).toHaveLength(1);
    expect(view.branch).toMatchObject({ branchId: 7, attemptId: 3, assignmentId: 4, classId: 5, studentId: 6, node: "m1" });
    expect(view.branch?.help[0]?.time).toBe(STEP);
    session.dispose();
  });

  it("a continue is one request: the branch off the played one, as the head", async () => {
    const { session, calls } = kit({ kind: "branch", id: 7 }, branchApi);
    await settle();
    const choice: ForkChoice = { kind: "continue", label: "", eventCount: 2, help: null, disabled: false };
    await session.fork(choice);
    const post = calls.filter((call) => call.route.startsWith("POST"));
    expect(post.map((call) => call.route)).toEqual(["POST /api/attempts/:id/branches"]);
    expect(post[0]?.args?.params).toEqual({ id: 3 });
    expect(post[0]?.args?.body).toMatchObject({ node: "m1", kind: "continue", make_head: true, parent: { branch_id: 7, event: 2 } });
    expect(post[0]?.args?.body).not.toHaveProperty("header.lesson");
    session.dispose();
  });

  it("a reply makes the branch and then answers the request with it", async () => {
    const { session, calls } = kit({ kind: "branch", id: 7 }, branchApi);
    await settle();
    await session.fork({ kind: "reply", label: "", eventCount: 2, help: HELP, disabled: false });
    const post = calls.filter((call) => call.route.startsWith("POST"));
    expect(post.map((call) => call.route)).toEqual(["POST /api/attempts/:id/branches", "POST /api/help/:id/reply"]);
    expect(post[0]?.args?.body).toMatchObject({ kind: "reply", make_head: false, parent: { branch_id: 7, event: 2 } });
    expect(post[1]?.args).toMatchObject({ params: { id: 1 }, body: { branch_id: 50 } });
    session.dispose();
  });
});

describe("PlayerSession of a submission", () => {
  const comment = (id: number, text: string): Comment => ({
    id,
    submission_id: 2,
    node: "m1",
    event_index: 2,
    vtime_ms: STEP,
    author: { id: 9, name: "Викладач" },
    text,
    created_at: 0,
  });

  function submissionApi(call: Call): unknown {
    switch (call.route) {
      case "GET /api/submissions/:id/journals/:node":
        return journal();
      case "GET /api/submissions/:id":
        return {
          assignment: { title: "Мережа" },
          student: { name: "Іра" },
          teacher_inputs: [],
          journals: [{ node: "m1", branch_id: 7, event_count: 4, digest: "d" }],
          comments: [comment(1, "Було")],
        };
      case "POST /api/submissions/:id/comments":
        return comment(2, (call.args as { body: { text: string } }).body.text);
      case "DELETE /api/comments/:id":
        return null;
      default:
        throw new Error(`unexpected ${call.route}`);
    }
  }

  it("shows the comments the server gave, takes no fork, and keeps comments in step with the server", async () => {
    const { session, calls } = kit({ kind: "submission", id: 2, node: "m1" }, submissionApi);
    await settle();
    expect(session.getSnapshot().branch).toBeNull();
    expect(session.getSnapshot().clip).toEqual({ branchId: 7, student: "Іра" });
    const labels = () => session.getSnapshot().marks.filter((mark) => mark.kind === "comment").map((mark) => mark.label);
    expect(labels()).toEqual(["Викладач: Було"]);

    await session.addComment("Нове");
    expect(calls.at(-1)).toMatchObject({
      route: "POST /api/submissions/:id/comments",
      args: { params: { id: 2 }, body: { node: "m1", event_index: 1, vtime_ms: 0, text: "Нове" } },
    });
    expect(labels()).toEqual(["Викладач: Було", "Викладач: Нове"]);

    await session.deleteComment(1);
    expect(labels()).toEqual(["Викладач: Нове"]);
    session.dispose();
  });
});

describe("PlayerSession of a library item and of a published item", () => {
  const item = { title: "Мережа: завдання", clip_from_ms: null };

  it("an item journal is read by role and named after the item and the machine", async () => {
    const { session, calls } = kit({ kind: "item", id: 3, node: "m1", role: "reference" }, (call) => {
      if (call.route === "GET /api/library/:id/journals/:node") return journal();
      if (call.route === "GET /api/library/:id") return item;
      throw new Error(`unexpected ${call.route}`);
    });
    await settle();
    const view = session.getSnapshot();
    expect(view.phase).toBe("ready");
    expect(view.title).toBe("Мережа: завдання");
    expect(view.subtitle).toBe("машина m1 · еталон");
    expect(view.branch).toBeNull();
    expect(view.clip).toBeNull();
    expect(calls.find((call) => call.route === "GET /api/library/:id/journals/:node")?.args).toMatchObject({
      params: { id: 3, node: "m1" },
      query: { role: "reference" },
    });
    session.dispose();
  });

  it("a published item is read by its token and starts at the moment the clip starts", async () => {
    const { session, calls } = kit({ kind: "embed", token: "abc-1" }, (call) => {
      if (call.route === "GET /api/embed/:token") return { title: "Кліп", journal: journal(), from_ms: STEP };
      throw new Error(`unexpected ${call.route}`);
    });
    await settle();
    const view = session.getSnapshot();
    expect(view.phase).toBe("ready");
    expect(view.title).toBe("Кліп");
    expect(view.position).toBe(STEP);
    expect(view.clip).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({ params: { token: "abc-1" } });
    session.dispose();
  });

  it("a clip is saved with the body it was given", async () => {
    const { session, calls } = kit({ kind: "branch", id: 7 }, (call) => (call.route === "POST /api/library/clip" ? { id: 9 } : branchApi(call)));
    await settle();
    const body = { branch_id: 7, to_event: 2, from_ms: 0, title: "Кліп" };
    await expect(session.saveClip(body)).resolves.toEqual({ id: 9 });
    expect(calls.at(-1)).toMatchObject({ route: "POST /api/library/clip", args: { body } });
    session.dispose();
  });

  it("the traffic file is empty for a journal without frames", async () => {
    const { session } = kit({ kind: "branch", id: 7 }, branchApi);
    await settle();
    expect(session.getSnapshot().netFrames).toBe(0);
    expect(session.pcap()?.length).toBe(24);
    session.dispose();
  });
});

describe("PlayerSession while the machine starts", () => {
  it("a seek asked before the start has finished waits for it, instead of restarting the worker", async () => {
    let release: () => void = () => undefined;
    const seeks: number[] = [];
    class SlowMachine extends QuietMachine {
      override start = (): Promise<never> =>
        new Promise((resolve) => {
          release = () => resolve({ status: { mode: "replay" } } as never);
        });
      override seek = async (target: number): Promise<number> => {
        seeks.push(target);
        return target;
      };
    }
    const { session } = kit({ kind: "branch", id: 7 }, branchApi, () => new SlowMachine());
    await settle();
    await session.seek(15_000);
    expect(seeks).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ position: 15_000, seeking: true });
    release();
    await settle();
    await settle();
    expect(seeks).toEqual([15_000]);
    expect(session.getSnapshot().seeking).toBe(false);
    session.dispose();
  });
});
