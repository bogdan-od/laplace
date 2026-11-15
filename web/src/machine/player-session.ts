// The player: one journal replayed on a machine, with the position, the speed, jumps by
// commands and the marks. Outside React, like `LessonSession`; `getSnapshot`/`subscribe` feed `usePlayer`.
// The journal is only watched: the machine never goes live here, and typing into it is dropped (`context: "player"`).

import { event_times, read_journal, type Journal } from "@core/core/journal.mjs";
import type { Machine, MachineOptions } from "@core/machine/machine.mjs";
import type { Branch, ClipBody, Comment, HelpRequest, LibraryItem, TeacherInput } from "@shared/api";
import { describeError } from "@/lib/api";
import type { ApiFn } from "./attempt-session";
import type { ClipSource } from "./clip";
import { forkBody, type BranchInfo, type ForkChoice } from "./continue-from";
import type { HubSession } from "./hub";
import { MachineRuntime, type RuntimeView } from "./machine-runtime";
import type { MachineLike } from "./machine-types";
import { buildPcap, countNetFrames } from "./pcap";
import type { PlaySource } from "./play-source";
import {
  buildTimeline,
  commentMarks,
  currentCommand,
  eventCountAt,
  mergeMarks,
  momentTime,
  rollbackPoints,
  stepTarget,
  type PlayerCommand,
  type PlayerMark,
  type Timeline,
} from "./player-marks";

/** 0 is the core's "as fast as possible". */
export type PlayerSpeed = 1 | 4 | 0;

export type PlayerMachine = MachineLike & Pick<Machine, "seek">;

export interface PlayerDeps {
  api: ApiFn;
  createMachine(options: MachineOptions): PlayerMachine;
  /** URL prefix the core resolves image files against (`GET /api/images`). */
  loadImagesRoot(): Promise<string>;
  /** The memory the machine may keep for its snapshots. */
  snapshotBytes: number;
}

export interface PlayerView {
  readonly phase: "loading" | "ready" | "failed";
  readonly error: string | null;
  /** A problem that does not stop the player (a seek that failed). */
  readonly notice: string | null;
  readonly title: string;
  readonly subtitle: string;
  readonly machine: RuntimeView | null;
  /** Guest ms. */
  readonly duration: number;
  /** Guest ms; the target of the seek while one runs. */
  readonly position: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly speed: PlayerSpeed;
  readonly commands: readonly PlayerCommand[];
  readonly marks: readonly PlayerMark[];
  /** Index into `commands` of the command the position is on; -1 before the first. */
  readonly current: number;
  /** Events up to `position`: where a fork from here breaks the journal. */
  readonly eventCount: number;
  /** The attempt of the played branch; null for any other source. */
  readonly branch: BranchInfo | null;
  /** The branch a clip can be cut from (a branch, or a submission machine that names its branch); null otherwise. */
  readonly clip: ClipSource | null;
  /** Frames that arrived at the machine: the traffic file is empty without them. */
  readonly netFrames: number;
}

export interface SeekOptions {
  /** Play on after the seek (default: only if the machine was playing). */
  resume?: boolean;
}

export const INITIAL_PLAYER_VIEW: PlayerView = {
  phase: "loading",
  error: null,
  notice: null,
  title: "",
  subtitle: "",
  machine: null,
  duration: 0,
  position: 0,
  paused: true,
  ended: false,
  seeking: false,
  speed: 1,
  commands: [],
  marks: [],
  current: -1,
  eventCount: 0,
  branch: null,
  clip: null,
  netFrames: 0,
};

const SNAP_EVERY_MS = 15_000;
const CHECK_EVERY_MS = 10_000;

interface Loaded {
  journal: Journal;
  title: string;
  subtitle: string;
  node: string;
  teacherInputs: TeacherInput[];
  help: HelpRequest[];
  /** `rollbackPoints` of the played branch. */
  rollbacks?: number[];
  comments: Comment[];
  branch: BranchInfo | null;
  clip: ClipSource | null;
  /** Where the recording starts when the address has no `?t=` (the start of a clip). */
  fromMs: number | null;
}

function sameView(a: PlayerView, b: PlayerView): boolean {
  return (Object.keys(a) as (keyof PlayerView)[]).every((key) => a[key] === b[key]);
}

