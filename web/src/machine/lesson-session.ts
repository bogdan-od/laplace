// A student's lesson: the teacher's journal plays on the one machine of the
// assignment, at the "now on your own" segments the machine is live. Nothing the student does is saved: no
// branches, no sync, no room. The attempt exists only so that the teacher's tile turns to "work" and
// "Завершити урок" has something to complete. Outside React, like `AttemptSession`.

import { read_journal } from "@core/core/journal.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import type { Assignment, Attempt, JournalRef, Topology } from "@shared/api";
import { describeError } from "@/lib/api";
import { SessionStateError, type ApiFn } from "./attempt-session";
import type { HubSession } from "./hub";
import { LessonRun, type LessonMachine, type LessonView } from "./lesson-run";
import { MachineRuntime, type RuntimeView } from "./machine-runtime";
import type { MachineLike } from "./machine-types";

export interface LessonDeps {
  api: ApiFn;
  createMachine(options: MachineOptions): MachineLike & LessonMachine;
  /** URL prefix the core resolves image files against (`GET /api/images`). */
  loadImagesRoot(): Promise<string>;
  /** The memory the machine may keep for its snapshots. */
  snapshotBytes: number;
}

export interface LessonSessionView {
  readonly phase: "loading" | "ready" | "failed";
  readonly error: string | null;
  readonly assignment: Assignment | null;
  readonly attempt: Attempt | null;
  readonly machine: RuntimeView | null;
  readonly lesson: LessonView | null;
  readonly completing: boolean;
}

export const INITIAL_LESSON_VIEW: LessonSessionView = {
  phase: "loading",
  error: null,
  assignment: null,
  attempt: null,
  machine: null,
  lesson: null,
  completing: false,
};

const SNAP_EVERY_MS = 15_000;
const CHECK_EVERY_MS = 10_000;
const DEAD_TEXT = "Машина зупинилась через помилку";

/** Where the lesson comes from: a student's assignment, or a library item that the teacher previews (no attempt, nothing saved). */
export type LessonSource = { kind: "assignment"; id: number } | { kind: "item"; id: number };

interface LessonSubject {
  kind: string;
  topology: Topology;
  journals: readonly JournalRef[];
}

export class LessonSession implements HubSession {
  readonly source: LessonSource;
  readonly #deps: LessonDeps;
  readonly #listeners = new Set<() => void>();
  #unsubscribe: (() => void)[] = [];
  #runtime: MachineRuntime | null = null;
  #run: LessonRun | null = null;
  #generation = 0;
  #started = false;
  #phase: LessonSessionView["phase"] = "loading";
  #error: string | null = null;
  #assignment: Assignment | null = null;
  #attempt: Attempt | null = null;
  #completing = false;
  #view: LessonSessionView = INITIAL_LESSON_VIEW;

  constructor(source: LessonSource, deps: LessonDeps) {
    this.source = source;
    this.#deps = deps;
    this.#view = this.#compute();
  }

