// A student's work on one assignment, outside React: the machines of the topology,
// the saving of their journals, new attempt and restore, rollback, help, submission, the room.
// Everything the session needs from the outside comes through `SessionDeps`, so tests run it with fakes.

import { read_journal, type Journal } from "@core/core/journal.mjs";
import { Backoff } from "@core/net/backoff.mjs";
import { Mesh } from "@core/net/mesh.mjs";
import { number_of } from "@core/net/room.mjs";
import { Router } from "@core/net/router.mjs";
import { build_topology, fill_setup, validate_topology, type TopologyMachine } from "@core/net/topology.mjs";
import { checked_journals, launch_topology } from "@core/net/topology_journals.mjs";
import { PROFILES, lab_net_command } from "@core/profiles.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import type {
  Api,
  ApiRoute,
  Assignment,
  Attempt,
  Branch,
  CreateBranchBody,
  HelpRequest,
  SubmissionSummary,
} from "@shared/api";
import { MAX_TEXT_CHARS } from "@shared/limits";
import { ApiFailure, NetworkFailure, describeError, type ApiArgs } from "@/lib/api";
import type { HubSession } from "./hub";
import { JournalSync, type BackoffLike, type SendChunk, type SyncStatus } from "./journal-sync";
import { MachineRuntime, type RuntimeView } from "./machine-runtime";
import type { MachineLike } from "./machine-types";
import { NetMonitor } from "./net-monitor";
import { MeshRoom, asMeshRoom } from "./room-adapter";
import { RoomLink, type RoomSocket } from "./room-link";
import { rollbackCommandNumbers } from "./branch-tree";
import { rollbackOptions, type RollbackOption } from "./rollback-list";

export type ApiFn = <K extends ApiRoute>(route: K, ...args: ApiArgs<K>) => Promise<Api[K]["res"]>;

/** The tab going to the background and the page going away; the real wiring is in `attempt-factory.ts`. */
export interface PageEvents {
  subscribe(handlers: { hidden(): void; pagehide(): void }): () => void;
}

export interface SessionDeps {
  api: ApiFn;
  createMachine(options: MachineOptions): MachineLike;
  /** URL prefix the core resolves image files against (`GET /api/images`). */
  loadImagesRoot(): Promise<string>;
  /** Null: no room (a test, a page without the live connection). */
  socket: RoomSocket | null;
  page: PageEvents;
  randomMac(): string;
  /** The memory the machines of one page may keep for their snapshots, shared between them. */
  snapshotBytes: number;
  newBackoff?(): BackoffLike;
}

export type ActionName = "rollback" | "help" | "submit" | "continue";

export interface AttemptView {
  readonly phase: "loading" | "ready" | "failed";
  /** Why the work cannot go on, or a problem of saving that the person should see. */
  readonly error: string | null;
  readonly assignment: Assignment | null;
  readonly attempt: Attempt | null;
  readonly machines: readonly RuntimeView[];
  readonly frozen: boolean;
  /** Frozen with no branch to continue: the machines are not started until the teacher unfreezes the work. */
  readonly waitingForUnfreeze: boolean;
  readonly busy: ActionName | null;
  /** The last submission, set only after the server answered. */
  readonly submitted: SubmissionSummary | null;
  /** The worst saving state of all machines, for the header. */
  readonly saveStatus: SyncStatus;
  /** The machine whose saved journal no longer replays: `restartFromBeginning(node)` is the way on. */
  readonly restartNode: string | null;
  /** Number of the command a rollback branch went back to, by branch id (path of the head only). */
  readonly commandNumbers: ReadonlyMap<number, number>;
}

/** What a component sees before its session exists. */
export const INITIAL_VIEW: AttemptView = {
  phase: "loading",
  error: null,
  assignment: null,
  attempt: null,
  machines: [],
  frozen: false,
  waitingForUnfreeze: false,
  busy: null,
  submitted: null,
  saveStatus: "saved",
  restartNode: null,
  commandNumbers: new Map(),
};

/** A second action started while one is still running; the buttons are off, this is the guard under them. */
export class ActionInProgressError extends Error {
  readonly running: ActionName;
  constructor(running: ActionName) {
    super("Попередня дія ще виконується");
    this.name = "ActionInProgressError";
    this.running = running;
  }
}

/** The request cannot be made now; the message is for the person. */
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateError";
  }
}

