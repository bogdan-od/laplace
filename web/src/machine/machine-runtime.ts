// One machine on screen: its console output, the state shown over the terminal, the setup of the guest,
// the journal sync. Created and driven by an `AttemptSession`; the terminal component only reads it.

import type { Journal } from "@core/core/journal.mjs";
import type { SerialPort } from "@shared/ws";
import { JournalSync, type SyncState } from "./journal-sync";
import type { MachineLike } from "./machine-types";
import { OutputBuffer } from "./output-buffer";
import type { OutputEvent, RoomEndpoint } from "./room-link";
import {
  WAITING_TIMEOUT_MS,
  canType,
  cursorHidden,
  deriveState,
  overlayText,
  replayPercent,
  type MachineUiState,
  type UiContext,
} from "./states";

/** The guest setup the student sees the result of: the address line appears only after the agent answered. */
export type NetworkPhase = "none" | "pending" | "ready" | "failed";

export interface RuntimeView {
  readonly node: string;
  readonly title: string;
  readonly state: MachineUiState;
  readonly percent: number;
  /** Text over the terminal; null when the machine is live. */
  readonly overlay: string | null;
  readonly cursorHidden: boolean;
  readonly canType: boolean;
  /** The session start (date, network setup) has not answered yet: the terminal takes no input. */
  readonly settingUp: boolean;
  /** Reason of the final failure. */
  readonly error: string | null;
  /** A problem that is not fatal (the setup command got no answer, for example). */
  readonly notice: string | null;
  readonly network: NetworkPhase;
  /** The setup command that configured the network of the guest (MAC filled in); null without one. */
  readonly setup: string | null;
  readonly sync: SyncState | null;
  readonly branchId: number | null;
  /** The machine started from nothing: input typed before the first status is queued, not lost. */
  readonly fresh: boolean;
}

export interface RuntimeOptions {
  node: string;
  title: string;
  machine: MachineLike;
  fresh: boolean;
  /** "player": a replaying machine shows no restore overlay and takes no input (a lesson). Default "attempt". */
  context?: UiContext;
}

const OUTPUT_BYTES = 1 << 20;
const TEACHER_OUTPUT_BYTES = 1 << 18;
const SETUP_REFUSED = "Налаштування мережі не виконано";
const SETUP_OUTPUT_CHARS = 200;

export class MachineRuntime {
  readonly node: string;
  readonly title: string;
  readonly machine: MachineLike;
  readonly fresh: boolean;
  readonly context: UiContext;
  readonly output = new OutputBuffer(OUTPUT_BYTES);
  readonly teacherOutput = new OutputBuffer(TEACHER_OUTPUT_BYTES);
  sync: JournalSync | null = null;
  readonly #outputListeners = new Set<(event: OutputEvent) => void>();
  readonly #viewListeners = new Set<() => void>();
  #unsubscribeSync: (() => void) | null = null;
  #view: RuntimeView;
  #frozen = false;
  #pausedByUs = false;
  #error: string | null = null;
  #notice: string | null = null;
  #network: NetworkPhase = "none";
  #settingUp = false;
  #setup: string | null = null;
  #waitingTimer: ReturnType<typeof setTimeout> | null = null;
  #waitingTimedOut = false;
  #disposed = false;

