// The course of a lesson without a DOM: the teacher's journal plays at 1x,
// at the start of a "now on your own" segment the machine becomes live. The student's input on a segment
// is saved nowhere. The state goes to React through `subscribe`/`getSnapshot`.

import type { Journal, LessonNote, LessonSelf } from "@core/core/journal.mjs";
import type { Machine } from "@core/machine/machine.mjs";

/** The part of `Machine` a lesson drives; tests pass a fake. */
export type LessonMachine = Pick<Machine, "on" | "start" | "limit" | "play_segment">;

export type LessonPhase = "play" | "student" | "retry" | "solution" | "solved" | "done";

export interface LessonView {
  readonly phase: LessonPhase;
  /** Index of the current segment; equals `segments.length` when all are passed. */
  readonly index: number;
  /** Texts of the "now on your own" segments, in order. */
  readonly segments: readonly string[];
  /** The task of the current segment, shown in the phases of the segment only. */
  readonly task: string | null;
  /** The last note at or before the replay position. */
  readonly note: string | null;
  /** "Спробувати знову" and "Показати розв'язок" are available. */
  readonly canAct: boolean;
  /** "Далі" is available. */
  readonly canNext: boolean;
}

const SEGMENT_PHASES: readonly LessonPhase[] = ["student", "retry", "solution", "solved"];
const ACTIVE_PHASES: readonly LessonPhase[] = ["student", "solved"];

export class LessonRun {
  readonly #machine: LessonMachine;
  readonly #total: number;
  readonly #notes: LessonNote[];
  readonly #selfs: LessonSelf[];
  readonly #segments: readonly string[];
  readonly #listeners = new Set<() => void>();
  #index = 0;
  #phase: LessonPhase = "play";
  #note: string | null = null;
  #view: LessonView;

  constructor(machine: LessonMachine, journal: Pick<Journal, "header" | "events">) {
    const marks = journal.header.lesson ?? [];
    this.#machine = machine;
    this.#total = journal.events.length;
    this.#notes = marks.filter((mark): mark is LessonNote => mark.t === "note").sort((a, b) => a.at - b.at);
    this.#selfs = marks.filter((mark): mark is LessonSelf => mark.t === "self").sort((a, b) => a.from - b.from);
    this.#segments = this.#selfs.map((item) => item.text);
    this.#view = this.#compute();
  }

  getSnapshot = (): LessonView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Limits the replay to the first segment and starts the machine; rejects when the start fails. */
  async begin(): Promise<void> {
    const first = this.#selfs[0];
    this.#machine.limit(first ? first.from : this.#total, Boolean(first));
    this.#machine.on("end", () => this.#arrived());
    this.#machine.on("status", (status) => this.#showNote(status.next));
    this.#enter("play");
    const reply = await this.#machine.start();
    if (reply.status.mode === "live") this.#arrived();
  }

  /** "Спробувати знову": the segment again from its start. */
  async retry(): Promise<void> {
    const segment = this.#selfs[this.#index];
    if (!segment || !ACTIVE_PHASES.includes(this.#phase)) return;
    this.#enter("retry");
    await this.#machine.play_segment({ from: segment.from, stop: segment.from, live_at_stop: true });
  }

  /** "Показати розв'язок": the teacher's way through the segment, at 1x. */
  async showSolution(): Promise<void> {
    const segment = this.#selfs[this.#index];
    if (!segment || !ACTIVE_PHASES.includes(this.#phase)) return;
    this.#enter("solution");
    await this.#machine.play_segment({ from: segment.from, stop: segment.to, live_at_stop: false });
  }

  /** "Далі": from the end of the segment to the next one, or to the end of the journal. */
  async next(): Promise<void> {
    const segment = this.#selfs[this.#index];
    if (!segment || this.#phase !== "solved") return;
    this.#index += 1;
    const following = this.#selfs[this.#index];
    this.#enter("play");
    await this.#machine.play_segment({
      from: segment.to,
      stop: following ? following.from : this.#total,
      live_at_stop: Boolean(following),
    });
  }

  #arrived(): void {
    if (this.#phase === "solution") {
      this.#enter("solved");
      return;
    }
    this.#enter(this.#selfs[this.#index] ? "student" : "done");
  }

  #enter(phase: LessonPhase): void {
    this.#phase = phase;
    this.#publish();
  }

  #showNote(next: number): void {
    const note = this.#notes.findLast((item) => item.at <= next)?.text ?? null;
    if (note === this.#note) return;
    this.#note = note;
    this.#publish();
  }

  #compute(): LessonView {
    const phase = this.#phase;
    const task = this.#selfs[this.#index]?.text ?? null;
    return {
      phase,
      index: this.#index,
      segments: this.#segments,
      task: SEGMENT_PHASES.includes(phase) ? task : null,
      note: this.#note,
      canAct: task !== null && ACTIVE_PHASES.includes(phase),
      canNext: task !== null && phase === "solved",
    };
  }

  #publish(): void {
    this.#view = this.#compute();
    for (const listener of [...this.#listeners]) listener();
  }
}
