import type { HostNanSign } from "./host_nan.mjs";
import type { ProfileName } from "../profiles.mjs";

export type SerialPort = 0 | 1 | 2;
/** Ports where `commands()` looks for shell commands: the student console and the teacher terminal. */
export type ShellPort = 0 | 2;

export const FORMAT: "v86-replay/9";
/** 0 is the student console, 1 is the system channel (the agent in the guest), 2 is the teacher terminal. */
export const SERIAL_PORTS: readonly [0, 1, 2];
export const START_INSTR_PER_MS: number;
export const MIN_INSTR_PER_MS: number;
export const MAX_INSTR_PER_MS: number;

export interface JournalLimits {
    max_events: number;
    max_instructions: number;
    max_warp_ms: number;
    max_extra_ms: number;
    max_serial_chars: number;
}
export const JOURNAL_LIMITS: JournalLimits;

/** Instruction rate: time = `ms + (c - at) / per_ms` counted from instruction `at`. */
export interface RateState {
    at: number;
    ms: number;
    per_ms: number;
}

/**
 * An event sits on a slice boundary: `c` is executed instructions, `w` is accumulated idle time (ms).
 * Replay applies the event when the current `(c, w)` equal these values exactly.
 */
export interface EventBase {
    c: number;
    w: number;
}

/** Clock jump by `extra` ms. */
export interface ClockEvent extends EventBase {
    t: "clock";
    extra: number;
}

export interface RateEvent extends EventBase {
    t: "rate";
    per_ms: number;
}

export interface SerialEvent extends EventBase {
    t: "serial";
    data: string;
    /** Absent means the student; `system` is the system channel; `teacher` is the teacher. */
    by?: string;
    /** Absent means port 0. */
    p?: SerialPort;
}

/** Incoming Ethernet frame in base64. */
export interface NetEvent extends EventBase {
    t: "net";
    data: string;
}

/** `h` is the hash of guest RAM, `m` is the hash of the rest of wasm memory; `0000000000000000` in `m` means "do not compare". */
export interface CheckEvent extends EventBase {
    t: "check";
    h: string;
    m: string;
}

export type JournalEvent = ClockEvent | RateEvent | SerialEvent | NetEvent | CheckEvent;

export interface LessonNote {
    t: "note";
    /** Index of the event from which the note is shown. */
    at: number;
    text: string;
}

/** A "now on your own" segment: the student performs events `[from, to)` themselves. */
export interface LessonSelf {
    t: "self";
    from: number;
    to: number;
    text: string;
}

export type LessonMark = LessonNote | LessonSelf;

export interface JournalStart {
    snapshot: string;
    digest: string;
}

export interface JournalParent {
    digest: string;
    event: number;
}

export interface JournalHeader {
    format: "v86-replay/9";
    profile: ProfileName;
    machine?: string;
    seed: number;
    epoch?: number;
    recorded_at?: string;
    /** Rate at the start of the journal; `null` if the header was taken before the Worker first started. */
    rate0?: RateState | null;
    host_nan?: HostNanSign;
    /** `null` is a cold start, an object is a start from the boot snapshot. */
    start?: JournalStart | null;
    /** Parent journal when this one continues another from event `event`. */
    parent?: JournalParent | null;
    lesson?: LessonMark[];
}

export interface Journal {
    header: JournalHeader;
    events: JournalEvent[];
}

/** A shell command found in the serial input. */
export interface JournalCommand {
    text: string;
    /** Index of the event that submitted the line (Enter). */
    index: number;
    /** Index of the event where typing of the line started. */
    start: number;
    by: string;
    port: ShellPort;
    /** The line was edited with unknown keys (Tab, unknown escape sequence): the text is approximate. */
    uncertain: boolean;
}

/** Shape check only: `read_journal` lets unknown event types through, `check_journal_strict` rejects them. */
export function read_journal(json: unknown): Journal;
export function check_lesson(lesson: unknown, total: number): void;
export function check_journal_strict(json: unknown, limits?: Partial<JournalLimits>): Journal;
export function event_times(journal: Pick<Journal, "header" | "events">): Float64Array;
export function duration_ms(journal: Pick<Journal, "header" | "events">): number;
export function commands(events: readonly JournalEvent[]): JournalCommand[];
export function journal_digest(journal: Pick<Journal, "events">): string;
