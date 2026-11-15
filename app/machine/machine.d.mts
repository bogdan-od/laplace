import type { MachineStatus } from "../core/engine.mjs";
import type { Journal, JournalEvent, JournalHeader, RateState, SerialPort } from "../core/journal.mjs";
import type { ProfileName } from "../profiles.mjs";
import type { AgentChannel, AgentResult } from "./agent_channel.mjs";
import type { StartReply } from "./worker_protocol.mjs";

/** Default cap on bytes of snapshot chunks kept in memory. */
export const SNAPSHOT_BYTES_MAX: number;

export type JournalEndMode = "pause" | "live";

interface MachineCommonOptions {
    /** URL prefix of the project root (pages: `"../"`). */
    root: string;
    /** Without a source journal the machine is live from the start; with one, see `on_journal_end`. */
    on_journal_end?: JournalEndMode;
    /** 0 means no automatic snapshots. */
    snap_every_ms?: number;
    /** 0 means no periodic `check` events. */
    check_every_ms?: number;
    name?: string;
    MAX_SNAPSHOTS?: number;
    /** Cap on bytes of snapshot chunks; the snapshot with the closest neighbours in time is dropped first. */
    max_bytes?: number;
    /** The source journal is a lesson timeline: snapshots of the live branch are not kept. */
    timeline_only?: boolean;
    /** Restore a live machine after a Worker failure. */
    auto_recover?: boolean;
    /** A live Worker silent for longer than this is declared failed. */
    silence_ms?: number;
}

/** Without a journal the profile is required; with one it comes from the journal header and `profile` is ignored. */
export type MachineOptions = MachineCommonOptions &
    (
        | { journal: Journal; profile?: ProfileName }
        | { journal?: null; profile: ProfileName }
    );

export interface EndInfo {
    /** Missing in the empty `end` that `play_segment` emits when the machine became live at once. */
    op?: "end";
    vtime?: number;
    events?: number;
}

export interface RecoveredInfo {
    events: number;
}

export interface MachineEvents {
    /** Console output (ttyS0). After a replay restart the whole kept log is emitted again. */
    serial: Uint8Array;
    /** Output of the teacher terminal (ttyS2). */
    teacher_output: Uint8Array;
    /** Not more often than every ~100 ms. */
    status: MachineStatus;
    /** End of the replay; not emitted while a live machine is being recovered. */
    end: EndInfo;
    /** The core is stopped and will not recover, or a system command got no answer from the agent. */
    error: string;
    /** The terminal must be cleared: the machine restarts from a snapshot and re-emits `serial`. */
    reset: undefined;
    /** Live mode only. */
    net_out: Uint8Array;
    /** Argument is the failure reason. */
    recovering: string;
    recovered: RecoveredInfo;
    /** Argument is the journal length after a rollback. */
    truncated: number;
}

export interface SnapshotMark {
    vtime: number;
    next: number;
}

export interface SystemOptions {
    /** Real time to wait for the agent; default 10000. */
    timeout_ms?: number;
}

export interface PlaySegment {
    /** Event index to run to at maximum speed; after it the replay goes at 1x. */
    from: number;
    /** The Worker sees only events before `stop`. */
    stop: number;
    /** After event `stop - 1` the machine becomes live instead of pausing. */
    live_at_stop: boolean;
}

export class Machine {
    constructor(options: MachineOptions);