type StartPlan =
  | { mode: "fresh"; journal: Journal | null }
  | { mode: "resume"; branch: Branch; journal: Journal }
  // `journal` is what the machine replays, `from` the branch the new one forks from at its end.
  | { mode: "continue"; from: Branch; journal: Journal; kind: "continue" | "rollback" };

/** Where a boot starts a machine other than from its own head. */
interface BootOverride {
  node: string;
  branchId: number;
  /** Replay only the first `prefix` events of the branch journal and open a `rollback` branch there. */
  prefix?: number;
}

const SNAP_EVERY_MS = 15_000;
const CHECK_EVERY_MS = 10_000;
const LIVE_WAIT_MS = 5_000;
const STATUS_ORDER: readonly SyncStatus[] = ["error", "offline", "saving", "saved"];

const DIVERGED_TEXT =
  "Не вдалося відновити вашу сесію: збережений журнал більше не відтворюється. Можна почати спочатку, попередня спроба залишиться в історії";
const NOT_READY_TEXT = "Машина ще не готова. Зачекайте, поки з'явиться запрошення оболонки";
const FROZEN_TEXT = "Викладач призупинив роботу";

export class AttemptSession implements HubSession {
  readonly assignmentId: number;
  readonly #deps: SessionDeps;
  readonly #listeners = new Set<() => void>();
  readonly #macs = new Map<string, string>();
  /** Frames over the links and the last frames of each machine since the session was created. */
  readonly net = new NetMonitor();
  #runtimes: MachineRuntime[] = [];
  #unsubscribe: (() => void)[] = [];
  #room: RoomLink | null = null;
  #meshRoom: MeshRoom | null = null;
  #mesh: Mesh | null = null;
  #generation = 0;
  #started = false;
  #view: AttemptView;
  #phase: AttemptView["phase"] = "loading";
  #error: string | null = null;
  #assignment: Assignment | null = null;
  /** node -> events in the assignment's start journal: where "До початку" goes. */
  readonly #startEvents = new Map<string, number>();
  #attempt: Attempt | null = null;
  #frozen = false;
  #waitingForUnfreeze = false;
  #busy: ActionName | null = null;
  #submitted: SubmissionSummary | null = null;
  #commandNumbers: ReadonlyMap<number, number> = new Map();
  #restartNode: string | null = null;

  constructor(assignmentId: number, deps: SessionDeps) {
    this.assignmentId = assignmentId;
    this.#deps = deps;
    this.#view = this.#compute();
  }