export class PlayerSession implements HubSession {
  readonly source: PlaySource;
  readonly #deps: PlayerDeps;
  readonly #startMs: number | null;
  readonly #listeners = new Set<() => void>();
  #started = false;
  #disposed = false;
  #phase: PlayerView["phase"] = "loading";
  #error: string | null = null;
  #notice: string | null = null;
  #title = "";
  #subtitle = "";
  #machine: PlayerMachine | null = null;
  #runtime: MachineRuntime | null = null;
  #timeline: Timeline | null = null;
  #journal: Journal | null = null;
  #comments: Comment[] = [];
  #branch: BranchInfo | null = null;
  #clip: ClipSource | null = null;
  #netFrames = 0;
  #start: number | null;
  #node = "";
  #marks: readonly PlayerMark[] = [];
  #speed: PlayerSpeed = 1;
  /** The newest position asked for while a seek runs; seeks that arrive meanwhile merge into it. */
  #pending: number | null = null;
  #target: number | null = null;
  /** Where the last seek ended, while the machine stands there: its own status may lag and still name the old place. */
  #anchor: number | null = null;
  #seeking: Promise<void> | null = null;
  #resumeAfter = false;
  /** False until `machine.start()` has resolved: a seek before that would restart the worker that is still starting. */
  #running = false;
  /** Until the machine has reached `?t=`: the player already stands there, whatever the booting machine reports. */
  #opening = false;
  #view: PlayerView = INITIAL_PLAYER_VIEW;

  constructor(source: PlaySource, deps: PlayerDeps, startMs: number | null) {
    this.source = source;
    this.#deps = deps;
    this.#startMs = startMs;
    this.#start = startMs;
  }

  getSnapshot = (): PlayerView => this.#view;

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