    readonly profile: ProfileName | undefined;
    /** The profile actually used: the journal's, if there is one. Set by `start()`. */
    profile_name: ProfileName | undefined;
    readonly root: string;
    readonly name: string | undefined;
    readonly source: Journal | null;
    readonly timeline_only: boolean;
    readonly auto_recover: boolean;
    readonly silence_ms: number;
    readonly agent: AgentChannel;
    readonly session_seed: number;
    /** Duration of the source journal, 0 without one. */
    duration_ms: number;
    /** Events the next Worker receives. */
    events: JournalEvent[];
    /** The machine was switched to live mode; after that `seek` is forbidden. */
    live: boolean;
    /** Index of the event where the live part began; set only by `go_live()`, ends up in `header.parent`. */
    live_from: number | null;
    /** The page paused the machine (button, seek); unlike `status`, this is exact. */
    user_paused: boolean;
    /** Copy of the Worker's journal on the main thread; lags behind by at most the status interval. */
    mirror: JournalEvent[];
    /** A live machine is being restored after a failure. */
    recovering: boolean;
    /** The second failure in a row: no more recovery. */
    failed: boolean;
    /** The core is not running and will not be restored: requests to it are rejected. */
    dead: boolean;
    stopped: boolean;
    /** Console output with guest time, to redraw the terminal after a Worker restart. */
    log: { vtime: number; data: Uint8Array }[];
    /** Resolves after the first successful start; rejects if `start()` failed. */
    started: Promise<void>;

    /** Last status; lags behind by up to 100 ms, except the forced status on pause. */
    get status(): MachineStatus | null;
    get snapshots(): SnapshotMark[];

    on<K extends keyof MachineEvents>(name: K, fn: (value: MachineEvents[K]) => void): void;

    /** Loads the boot snapshot if needed and starts the first Worker. Any restart rejects all pending requests with "Worker перезапущено". */
    start(): Promise<StartReply>;
    stop(): void;

    /**
     * Port 0 console, 1 system channel, 2 teacher. Queued before the Worker starts, dropped after `stop()`.
     * Input that arrives during a replay (restore, rollback, task playback) is dropped silently.
     */
    type(data: string, by?: string, port?: SerialPort): void;
    /** Input to the teacher terminal (ttyS2), recorded with `by: "teacher"`. */
    teacher_input(data: string): void;
    /** Live mode only; waits for the first successful `start()`. Rejects on timeout. */
    system(command: string, options?: SystemOptions): Promise<AgentResult>;
    /** Like `system` with a 30 s timeout, but a failure becomes an `error` event and the result is `null`. */
    run_setup(command: string, options?: SystemOptions): Promise<AgentResult | null>;
    /** Empty line in the console, then the date and a fresh guest random seed through the system channel. */
    begin_session(): Promise<AgentResult | null>;
    /** A frame that arrives before the Worker is ready, or during a replay, is dropped like a lost packet. */
    net_in(frame: Uint8Array): void;
    /** Remembered and applied at the next Worker start. */
    set_speed(x: number): void;
    pause(): void;
    /** Does not wake a finished replay on pause: only `go_live()` does. */
    resume(): void;
    /**
     * Rejects before the Worker starts and outside live mode. Resolves with the index of the recorded `check` event;
     * with `pause` the machine stops in that tick, so `check` stays the last event of the journal until it is resumed.
     */
    check(options?: { pause?: boolean }): Promise<number>;
    /** Journal ending with a `check`. A machine that was paused stays paused. */
    checked_journal(): Promise<Journal>;
    journal(): Promise<Journal>;
    header_now(): JournalHeader;
    /** Whether the Worker is waiting for the host or silent while not paused: the guest is not running. */
    worker_stalled(): boolean;

    /** Truncates the unapplied events of the source journal. */
    go_live(): Promise<void>;
    /** Resolves with the reached vtime, or `null` if a newer seek superseded this one. Rejects after `go_live()`. */
    seek(target: number): Promise<number | null>;
    /** Resolves with the reached vtime, or `null` if the token no longer matches. */
    run_to(target: number, token: number): Promise<number | null>;
    /** Live machine only. Drops the journal after event `index`; pending requests get "Worker перезапущено". */
    rollback(index: number): Promise<void>;
    /** Lesson: replay the source journal so that the Worker sees only events before `stop`. Arrival is reported by `end`. */
    play_segment(segment: PlaySegment): Promise<void>;
    /** Cuts the source events to those before `stop`; `live_at_stop` picks what happens at the end. */
    limit(stop: number, live_at_stop: boolean): void;
}