  getSnapshot = (): LessonSessionView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Starts loading and booting. Safe to call twice. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#boot();
  }

  runtime(): MachineRuntime | null {
    return this.#runtime;
  }

  retry(): Promise<void> {
    return this.#run?.retry() ?? Promise.resolve();
  }

  showSolution(): Promise<void> {
    return this.#run?.showSolution() ?? Promise.resolve();
  }

  next(): Promise<void> {
    return this.#run?.next() ?? Promise.resolve();
  }

  /** "Почати урок знову" after a failure: the machine is dropped and the lesson boots from its beginning. */
  restart(): void {
    this.#generation++;
    this.#teardown();
    void this.#boot();
  }

  /** "Завершити урок": the first call sets the time of the attempt. */
  async complete(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || this.#completing) return;
    this.#completing = true;
    this.#publish();
    try {
      this.#attempt = await this.#deps.api("POST /api/attempts/:id/complete", { params: { id: attempt.id } });
    } finally {
      this.#completing = false;
      this.#publish();
    }
  }

  dispose(): void {
    this.#generation++;
    this.#teardown();
    this.#listeners.clear();
  }

  async #boot(): Promise<void> {
    const generation = this.#generation;
    this.#phase = "loading";
    this.#error = null;
    this.#publish();
    try {
      const { assignment, attempt, node, raw } = await this.#load();
      const root = await this.#deps.loadImagesRoot();
      const journal = read_journal(raw);
      if (this.#generation !== generation) return;
      const machine = this.#deps.createMachine({
        root,
        journal,
        on_journal_end: "pause",
        snap_every_ms: SNAP_EVERY_MS,
        check_every_ms: CHECK_EVERY_MS,
        name: node.id,
        max_bytes: this.#deps.snapshotBytes,
        timeline_only: true,
      });
      this.#runtime = new MachineRuntime({
        node: node.id,
        title: node.title ?? node.id,
        machine,
        fresh: false,
        context: "player",
      });
      this.#run = new LessonRun(machine, journal);
      this.#unsubscribe.push(this.#runtime.subscribe(() => this.#publish()), this.#run.subscribe(() => this.#publish()));
      this.#assignment = assignment;
      this.#attempt = attempt;
      this.#phase = "ready";
      this.#publish();
      await this.#run.begin();
    } catch (error) {
      if (this.#generation !== generation) return;
      this.#phase = "failed";
      this.#error = error instanceof SessionStateError ? error.message : describeError(error);
      this.#publish();
    }
  }

  /** The assignment of a student opens an attempt; a preview of a library item has none. */
  async #load(): Promise<{ assignment: Assignment | null; attempt: Attempt | null; node: Topology["machines"][number]; raw: unknown }> {
    const { api } = this.#deps;
    const { source } = this;
    if (source.kind === "item") {
      const item = await api("GET /api/library/:id", { params: { id: source.id } });
      const node = lessonNode(item);
      const raw = await api("GET /api/library/:id/journals/:node", { params: { id: item.id, node: node.id }, query: { role: "start" } });
      return { assignment: null, attempt: null, node, raw };
    }
    const assignment = await api("GET /api/assignments/:id", { params: { id: source.id } });
    const node = lessonNode(assignment);
    const attempt = await api("POST /api/assignments/:id/attempt", { params: { id: source.id } });
    const raw = await api("GET /api/assignments/:id/journals/:node", {
      params: { id: assignment.id, node: node.id },
      query: { role: "start" },
    });
    return { assignment, attempt, node, raw };
  }

  #compute(): LessonSessionView {
    const machine = this.#runtime?.getView() ?? null;
    const dead = machine?.state === "failed" ? (machine.error ?? DEAD_TEXT) : null;
    return {
      phase: dead !== null && this.#phase === "ready" ? "failed" : this.#phase,
      error: this.#error ?? dead,
      assignment: this.#assignment,
      attempt: this.#attempt,
      machine,
      lesson: this.#run?.getSnapshot() ?? null,
      completing: this.#completing,
    };
  }

  #publish(): void {
    this.#view = this.#compute();
    for (const listener of [...this.#listeners]) listener();
  }

  #teardown(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#runtime?.dispose();
    this.#runtime = null;
    this.#run = null;
    this.#assignment = null;
    this.#attempt = null;
  }
}

/** The one machine of a lesson; a lesson without a teacher's journal cannot be played. */
function lessonNode(subject: LessonSubject): Topology["machines"][number] {
  const [machine, ...rest] = subject.topology.machines;
  if (subject.kind !== "lesson" || !machine || rest.length > 0) {
    throw new SessionStateError("Урок має містити рівно одну машину");
  }
  if (!subject.journals.some((ref) => ref.node === machine.id && ref.role === "start")) {
    throw new SessionStateError("В уроку немає журналу викладача");
  }
  return machine;
}