  getSnapshot = (): AttemptView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Starts loading and booting. Safe to call twice. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#boot(null);
  }

  runtime(node: string): MachineRuntime | undefined {
    return this.#runtimes.find((runtime) => runtime.node === node);
  }

  /** Input from the student's terminal; false when the machine does not take it now. */
  type(node: string, data: string): boolean {
    return this.runtime(node)?.type(data) ?? false;
  }

  dispose(): void {
    this.#generation++;
    this.#teardown();
    this.net.dispose();
    this.#listeners.clear();
  }

  async refreshAttempt(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) return;
    this.#attempt = await this.#deps.api("GET /api/attempts/:id", { params: { id: attempt.id } });
    this.#updateCommandNumbers();
    this.#publish();
  }

  /** Opens a hint (the penalty is taken by the server) and reloads the assignment, which carries the text. */
  async openHint(index: number): Promise<void> {
    const attempt = this.#requireAttempt();
    await this.#deps.api("POST /api/attempts/:id/hints/:index", { params: { id: attempt.id, index } });
    this.#assignment = await this.#deps.api("GET /api/assignments/:id", { params: { id: this.assignmentId } });
    await this.#afterChange();
  }

  /** "До початку" and the student's own commands of a machine. */
  async rollbackOptions(node: string): Promise<RollbackOption[]> {
    const runtime = this.#requireRuntime(node);
    const startIndex = await this.#startIndex(this.#assignment, node);
    return rollbackOptions(await runtime.journal(), startIndex);
  }

  /**
   * Rolls the machine back to `index` (an event index from `rollbackOptions`): saves what there is, goes back,
   * opens a new branch `rollback` as the head and goes on saving into it. The date and the network setup
   * run again, as after a restore.
   */
  rollback(node: string, index: number): Promise<void> {
    return this.#exclusive("rollback", async () => {
      const runtime = this.#requireLive(node, true);
      const previous = runtime.sync;
      if (!previous) throw new SessionStateError(NOT_READY_TEXT);
      // The new branch forks from this one at `index`; the server must already have the events before it.
      await previous.flushNow();
      const parent = { branch_id: previous.branchId, event: index };
      const savedBefore = previous.saved;
      runtime.detachSync();
      try {
        await runtime.machine.rollback(index);
      } catch (error) {
        if (runtime.machine.mirror.length >= savedBefore) {
          runtime.attachSync(this.#newSync(previous.branchId, savedBefore, runtime));
        }
        throw error;
      }
      runtime.holdInput();
      await runtime.beginSession(this.#setupFor(runtime.node));
      await this.#openBranch(runtime, { kind: "rollback", parent, saved: index });
      await this.#afterChange();
    });
  }

  /** "У мене не працює": saves the journal to the end, then asks for help at that place. */
  requestHelp(node: string, text: string): Promise<HelpRequest> {
    return this.#exclusive("help", async () => {
      const trimmed = text.trim();
      if (trimmed === "" || trimmed.length > MAX_TEXT_CHARS) {
        throw new SessionStateError(`Опишіть проблему (до ${MAX_TEXT_CHARS} символів)`);
      }
      const attempt = this.#requireAttempt();
      const sync = this.#requireRuntime(node).sync;
      if (!sync) throw new SessionStateError(NOT_READY_TEXT);
      await sync.flushNow();
      const help = await this.#deps.api("POST /api/attempts/:id/help", {
        params: { id: attempt.id },
        body: { node, branch_id: sync.branchId, event_count: sync.saved, text: trimmed },
      });
      await this.#afterChange();
      return help;
    });
  }

  /**
   * "Здати": every machine's journal ends with `check` (except one that failed for good: its journal is what
   * there is), everything is saved, then the heads are submitted. The result is set only after the answer.
   */
  submit(): Promise<SubmissionSummary> {
    return this.#exclusive("submit", async () => {
      const attempt = this.#requireAttempt();
      if (this.#runtimes.length === 0 || this.#runtimes.some((runtime) => runtime.sync === null)) {
        throw new SessionStateError(NOT_READY_TEXT);
      }
      const running = this.#runtimes.filter((runtime) => runtime.state !== "failed");
      if (running.some((runtime) => runtime.state !== "live" && runtime.state !== "frozen")) {
        throw new SessionStateError(NOT_READY_TEXT);
      }
      const journals = await checked_journals(running.map((runtime) => [runtime.node, runtime.machine] as const));
      const taken = new Map(running.map((runtime, i) => [runtime.node, journals[i]] as const));
      for (const runtime of this.#runtimes) {
        const events = taken.get(runtime.node)?.events;
        await runtime.sync?.flushNow(events);
      }
      const heads = this.#runtimes.map((runtime) => ({
        node: runtime.node,
        branch_id: runtime.sync?.branchId ?? 0,
        event_count: runtime.sync?.saved ?? 0,
      }));
      const summary = await this.#deps.api("POST /api/attempts/:id/submit", { params: { id: attempt.id }, body: { heads } });
      this.#submitted = summary;
      await this.#afterChange();
      return summary;
    });
  }

  /** The student goes on from the teacher's reply: the machine restarts from the reply as a `continue` branch. */
  continueFromReply(node: string, replyBranchId: number): Promise<void> {
    return this.#exclusive("continue", async () => {
      const reply = this.#attempt?.branches.find((branch) => branch.id === replyBranchId);
      if (!reply || reply.kind !== "reply" || reply.node !== node) {
        throw new SessionStateError("Відповідь викладача не знайдено");
      }
      for (const runtime of this.#runtimes) await runtime.sync?.flushNow();
      this.#generation++;
      this.#teardown();
      await this.#boot({ node, branchId: replyBranchId });
    });
  }

  /**
   * After the saved journal of the head stopped replaying (a divergence): the same as the rollback to
   * "До початку" - a new `rollback` branch off the head at that position, the machine replays the same
   * prefix of the head journal, the old branch stays in the tree. The whole page boots again.
   */
  restartFromBeginning(node: string): Promise<void> {
    return this.#exclusive("rollback", async () => {
      const headId = this.#attempt?.heads[node];
      if (this.#restartNode !== node || headId === undefined) {
        throw new SessionStateError("Цю машину не потрібно починати спочатку");
      }
      this.#generation++;
      this.#teardown();
      await this.#boot({ node, branchId: headId, prefix: await this.#startIndex(this.#assignment, node) });
    });
  }

  // Boot

  async #boot(override: BootOverride | null): Promise<void> {
    const generation = this.#generation;
    this.#phase = "loading";
    this.#error = null;
    this.#restartNode = null;
    this.#waitingForUnfreeze = false;
    this.#publish();
    try {
      const { api } = this.#deps;
      const assignment = await api("GET /api/assignments/:id", { params: { id: this.assignmentId } });
      const problems = validate_topology(assignment.topology);
      if (problems.length > 0) throw new SessionStateError(`Опис топології містить помилки: ${problems.join("; ")}`);
      const attempt = await api("POST /api/assignments/:id/attempt", { params: { id: this.assignmentId } });
      if (this.#generation !== generation) return;
      // The server refuses a new branch while the work is frozen, so a machine that must open one waits.
      if (override === null && assignment.frozen && needsNewBranch(assignment, attempt)) {
        this.#waitForUnfreeze(assignment, attempt);
        return;
      }
      const root = await this.#deps.loadImagesRoot();
      const plans = new Map<string, StartPlan>();
      for (const machine of assignment.topology.machines) {
        plans.set(machine.id, await this.#plan(machine, assignment, attempt, override));
        if (this.#generation !== generation) return;
      }
      this.#assignment = assignment;
      this.#attempt = attempt;
      this.#frozen = assignment.frozen;
      this.#startMachines(assignment, root, plans);
      this.#phase = "ready";
      this.#publish();
      await this.#launch(assignment, plans, generation);
    } catch (error) {
      if (this.#generation !== generation) return;
      this.#phase = "failed";
      this.#error = this.#restartNode === null ? describeError(error) : DIVERGED_TEXT;
      this.#publish();
    }
  }

  /** Nothing is started and no request is made; the room is joined without machines to hear the unfreeze. */
  #waitForUnfreeze(assignment: Assignment, attempt: Attempt): void {
    this.#assignment = assignment;
    this.#attempt = attempt;
    this.#frozen = true;
    this.#waitingForUnfreeze = true;
    this.#joinRoom(assignment);
    this.#publish();
  }

  async #plan(
    machine: TopologyMachine,
    assignment: Assignment,
    attempt: Attempt,
    override: BootOverride | null,
  ): Promise<StartPlan> {
    const { api } = this.#deps;
    const overridden = override?.node === machine.id ? override.branchId : undefined;
    const headId = overridden ?? attempt.heads[machine.id];
    if (headId !== undefined) {
      await this.#startIndex(assignment, machine.id);
      const branch = attempt.branches.find((candidate) => candidate.id === headId);
      if (!branch) throw new SessionStateError("Гілку машини не знайдено. Оновіть сторінку");
      const journal = read_journal(await api("GET /api/branches/:id/journal", { params: { id: headId } }));
      if (overridden === undefined) return { mode: "resume", branch, journal };
      if (override?.prefix === undefined) return { mode: "continue", from: branch, journal, kind: "continue" };
      const prefix = { header: journal.header, events: journal.events.slice(0, override.prefix) };
      return { mode: "continue", from: branch, journal: prefix, kind: "rollback" };
    }
    const hasStart = assignment.journals.some((ref) => ref.node === machine.id && ref.role === "start");
    if (!hasStart) return { mode: "fresh", journal: null };
    const start = await api("GET /api/assignments/:id/journals/:node", {
      params: { id: assignment.id, node: machine.id },
      query: { role: "start" },
    });
    const journal = read_journal(start);
    this.#startEvents.set(machine.id, journal.events.length);
    return { mode: "fresh", journal };
  }

  /** Every branch of a machine begins with its start journal, so the student's own work starts after it. */
  async #startIndex(assignment: Assignment | null, node: string): Promise<number> {
    const known = this.#startEvents.get(node);
    if (known !== undefined) return known;
    const hasStart = assignment?.journals.some((ref) => ref.node === node && ref.role === "start") ?? false;
    if (!assignment || !hasStart) return 0;
    const start = await this.#deps.api("GET /api/assignments/:id/journals/:node", {
      params: { id: assignment.id, node },
      query: { role: "start" },
    });
    const count = read_journal(start).events.length;
    this.#startEvents.set(node, count);
    return count;
  }

  #startMachines(assignment: Assignment, root: string, plans: Map<string, StartPlan>): void {
    this.net.configure(assignment.topology);
    const budgets = snapshotBudgets(assignment.topology.machines, this.#deps.snapshotBytes);
    const net = build_topology(assignment.topology, {
      create_machine: (desc) => {
        const plan = plans.get(desc.id);
        if (!plan) throw new SessionStateError(`Немає плану запуску для машини ${desc.id}`);
        const runtime = this.#createRuntime(desc, plan, root, budgets.get(desc.id) ?? 0);
        this.#runtimes.push(runtime);
        return this.net.wrap(desc.id, runtime.machine);
      },
    });
    this.#netMachines = new Map(this.#runtimes.map((runtime) => [runtime.node, runtime.machine]));
    this.#teardownNet = () => net.teardown();
    for (const runtime of this.#runtimes) {
      this.#unsubscribe.push(runtime.subscribe(() => this.#publish()));
      runtime.setFrozen(this.#frozen);
    }
    this.#unsubscribe.push(this.#deps.page.subscribe({
      hidden: () => this.#runtimes.forEach((runtime) => runtime.sync?.onHidden()),
      pagehide: () => this.#runtimes.forEach((runtime) => runtime.sync?.onPageHide()),
    }));
    this.#joinRoom(assignment);
  }

  #netMachines: Map<string, MachineLike> = new Map();
  #teardownNet: (() => void) | null = null;

  #createRuntime(desc: TopologyMachine, plan: StartPlan, root: string, maxBytes: number): MachineRuntime {
    const common = { root, snap_every_ms: SNAP_EVERY_MS, check_every_ms: CHECK_EVERY_MS, name: desc.id, max_bytes: maxBytes };
    const machine = this.#deps.createMachine(
      plan.journal
        ? { ...common, journal: plan.journal, on_journal_end: "pause" }
        : { ...common, profile: desc.profile, on_journal_end: "live" },
    );
    return new MachineRuntime({
      node: desc.id,
      title: desc.title ?? desc.id,
      machine,
      fresh: plan.mode === "fresh" && plan.journal === null,
    });
  }

  async #launch(assignment: Assignment, plans: Map<string, StartPlan>, generation: number): Promise<void> {
    const replayed = [...plans].filter(([, plan]) => plan.journal !== null).map(([node]) => node);
    try {
      await launch_topology(this.#netMachines, replayed);
    } catch (error) {
      if (this.#generation === generation) this.#restartNode = this.#diverged(plans);
      throw error;
    }
    if (this.#generation !== generation) return;
    await Promise.all(
      this.#runtimes.map(async (runtime) => {
        const plan = plans.get(runtime.node);
        if (plan) await this.#afterLaunch(runtime, plan, assignment);
      }),
    );
    if (this.#generation !== generation) return;
    await this.#afterChange();
  }

  /** The machine that died while replaying its saved head: restarting from the beginning is offered for it. */
  #diverged(plans: Map<string, StartPlan>): string | null {
    const dead = this.#runtimes.find((runtime) => runtime.machine.dead && plans.get(runtime.node)?.mode === "resume");
    return dead?.node ?? null;
  }

  /** The machine is live: the branch it saves into, then the session start (date, network setup). */
  async #afterLaunch(runtime: MachineRuntime, plan: StartPlan, assignment: Assignment): Promise<void> {
    runtime.holdInput();
    await whenLive(runtime.machine);
    // The session start goes before the branch is opened: the machine takes no input until the setup has answered, and the
    // branch is a request that may be slow. The events are in the machine's mirror, so the journal sync sends them once attached.
    await runtime.beginSession(this.#setupFor(runtime.node));
    if (plan.mode === "fresh") {
      await this.#openBranch(runtime, { kind: "start", parent: null, saved: 0 });
    } else if (plan.mode === "resume") {
      runtime.attachSync(this.#newSync(plan.branch.id, plan.journal.events.length, runtime));
    } else {
      const event = plan.journal.events.length;
      await this.#openBranch(runtime, { kind: plan.kind, parent: { branch_id: plan.from.id, event }, saved: event });
    }
    if (assignment.shared_lan) await this.#configureSharedLan(runtime);
  }

  #setupFor(node: string): string | null {
    const desc = this.#assignment?.topology.machines.find((machine) => machine.id === node);
    if (!desc?.setup) return null;
    let mac = this.#macs.get(node);
    if (mac === undefined) {
      mac = this.#deps.randomMac();
      this.#macs.set(node, mac);
    }
    return fill_setup(desc.setup, mac).replaceAll("{n}", String(this.#attempt?.variant ?? 1));
  }

  // Branches and saving

  #sendChunk: SendChunk = ({ branchId, body, keepalive }) =>
    this.#deps.api("PUT /api/branches/:id/events", { params: { id: branchId }, body, keepalive });

  #newSync(branchId: number, saved: number, runtime: MachineRuntime): JournalSync {
    return new JournalSync({
      branchId,
      saved,
      events: () => runtime.machine.mirror,
      send: this.#sendChunk,
      ...(this.#deps.newBackoff ? { backoff: this.#deps.newBackoff() } : {}),
    });
  }

  /** Creates a branch of kind start/rollback/continue as the head and starts saving into it. */
  async #openBranch(
    runtime: MachineRuntime,
    options: { kind: Branch["kind"]; parent: CreateBranchBody["parent"]; saved: number },
  ): Promise<void> {
    const attempt = this.#requireAttempt();
    const generation = this.#generation;
    const branch = await this.#whileOffline(generation, () =>
      this.#deps.api("POST /api/attempts/:id/branches", {
        params: { id: attempt.id },
        body: {
          node: runtime.node,
          parent: options.parent,
          kind: options.kind,
          header: runtime.machine.header_now(),
          make_head: true,
        },
      }),
    );
    if (this.#generation !== generation) return;
    runtime.attachSync(this.#newSync(branch.id, options.saved, runtime));
  }

  /** Retries while there is no connection (the machine is already ahead of the server); a refusal goes up. */
  async #whileOffline<T>(generation: number, job: () => Promise<T>): Promise<T> {
    const backoff = this.#deps.newBackoff?.() ?? new Backoff();
    for (;;) {
      try {
        return await job();
      } catch (error) {
        const retry = error instanceof NetworkFailure || (error instanceof ApiFailure && error.status >= 500);
        if (!retry || this.#generation !== generation) throw error;
        await new Promise((resolve) => setTimeout(resolve, backoff.next()));
        if (this.#generation !== generation) throw error;
      }
    }
  }

  async #afterChange(): Promise<void> {
    try {
      await this.refreshAttempt();
    } catch {
      // The tree is stale until the next refresh; the action itself has succeeded.
    }
    this.#publish();
  }

  // Room

  #joinRoom(assignment: Assignment): void {
    const { socket } = this.#deps;
    if (!socket) return;
    // The mesh listens from before the join: it reads the member list from `joined`.
    this.#attachMesh(socket, assignment);
    this.#room = new RoomLink({
      socket,
      assignmentId: assignment.id,
      endpoints: this.#runtimes.map((runtime) => runtime.endpoint()),
      onFrozen: (frozen) => this.#setFrozen(frozen),
      onJoined: ({ id, role }) => {
        if (role === "student") this.#roomId = id;
      },
    });
    this.#room.start();
    this.#roomSocket = socket;
  }

  #roomSocket: RoomSocket | null = null;

  #setFrozen(frozen: boolean): void {
    if (this.#waitingForUnfreeze) {
      if (!frozen) this.#startAfterUnfreeze();
      return;
    }
    if (this.#frozen === frozen) return;
    this.#frozen = frozen;
    for (const runtime of this.#runtimes) runtime.setFrozen(frozen);
    this.#publish();
  }

  #startAfterUnfreeze(): void {
    this.#generation++;
    this.#teardown();
    void this.#boot(null);
  }

  /** Shared LAN with one machine: frames of the machine go through `Router` to `Mesh` over the room. */
  #attachMesh(socket: RoomSocket, assignment: Assignment): void {
    const runtime = this.#runtimes[0];
    if (!assignment.shared_lan || !runtime || this.#runtimes.length !== 1) return;
    this.#meshRoom = new MeshRoom(socket);
    this.#mesh = new Mesh(asMeshRoom(this.#meshRoom), runtime.machine);
    new Router(runtime.machine).attach_mesh(this.#mesh);
  }

  #roomId: string | null = null;

  /** The address in the shared network: 10.0.0.N, N is the student's number in the room. */
  async #configureSharedLan(runtime: MachineRuntime): Promise<void> {
    const waited = await this.#waitForRoomId();
    if (waited === null) return;
    const mac = this.#macs.get(runtime.node) ?? this.#deps.randomMac();
    this.#macs.set(runtime.node, mac);
    const command = lab_net_command({ mac, n: number_of(waited), internet: false });
    if (command !== null) await runtime.machine.run_setup(command);
  }

  async #waitForRoomId(): Promise<string | null> {
    const generation = this.#generation;
    for (let waited = 0; waited < LIVE_WAIT_MS * 2; waited += 100) {
      if (this.#roomId !== null) return this.#roomId;
      if (this.#generation !== generation || !this.#roomSocket) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  // Guards and view

  async #exclusive<T>(name: ActionName, job: () => Promise<T>): Promise<T> {
    if (this.#busy !== null) throw new ActionInProgressError(this.#busy);
    this.#busy = name;
    this.#publish();
    try {
      return await job();
    } finally {
      this.#busy = null;
      this.#publish();
    }
  }

  #requireAttempt(): Attempt {
    if (!this.#attempt) throw new SessionStateError(NOT_READY_TEXT);
    return this.#attempt;
  }

  #requireRuntime(node: string): MachineRuntime {
    const runtime = this.runtime(node);
    if (!runtime) throw new SessionStateError(`Машини ${node} немає в цьому завданні`);
    return runtime;
  }

  #requireLive(node: string, changesMachine: boolean): MachineRuntime {
    const runtime = this.#requireRuntime(node);
    if (runtime.state === "frozen" && changesMachine) throw new SessionStateError(FROZEN_TEXT);
    if (runtime.state !== "live") throw new SessionStateError(NOT_READY_TEXT);
    return runtime;
  }

  #updateCommandNumbers(): void {
    const attempt = this.#attempt;
    const numbers = new Map<number, number>();
    if (attempt) {
      for (const runtime of this.#runtimes) {
        const headId = attempt.heads[runtime.node];
        if (headId === undefined) continue;
        for (const [id, n] of rollbackCommandNumbers(attempt.branches, headId, runtime.machine.mirror, this.#startEvents.get(runtime.node) ?? 0)) numbers.set(id, n);
      }
    }
    this.#commandNumbers = numbers;
  }

  #compute(): AttemptView {
    const machines = this.#runtimes.map((runtime) => runtime.getView());
    const statuses = machines.flatMap((view) => (view.sync ? [view.sync.status] : []));
    const saveStatus = STATUS_ORDER.find((status) => statuses.includes(status)) ?? "saved";
    const syncError = machines.find((view) => view.sync?.status === "error")?.sync?.error ?? null;
    return {
      phase: this.#phase,
      error: this.#error ?? syncError,
      assignment: this.#assignment,
      attempt: this.#attempt,
      machines,
      frozen: this.#frozen,
      waitingForUnfreeze: this.#waitingForUnfreeze,
      busy: this.#busy,
      submitted: this.#submitted,
      saveStatus,
      restartNode: this.#restartNode,
      commandNumbers: this.#commandNumbers,
    };
  }

  #publish(): void {
    this.#view = this.#compute();
    for (const listener of [...this.#listeners]) listener();
  }

  #teardown(): void {
    this.#room?.dispose();
    this.#room = null;
    this.#mesh?.close();
    this.#mesh = null;
    this.#meshRoom?.dispose();
    this.#meshRoom = null;
    this.#roomId = null;
    this.#roomSocket = null;
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const runtime of this.#runtimes) runtime.dispose();
    this.#runtimes = [];
    this.#teardownNet?.();
    this.#teardownNet = null;
    this.#netMachines = new Map();
  }
}

function needsNewBranch(assignment: Assignment, attempt: Attempt): boolean {
  return assignment.topology.machines.some((machine) => attempt.heads[machine.id] === undefined);
}

/** Resolves when the machine reports live mode; after `LIVE_WAIT_MS` anyway, the header is still valid. */
export function whenLive(machine: MachineLike): Promise<void> {
  if (machine.status?.mode === "live") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, LIVE_WAIT_MS);
    machine.on("status", (status) => {
      if (status.mode !== "live") return;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The shared snapshot memory, split by the guest memory of each machine. */
function snapshotBudgets(machines: readonly TopologyMachine[], total: number): Map<string, number> {
  const memory = (machine: TopologyMachine): number => PROFILES[machine.profile].config("").memory_size;
  const sum = machines.reduce((acc, machine) => acc + memory(machine), 0);
  return new Map(machines.map((machine) => [machine.id, Math.floor((total * memory(machine)) / sum)]));
}
