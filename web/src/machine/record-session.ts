// The recording of a broken state: the machines of a task's topology run live in the teacher's
// browser, from the start journals when there are any, and their journals are saved as the start or the reference
// ones. No server room, no branches, no autosave: nothing is kept until the teacher saves. Outside React, like
// `LessonSession`.

import { read_journal, type Journal } from "@core/core/journal.mjs";
import type { MachineOptions } from "@core/machine/machine.mjs";
import { build_topology, fill_setup, validate_topology, type Topology } from "@core/net/topology.mjs";
import { checked_journals, launch_topology } from "@core/net/topology_journals.mjs";
import type { JournalRole, LibraryItem } from "@shared/api";
import { describeError } from "@/lib/api";
import { SessionStateError, whenLive, type ApiFn } from "./attempt-session";
import type { HubSession } from "./hub";
import { MachineRuntime, type RuntimeView } from "./machine-runtime";
import type { MachineLike } from "./machine-types";
import { saveFailureText } from "./record-plan";

export interface RecordDeps {
  api: ApiFn;
  createMachine(options: MachineOptions): MachineLike;
  /** URL prefix the core resolves image files against (`GET /api/images`). */
  loadImagesRoot(): Promise<string>;
  randomMac(): string;
}

export interface RecordView {
  readonly phase: "loading" | "ready" | "failed";
  readonly error: string | null;
  /** The item as the server has it; replaced by the answer of the last saved journal. */
  readonly item: LibraryItem | null;
  readonly machines: readonly RuntimeView[];
  readonly saving: boolean;
}

export const INITIAL_RECORD_VIEW: RecordView = { phase: "loading", error: null, item: null, machines: [], saving: false };

export interface SavedRecording {
  item: LibraryItem;
  count: number;
}

const CHECK_EVERY_MS = 10_000;
const NOT_READY_TEXT = "Машини ще не готові. Зачекайте, поки з'явиться запрошення оболонки";

export class RecordSession implements HubSession {
  readonly itemId: number;
  readonly #deps: RecordDeps;
  readonly #listeners = new Set<() => void>();
  /** node -> events in the start journal the machine began from: what comes after them is the teacher's own. */
  readonly #startEvents = new Map<string, number>();
  #runtimes: MachineRuntime[] = [];
  #unsubscribe: (() => void)[] = [];
  #teardownNet: (() => void) | null = null;
  #generation = 0;
  #started = false;
  #phase: RecordView["phase"] = "loading";
  #error: string | null = null;
  #item: LibraryItem | null = null;
  #saving = false;
  #view: RecordView = INITIAL_RECORD_VIEW;

  constructor(itemId: number, deps: RecordDeps) {
    this.itemId = itemId;
    this.#deps = deps;
    this.#view = this.#compute();
  }

  getSnapshot = (): RecordView => this.#view;

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

  runtime(node: string): MachineRuntime | undefined {
    return this.#runtimes.find((runtime) => runtime.node === node);
  }

