// Commands and marks of one journal for the player. Pure functions over the journal and the
// server's records; `PlayerSession` holds the result, the screen draws it.

import { commands, event_times, type Journal, type JournalEvent, type SerialEvent } from "@core/core/journal.mjs";
import type { Branch, Comment, HelpRequest, TeacherInput } from "@shared/api";
import { plural } from "@/lib/format";

/** A student's input event longer than this many characters is a paste (a person types one key per event). */
export const PASTE_MIN_CHARS = 8;
export const BRACKETED_PASTE_START = "\x1b[200~";
/** Teacher keystrokes closer than this make one mark when they are not part of a command. */
const TEACHER_MERGE_MS = 1000;
/** A position this close to the output of a command counts as being on it (the machine stops at event boundaries). */
const COMMAND_SLACK_MS = 50;
/** A position is a rounded time: an event within half a millisecond of it is at the position. */
const HALF_MS = 0.5;
const MS_PER_S = 1000;
const SECONDS_PER_MINUTE = 60;

export type MarkKind = "command" | "help" | "teacher" | "paste" | "comment" | "rollback";

export interface PlayerCommand {
  /** 1 is the first command of the journal. */
  number: number;
  text: string;
  /** Event indices of the first typed key and of the Enter. */
  start: number;
  index: number;
  /** Guest time of the Enter. */
  time: number;
  /** Where a jump to the command lands: after its output, just before the next command is typed. */
  target: number;
  by: "student" | "teacher";
  port: 0 | 2;
  uncertain: boolean;
}

export interface PlayerMark {
  id: string;
  kind: MarkKind;
  time: number;
  /** Where a click lands (guest ms). */
  target: number;
  label: string;
  /** Index into the command list for the mark of a command. */
  command: number | null;
  /** For the mark of a teacher's comment: which one and whose, so the author can delete it. */
  comment?: { id: number; author: number };
}

export interface Timeline {
  times: Float64Array;
  duration: number;
  commands: PlayerCommand[];
  marks: PlayerMark[];
}

/** "03:07" for 187 000 ms: the guest clock. */
export function formatGuestTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / MS_PER_S);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

function isStudentConsole(event: JournalEvent): event is SerialEvent {
  return event.t === "serial" && (event.p ?? 0) === 0 && (event.by === undefined || event.by === "student");
}

/** Input of the student's console that arrived as one event but is longer than a keystroke. */
export function isPaste(event: JournalEvent): boolean {
  return isStudentConsole(event) && (event.data.length > PASTE_MIN_CHARS || event.data.includes(BRACKETED_PASTE_START));
}

/**
 * Indices of the `by: "teacher"` events that the server also recorded: for each port the records of
 * this machine are joined into one string and the events, in order, take the matching prefix off it. An event the
 * string
 * does not start with is not the teacher's as far as the server knows, so it is shown as the student's.
 */
export function matchTeacherInputs(events: readonly JournalEvent[], inputs: readonly TeacherInput[], node: string): Set<number> {
  const queues = new Map<number, string>();
  const own = inputs.filter((input) => input.node === node).sort((a, b) => a.received_at - b.received_at);
  for (const input of own) queues.set(input.port, (queues.get(input.port) ?? "") + input.data);
  const matched = new Set<number>();
  events.forEach((event, index) => {
    if (event.t !== "serial" || event.by !== "teacher") return;
    const port = event.p ?? 0;
    const queue = queues.get(port) ?? "";
    if (event.data === "" || !queue.startsWith(event.data)) return;
    queues.set(port, queue.slice(event.data.length));
    matched.add(index);
  });
  return matched;
}

/** How many events happen at or before guest time `ms`: the event index a fork at that moment breaks the journal at. */
export function eventCountAt(times: ArrayLike<number>, ms: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? Infinity) <= ms + HALF_MS) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Guest time of the last event that the first `eventCount` events contain; 0 for none. */
/** How far before the next command's first key a jump to a command stops. */
const COMMAND_LEAD_MS = 100;

export function momentTime(times: ArrayLike<number>, eventCount: number): number {
  if (eventCount <= 0 || times.length === 0) return 0;
  return times[Math.min(eventCount, times.length) - 1] ?? 0;
}

function buildCommands(journal: Journal, times: Float64Array, matched: ReadonlySet<number>, duration: number): PlayerCommand[] {
  const found = commands(journal.events);
  return found.map((command, i) => {
    const next = found[i + 1];
    const time = times[command.index] ?? 0;
    // The replay stops only where events are applied or a guest step ends, so "the next key - 1 ms" lands on the
    // key itself and types it. A lead of COMMAND_LEAD_MS stops before it; the journal has no output events, so the
    // target is never earlier than the last event before that key.
    const before = next === undefined ? duration : Math.max(times[next.start - 1] ?? 0, (times[next.start] ?? duration) - COMMAND_LEAD_MS);
    return {
      number: i + 1,
      text: command.text,
      start: command.start,
      index: command.index,
      time,
      target: Math.max(time, before),
      by: matched.has(command.index) ? "teacher" : "student",
      port: command.port,
      uncertain: command.uncertain,
    };
  });
}

function commandMarks(list: readonly PlayerCommand[]): PlayerMark[] {
  return list.map((command, i) => ({
    id: `command-${command.number}`,
    kind: command.by === "teacher" ? "teacher" : "command",
    time: command.time,
    target: command.target,
    label: command.by === "teacher" ? `Викладач: ${command.text}` : command.text,
    command: i,
  }));
}