  constructor(options: RuntimeOptions) {
    this.node = options.node;
    this.title = options.title;
    this.machine = options.machine;
    this.fresh = options.fresh;
    this.context = options.context ?? "attempt";
    this.#view = this.#compute();
    const { machine } = this;
    machine.on("serial", (bytes) => {
      this.output.push(bytes);
      this.#emitOutput({ kind: "data", port: 0, bytes });
    });
    machine.on("teacher_output", (bytes) => {
      this.teacherOutput.push(bytes);
      this.#emitOutput({ kind: "data", port: 2, bytes });
    });
    // The machine re-emits the console it kept after a reset, so the retained copy starts over.
    machine.on("reset", () => {
      this.output.clear();
      this.#emitOutput({ kind: "reset" });
    });
    machine.on("status", () => this.#update());
    machine.on("end", () => this.#update());
    machine.on("recovering", () => this.#update());
    machine.on("recovered", () => {
      this.#notice = null;
      this.#update();
    });
    machine.on("error", (message) => {
      // A command without an answer also arrives here; only a dead machine is a final failure.
      if (machine.dead) this.#error = message;
      else this.#notice = message;
      this.#update();
    });
  }

  getView = (): RuntimeView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#viewListeners.add(listener);
    return () => this.#viewListeners.delete(listener);
  };

  subscribeOutput = (listener: (event: OutputEvent) => void): (() => void) => {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  };

  get state(): MachineUiState {
    return this.#view.state;
  }

  /** Input from the student's terminal. False when the state of the machine does not accept it. */
  type(data: string): boolean {
    if (!this.#view.canType) return false;
    this.machine.type(data);
    return true;
  }

  /** Input from the teacher: only into a live machine. */
  teacherInput(port: SerialPort, data: string): boolean {
    if (this.#view.state !== "live" || this.#settingUp) return false;
    if (port === 0) this.machine.type(data, "teacher");
    else this.machine.teacher_input(data);
    return true;
  }

  endpoint(): RoomEndpoint {
    return {
      node: this.node,
      subscribe: this.subscribeOutput,
      history: (port, maxBytes) => (port === 0 ? this.output : this.teacherOutput).tail(maxBytes),
      teacherInput: (port, data) => void this.teacherInput(port, data),
    };
  }

  setFrozen(frozen: boolean): void {
    if (this.#frozen === frozen) return;
    this.#frozen = frozen;
    if (frozen && !this.machine.user_paused) {
      this.machine.pause();
      this.#pausedByUs = true;
    } else if (!frozen && this.#pausedByUs) {
      this.machine.resume();
      this.#pausedByUs = false;
    }
    this.#update();
  }

  /**
   * Starts the saving of the journal into `branchId`. `saved` is how many events the server has there.
   * Replaces a sync that was attached before.
   */
  attachSync(sync: JournalSync): void {
    this.detachSync();
    this.sync = sync;
    this.#unsubscribeSync = sync.subscribe(() => this.#update());
    sync.start();
    this.#update();
  }

  detachSync(): void {
    this.sync?.stop();
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.sync = null;
    this.#update();
  }

  /**
   * The start of a live session: the date and a fresh random seed of the guest,
   * then the setup command through the system channel. The address line is shown only after the answer.
   */
  async beginSession(setupCommand: string | null): Promise<void> {
    this.#network = setupCommand === null ? "none" : "pending";
    this.#setup = setupCommand;
    this.holdInput();
    try {
      await this.#runSessionStart(setupCommand);
    } finally {
      this.#settingUp = false;
      this.#update();
    }
  }

  /**
   * The terminal takes no input until `beginSession` has finished: a command typed earlier (`ifconfig eth0 ... up`) would
   * run before the setup's `ifconfig eth0 hw ether`, which then fails with "Device or resource busy". Call it at the start
   * of a launch, so the time before the machine is live is covered too.
   */
  holdInput(): void {
    this.#settingUp = true;
    this.#update();
  }

  async #runSessionStart(setupCommand: string | null): Promise<void> {
    await this.machine.begin_session();
    if (setupCommand === null || this.#disposed) return;
    const result = await this.machine.run_setup(setupCommand);
    if (this.#disposed) return;
    // No answer already arrived as the machine's error (the notice); a nonzero code is the guest's own refusal,
    // e.g. `ifconfig ... hw ether` on an interface that is up: the MAC on the tile would not be the guest's.
    const refused = result !== null && result.rc !== 0;
    if (refused) this.#notice = `${SETUP_REFUSED} (код ${result.rc}): ${String(result.output).trim().slice(0, SETUP_OUTPUT_CHARS)}`;
    this.#network = result === null || refused ? "failed" : "ready";
  }

  /** The journal as the machine has it now (asks the Worker; a dead machine answers from the copy). */
  journal(): Promise<Journal> {
    return this.machine.journal();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearWaiting();
    // Last save before the Worker goes away; the copy of the journal stays readable after stop().
    void this.sync?.flushAndStop();
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.machine.stop();
  }

  #emitOutput(event: OutputEvent): void {
    for (const listener of [...this.#outputListeners]) listener(event);
  }

  #compute(): RuntimeView {
    const { machine } = this;
    const status = machine.status;
    const state = deriveState({
      status,
      recovering: machine.recovering,
      dead: machine.dead,
      frozen: this.#frozen,
      context: this.context,
    });
    const percent = replayPercent(status);
    const sync = this.sync?.getState() ?? null;
    return {
      node: this.node,
      title: this.title,
      state,
      percent,
      overlay: overlayText(state, { percent, waitingTimedOut: this.#waitingTimedOut, error: this.#error }),
      cursorHidden: cursorHidden(state),
      canType: canType(state, this.fresh) && !this.#settingUp,
      settingUp: this.#settingUp,
      error: this.#error,
      notice: this.#notice,
      network: this.#network,
      setup: this.#setup,
      sync,
      branchId: this.sync?.branchId ?? null,
      fresh: this.fresh,
    };
  }

  #update(): void {
    if (this.#disposed) return;
    const next = this.#compute();
    this.#trackWaiting(next.state);
    if (sameView(this.#view, next)) return;
    this.#view = next;
    for (const listener of [...this.#viewListeners]) listener();
  }

  #trackWaiting(state: MachineUiState): void {
    if (state === "waiting") {
      this.#waitingTimer ??= setTimeout(() => {
        this.#waitingTimer = null;
        this.#waitingTimedOut = true;
        this.#update();
      }, WAITING_TIMEOUT_MS);
    } else {
      this.#clearWaiting();
    }
  }

  #clearWaiting(): void {
    if (this.#waitingTimer !== null) clearTimeout(this.#waitingTimer);
    this.#waitingTimer = null;
    this.#waitingTimedOut = false;
  }
}

function sameView(a: RuntimeView, b: RuntimeView): boolean {
  return (
    a.state === b.state &&
    a.percent === b.percent &&
    a.overlay === b.overlay &&
    a.error === b.error &&
    a.notice === b.notice &&
    a.network === b.network &&
    a.setup === b.setup &&
    a.sync === b.sync &&
    a.branchId === b.branchId
  );
}