  toggle(): void {
    if (this.#view.paused) this.play();
    else this.pause();
  }

  /** Plays on; at the end of the journal it plays again from the start. */
  play(): void {
    const machine = this.#machine;
    if (!machine || this.#opening) return;
    if (this.#seeking) {
      this.#resumeAfter = true;
    } else if (this.#view.ended) {
      void this.seek(0, { resume: true });
      return;
    } else {
      this.#anchor = null;
      machine.resume();
    }
    this.#publish();
  }

  pause(): void {
    if (!this.#machine) return;
    if (this.#seeking) this.#resumeAfter = false;
    this.#machine.pause();
    this.#publish();
  }

  setSpeed(speed: PlayerSpeed): void {
    this.#speed = speed;
    this.#machine?.set_speed(speed);
    this.#publish();
  }

  /**
   * Moves the machine to guest time `ms`. A call that comes while a seek runs does not start another one: the
   * running seek is followed by one to the newest position, so the last call wins. Resolves when the machine is there.
   */
  seek(ms: number, options: SeekOptions = {}): Promise<void> {
    const machine = this.#machine;
    const timeline = this.#timeline;
    if (!machine || !timeline || this.#disposed) return Promise.resolve();
    const target = Math.min(Math.max(0, ms), timeline.duration);
    if (!this.#running) {
      // The machine is still starting: the boot goes there as soon as it can, as it does for `?t=`.
      this.#start = target;
      this.#opening = true;
      this.#publish();
      return Promise.resolve();
    }
    this.#pending = target;
    this.#target = target;
    if (this.#seeking === null) {
      this.#resumeAfter = options.resume ?? !this.#view.paused;
      this.#seeking = this.#drain(machine);
    } else if (options.resume !== undefined) {
      this.#resumeAfter = options.resume;
    }
    this.#publish();
    return this.#seeking;
  }

  /** A click on a command or a mark: the machine stands still at the moment. */
  goToMark(mark: PlayerMark): Promise<void> {
    return this.seek(mark.target, { resume: false });
  }

  /** "→" (1) and "←" (-1): the next or previous command. */
  step(direction: 1 | -1): Promise<void> {
    const target = stepTarget(this.#view.commands, this.#view.position, direction);
    return target === null ? Promise.resolve() : this.seek(target, { resume: false });
  }

  /**
   * Makes the fork the viewer chose (`chooseFork`): a branch of the attempt that goes on from the position. A `reply`
   * is then recorded as the answer to its request. Resolves with the new branch.
   */
  async fork(choice: ForkChoice): Promise<Branch> {
    const info = this.#branch;
    const journal = this.#journal;
    if (!info || !journal) throw new Error("Запис ще не завантажено");
    const { api } = this.#deps;
    const body = forkBody(info, journal, choice, new Date().toISOString());
    const branch = await api("POST /api/attempts/:id/branches", { params: { id: info.attemptId }, body });
    if (choice.kind === "reply" && choice.help) {
      await api("POST /api/help/:id/reply", { params: { id: choice.help.id }, body: { branch_id: branch.id } });
    }
    return branch;
  }

  /** A comment of the teacher on the submission at the position of the player. */
  async addComment(text: string): Promise<void> {
    const { source } = this;
    const timeline = this.#timeline;
    if (source.kind !== "submission" || !timeline) throw new Error("Коментувати можна лише здачу");
    const comment = await this.#deps.api("POST /api/submissions/:id/comments", {
      params: { id: source.id },
      body: { node: source.node, event_index: this.#view.eventCount, vtime_ms: this.#view.position, text },
    });
    this.#comments = [...this.#comments, comment];
    this.#reloadMarks();
  }

  async deleteComment(id: number): Promise<void> {
    await this.#deps.api("DELETE /api/comments/:id", { params: { id } });
    this.#comments = this.#comments.filter((comment) => comment.id !== id);
    this.#reloadMarks();
  }

  /** Saves `body` as a clip item of the library (a teacher); `body.branch_id` is `view.clip.branchId`. */
  saveClip(body: ClipBody): Promise<LibraryItem> {
    return this.#deps.api("POST /api/library/clip", { body });
  }

  /** The libpcap file of the frames that arrived at the machine; null before the recording is loaded. */
  pcap(): Uint8Array | null {
    return this.#journal === null ? null : buildPcap(this.#journal, this.#node);
  }

  #reloadMarks(): void {
    const timeline = this.#timeline;
    if (!timeline) return;
    this.#marks = mergeMarks(timeline.marks, commentMarks(this.#comments, this.#node));
    this.#publish();
  }

  dispose(): void {
    this.#disposed = true;
    this.#runtime?.dispose();
    this.#runtime = null;
    this.#machine = null;
    this.#listeners.clear();
  }

  async #drain(machine: PlayerMachine): Promise<void> {
    try {
      let reached = this.#target ?? 0;
      while (this.#pending !== null) {
        const target = this.#pending;
        this.#pending = null;
        reached = (await machine.seek(target)) ?? target;
      }
      if (this.#resumeAfter && !this.#disposed) {
        this.#anchor = null;
        machine.resume();
      } else {
        this.#anchor = Math.round(reached);
      }
      this.#notice = null;
    } catch (error) {
      this.#notice = describeError(error);
    } finally {
      this.#target = null;
      this.#seeking = null;
      this.#publish();
    }
  }

  /** Where the student rolled back on the way to `branch`; the attempt is read only when the branch has a parent. */
  async #rollbackPoints(branch: Branch, attemptId: number): Promise<number[]> {
    if (branch.parent_id === null) return [];
    const attempt = await this.#deps.api("GET /api/attempts/:id", { params: { id: attemptId } });
    return rollbackPoints(attempt.branches, branch.id);
  }

  async #load(): Promise<Loaded> {
    const { api } = this.#deps;
    const { source } = this;
    if (source.kind === "branch") {
      const [raw, detail] = await Promise.all([
        api("GET /api/branches/:id/journal", { params: { id: source.id } }),
        api("GET /api/branches/:id", { params: { id: source.id } }),
      ]);
      const journal = read_journal(raw);
      const times = event_times(journal);
      const node = detail.machine;
      // A request on another branch of the attempt is not a mark of this recording.
      const own = detail.help_requests.filter((item) => item.branch_id === source.id);
      const rollbacks = await this.#rollbackPoints(detail.branch, detail.attempt_id);
      const branch: BranchInfo = {
        branchId: source.id,
        attemptId: detail.attempt_id,
        assignmentId: detail.assignment.id,
        classId: detail.assignment.class_id,
        studentId: detail.student.id,
        node,
        help: own.map((request) => ({ request, time: momentTime(times, request.event_count) })),
      };
      return {
        journal,
        title: detail.assignment.title,
        subtitle: `${detail.student.name} · машина ${node}`,
        node,
        teacherInputs: detail.teacher_inputs,
        help: own,
        rollbacks,
        comments: [],
        branch,
        clip: { branchId: source.id, student: detail.student.name },
        fromMs: null,
      };
    }
    if (source.kind === "item") return this.#loadItem(source);
    if (source.kind === "embed") {
      const payload = await api("GET /api/embed/:token", { params: { token: source.token } });
      const journal = read_journal(payload.journal);
      return {
        journal,
        title: payload.title,
        subtitle: "",
        node: journal.header.machine ?? "",
        teacherInputs: [],
        help: [],
        comments: [],
        branch: null,
        clip: null,
        fromMs: payload.from_ms,
      };
    }
    const [raw, submission] = await Promise.all([
      api("GET /api/submissions/:id/journals/:node", { params: { id: source.id, node: source.node } }),
      api("GET /api/submissions/:id", { params: { id: source.id } }),
    ]);
    return {
      journal: read_journal(raw),
      title: submission.assignment.title,
      subtitle: `${submission.student.name} · машина ${source.node}`,
      node: source.node,
      teacherInputs: submission.teacher_inputs,
      help: [],
      comments: submission.comments,
      branch: null,
      clip: this.#submissionClip(submission.journals, source.node, submission.student.name),
      fromMs: null,
    };
  }

  /** A journal of a library item: the start of a task or a lesson, or the teacher's reference. */
  async #loadItem(source: Extract<PlaySource, { kind: "item" }>): Promise<Loaded> {
    const { api } = this.#deps;
    const [raw, item] = await Promise.all([
      api("GET /api/library/:id/journals/:node", { params: { id: source.id, node: source.node }, query: { role: source.role } }),
      api("GET /api/library/:id", { params: { id: source.id } }),
    ]);
    const role = source.role === "reference" ? "еталон" : "початок";
    return {
      journal: read_journal(raw),
      title: item.title,
      subtitle: `машина ${source.node} · ${role}`,
      node: source.node,
      teacherInputs: [],
      help: [],
      comments: [],
      branch: null,
      clip: null,
      fromMs: item.clip_from_ms,
    };
  }