/** Matched teacher events outside any command (typing that never reached Enter), close ones merged. */
function teacherMarks(matched: ReadonlySet<number>, list: readonly PlayerCommand[], times: Float64Array): PlayerMark[] {
  const marks: PlayerMark[] = [];
  let last = -Infinity;
  for (const index of [...matched].sort((a, b) => a - b)) {
    if (list.some((command) => index >= command.start && index <= command.index)) continue;
    const time = times[index] ?? 0;
    if (time - last >= TEACHER_MERGE_MS) {
      marks.push({ id: `teacher-${index}`, kind: "teacher", time, target: time, label: "Ввід викладача", command: null });
    }
    last = time;
  }
  return marks;
}

function pasteMarks(events: readonly JournalEvent[], times: Float64Array): PlayerMark[] {
  const marks: PlayerMark[] = [];
  events.forEach((event, index) => {
    if (event.t !== "serial" || !isPaste(event)) return;
    const time = times[index] ?? 0;
    const size = plural(event.data.length, "символ", "символи", "символів");
    marks.push({ id: `paste-${index}`, kind: "paste", time, target: time, label: `Вставка з буфера: ${size}`, command: null });
  });
  return marks;
}

function helpMarks(help: readonly HelpRequest[], times: Float64Array): PlayerMark[] {
  return help.map((item) => {
    const time = momentTime(times, item.event_count);
    return { id: `help-${item.id}`, kind: "help", time, target: time, label: `Не працює: ${item.text}`, command: null };
  });
}

/** The teacher's comments on the machine `node`; they sit where the teacher put them (guest time of the comment). */
export function commentMarks(comments: readonly Comment[], node: string): PlayerMark[] {
  return comments
    .filter((comment) => comment.node === node)
    .map((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment",
      time: comment.vtime_ms,
      target: comment.vtime_ms,
      label: `${comment.author.name}: ${comment.text}`,
      command: null,
      comment: { id: comment.id, author: comment.author.id },
    }));
}

/** The marks of a timeline together with more marks, in time order. */
export function mergeMarks(marks: readonly PlayerMark[], more: readonly PlayerMark[]): PlayerMark[] {
  return [...marks, ...more].sort((a, b) => a.time - b.time);
}

/**
 * Event counts at which the student rolled back on the way to branch `branchId`: each rollback branch of its path forks
 * its parent there. A fork below a later fork of the path is cut out of the journal, so it is not a point of this one.
 */
export function rollbackPoints(branches: readonly Branch[], branchId: number): number[] {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const points: number[] = [];
  let cap = Infinity;
  for (let branch = byId.get(branchId); branch !== undefined; branch = byId.get(branch.parent_id ?? -1)) {
    cap = Math.min(cap, branch.fork_event);
    if (branch.kind === "rollback" && branch.fork_event <= cap) points.push(branch.fork_event);
  }
  return points.sort((a, b) => a - b);
}

function rollbackMarks(points: readonly number[], times: Float64Array): PlayerMark[] {
  return points.map((count, i) => {
    const time = momentTime(times, count);
    const label = count === 0 ? "Відкат до початку" : "Відкат до цього місця";
    return { id: `rollback-${i}`, kind: "rollback", time, target: time, label, command: null };
  });
}

export interface TimelineInput {
  journal: Journal;
  /** The server's records of the teacher's input; empty when the source has none. */
  teacherInputs: readonly TeacherInput[];
  node: string;
  help: readonly HelpRequest[];
  /** `rollbackPoints` of the played branch; none for a recording without branches. */
  rollbacks?: readonly number[];
}

export function buildTimeline({ journal, teacherInputs, node, help, rollbacks = [] }: TimelineInput): Timeline {
  const times = event_times(journal);
  const duration = times.at(-1) ?? 0;
  const matched = matchTeacherInputs(journal.events, teacherInputs, node);
  const list = buildCommands(journal, times, matched, duration);
  const marks = [
    ...commandMarks(list),
    ...teacherMarks(matched, list, times),
    ...pasteMarks(journal.events, times),
    ...helpMarks(help, times),
    ...rollbackMarks(rollbacks, times),
  ].sort((a, b) => a.time - b.time);
  return { times, duration, commands: list, marks };
}

/** The last command whose Enter is at or before `position`; -1 before the first. */
export function currentCommand(list: readonly PlayerCommand[], position: number): number {
  return list.findLastIndex((command) => command.time <= position);
}

/**
 * Where "next command" (1) and "previous command" (-1) go from `position`, or null when there is nowhere to go.
 * Each first goes to the output of the current command when the position has not reached it (next) or is past it (previous).
 */
export function stepTarget(list: readonly PlayerCommand[], position: number, direction: 1 | -1): number | null {
  const current = currentCommand(list, position);
  const own = list[current];
  if (direction === 1) {
    if (own !== undefined && position < own.target - COMMAND_SLACK_MS) return own.target;
    return list[current + 1]?.target ?? null;
  }
  if (own !== undefined && position > own.target + COMMAND_SLACK_MS) return own.target;
  if (current <= 0) return position > 0 ? 0 : null;
  return list[current - 1]?.target ?? null;
}