  /** True when the teacher typed into a machine after its start journal: leaving would lose that. */
  hasInput(): boolean {
    return this.#runtimes.some((runtime) => {
      const from = this.#startEvents.get(runtime.node) ?? 0;
      return runtime.machine.mirror.slice(from).some((event) => event.t === "serial" && event.by === undefined && (event.p ?? 0) === 0);
    });
  }

  /**
   * Every machine's journal ends with `check`, then each is sent as the `role` journal of its machine. A refusal in the
   * middle stops the sending; what was sent stays, and the error names it.
   */
  async save(role: JournalRole): Promise<SavedRecording> {
    const item = this.#item;
    if (this.#saving || !item || this.#phase !== "ready") throw new SessionStateError(NOT_READY_TEXT);
    if (this.#runtimes.length === 0 || this.#runtimes.some((runtime) => runtime.state !== "live")) {
      throw new SessionStateError(NOT_READY_TEXT);
    }
    this.#saving = true;
    this.#publish();
    try {
      const journals = await checked_journals(this.#runtimes.map((runtime) => [runtime.node, runtime.machine] as const));
      const saved: string[] = [];
      let latest = item;
      for (const [index, runtime] of this.#runtimes.entries()) {
        const journal = journals[index];
        if (journal === undefined) throw new SessionStateError(saveFailureText(runtime.node, saved, "журнал не знято"));
        try {
          latest = await this.#deps.api("PUT /api/library/:id/journals/:node", {
            params: { id: item.id, node: runtime.node },
            query: { role },
            body: journal,
          });
        } catch (error) {
          throw new SessionStateError(saveFailureText(runtime.node, saved, describeError(error)));
        }
        saved.push(runtime.node);
      }
      this.#item = latest;
      return { item: latest, count: saved.length };
    } finally {
      this.#saving = false;
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
    try {
      const { api } = this.#deps;
      const item = await api("GET /api/library/:id", { params: { id: this.itemId } });
      if (item.kind !== "task") throw new SessionStateError("Записувати початковий стан можна лише для завдання");
      const problems = validate_topology(item.topology);
      if (problems.length > 0) throw new SessionStateError(`Опис топології містить помилки: ${problems.join("; ")}`);
      const root = await this.#deps.loadImagesRoot();
      const journals = new Map<string, Journal>();
      for (const machine of item.topology.machines) {
        if (!item.journals.some((ref) => ref.node === machine.id && ref.role === "start")) continue;
        const journal = read_journal(
          await api("GET /api/library/:id/journals/:node", { params: { id: item.id, node: machine.id }, query: { role: "start" } }),
        );
        journals.set(machine.id, journal);
        this.#startEvents.set(machine.id, journal.events.length);
      }
      if (this.#generation !== generation) return;
      this.#item = item;
      const machines = this.#startMachines(item.topology, root, journals);
      this.#phase = "ready";
      this.#publish();
      await launch_topology(machines, [...journals.keys()]);
      if (this.#generation !== generation) return;
      await Promise.all(
        this.#runtimes.map(async (runtime) => {
          runtime.holdInput();
          await whenLive(runtime.machine);
          await runtime.beginSession(this.#setupFor(item.topology, runtime.node));
        }),
      );
    } catch (error) {
      if (this.#generation !== generation) return;
      this.#phase = "failed";
      this.#error = error instanceof SessionStateError ? error.message : describeError(error);
      this.#publish();
    }
  }

  #startMachines(topology: Topology, root: string, journals: Map<string, Journal>): Map<string, MachineLike> {
    const net = build_topology(topology, {
      create_machine: (desc) => {
        const common = { root, check_every_ms: CHECK_EVERY_MS, name: desc.id };
        const journal = journals.get(desc.id);
        const machine = this.#deps.createMachine(
          journal
            ? { ...common, journal, on_journal_end: "pause" }
            : { ...common, profile: desc.profile, on_journal_end: "live" },
        );
        this.#runtimes.push(new MachineRuntime({ node: desc.id, title: desc.title ?? desc.id, machine, fresh: journal === undefined }));
        return machine;
      },
    });
    this.#teardownNet = () => net.teardown();
    for (const runtime of this.#runtimes) this.#unsubscribe.push(runtime.subscribe(() => this.#publish()));
    return new Map(this.#runtimes.map((runtime) => [runtime.node, runtime.machine]));
  }

  /** The same setup command a student's attempt would run, with a random MAC. */
  #setupFor(topology: Topology, node: string): string | null {
    const setup = topology.machines.find((machine) => machine.id === node)?.setup;
    return setup ? fill_setup(setup, this.#deps.randomMac()).replaceAll("{n}", "1") : null;
  }

  #compute(): RecordView {
    const machines = this.#runtimes.map((runtime) => runtime.getView());
    const dead = machines.find((machine) => machine.state === "failed");
    return {
      phase: dead !== undefined && this.#phase === "ready" ? "failed" : this.#phase,
      error: this.#error ?? (dead ? (dead.error ?? `Машина ${dead.node} зупинилась через помилку`) : null),
      item: this.#item,
      machines,
      saving: this.#saving,
    };
  }

  #publish(): void {
    this.#view = this.#compute();
    for (const listener of [...this.#listeners]) listener();
  }

  #teardown(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const runtime of this.#runtimes) runtime.dispose();
    this.#runtimes = [];
    this.#teardownNet?.();
    this.#teardownNet = null;
  }
}