  #submissionClip(journals: readonly { node: string; branch_id: number }[], node: string, student: string): ClipSource | null {
    const found = journals.find((journal) => journal.node === node);
    return found === undefined ? null : { branchId: found.branch_id, student };
  }

  async #boot(): Promise<void> {
    try {
      const loaded = await this.#load();
      const root = await this.#deps.loadImagesRoot();
      if (this.#disposed) return;
      const { journal } = loaded;
      const machine = this.#deps.createMachine({
        root,
        journal,
        on_journal_end: "pause",
        snap_every_ms: SNAP_EVERY_MS,
        check_every_ms: CHECK_EVERY_MS,
        name: loaded.node || undefined,
        max_bytes: this.#deps.snapshotBytes,
        timeline_only: true,
      });
      this.#machine = machine;
      this.#timeline = buildTimeline({ journal, teacherInputs: loaded.teacherInputs, node: loaded.node, help: loaded.help, rollbacks: loaded.rollbacks });
      this.#journal = journal;
      this.#branch = loaded.branch;
      this.#clip = loaded.clip;
      this.#netFrames = countNetFrames(journal, loaded.node);
      this.#start = this.#startMs ?? loaded.fromMs;
      this.#node = loaded.node;
      this.#comments = loaded.comments;
      this.#marks = mergeMarks(this.#timeline.marks, commentMarks(this.#comments, loaded.node));
      this.#title = loaded.title;
      this.#subtitle = loaded.subtitle;
      this.#runtime = new MachineRuntime({
        node: loaded.node || "machine",
        title: loaded.title,
        machine,
        fresh: false,
        context: "player",
      });
      this.#runtime.subscribe(() => this.#publish());
      machine.on("status", () => this.#publish());
      machine.on("end", () => this.#publish());
      machine.pause();
      this.#opening = this.#start !== null && this.#start > 0;
      this.#phase = "ready";
      this.#publish();
      await machine.start();
      this.#running = true;
      this.#opening = this.#start !== null && this.#start > 0;
      if (this.#opening) await this.seek(this.#start ?? 0, { resume: false });
      this.#opening = false;
      this.#publish();
    } catch (error) {
      if (this.#disposed) return;
      this.#opening = false;
      this.#phase = "failed";
      this.#error = describeError(error);
      this.#publish();
    }
  }

  #compute(): PlayerView {
    const timeline = this.#timeline;
    const machine = this.#machine;
    if (!timeline || !machine) {
      return { ...INITIAL_PLAYER_VIEW, phase: this.#phase, error: this.#error, speed: this.#speed };
    }
    const status = machine.status;
    const { duration } = timeline;
    const ended = status?.ended === true;
    const opening = this.#opening ? Math.min(this.#start ?? 0, duration) : null;
    const position = this.#target ?? this.#anchor ?? opening ?? Math.min(Math.round(status?.vtime ?? 0), duration);
    const seeking = this.#seeking !== null || this.#opening;
    return {
      phase: this.#phase,
      error: this.#error,
      notice: this.#notice,
      title: this.#title,
      subtitle: this.#subtitle,
      machine: this.#runtime?.getView() ?? null,
      duration,
      position,
      paused: seeking ? !this.#resumeAfter : machine.user_paused || ended,
      ended: ended && !seeking,
      seeking,
      speed: this.#speed,
      commands: timeline.commands,
      marks: this.#marks,
      current: currentCommand(timeline.commands, position),
      eventCount: eventCountAt(timeline.times, position),
      branch: this.#branch,
      clip: this.#clip,
      netFrames: this.#netFrames,
    };
  }

  #publish(): void {
    if (this.#disposed) return;
    const next = this.#compute();
    if (sameView(this.#view, next)) return;
    this.#view = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
