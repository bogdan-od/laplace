// Messages between the main thread and app/machine/worker.mjs.
import type { CreateMachineOptions, EngineEnd, MachineStatus } from "../core/engine.mjs";
import type { HostNanSign } from "../core/host_nan.mjs";
import type { JournalEvent, RateState, SerialPort } from "../core/journal.mjs";
import type { ProfileName } from "../profiles.mjs";
import type { Snapshot } from "../core/snapfile.mjs";

/** `start` passes its parameters to `create_machine` unchanged. */
export type StartParams = CreateMachineOptions;

/**
 * `start` for app/machine/node_worker.mjs (the server): the Worker builds the engine config and reads the boot snapshot
 * from disk itself, so only plain data crosses the channel. The first event to replay is always the first one.
 */
export interface NodeStartParams {
    profile: ProfileName;
    seed: number;
    epoch?: number;
    events: JournalEvent[];
    on_journal_end: "pause" | "live";
    /** 0 means no periodic `check` events. */
    check_every_ms: number;
    recorded_host_nan: HostNanSign | null;
    /** `header.start.digest` of the journal: the boot snapshot is loaded and compared with it. `null` is a cold boot. */
    boot_digest: string | null;
    /** Initial speed as in `speed` (0 is maximum); applied before the machine starts running. */
    speed?: number;
}

export interface StartReply {
    rate0: RateState;
    status: MachineStatus;
}

export interface JournalReply {
    events: JournalEvent[];
    rate0: RateState;
}

/** Journal growth since the previous message: events `[from, from + events.length)`. */
export interface LogDelta {
    from: number;
    events: JournalEvent[];
}

/** A request with an `id` gets `done` or `error` with the same `id`; without an `id` nothing is sent back. */
interface RequestBase {
    id?: number;
}

export type WorkerRequest =
    | (RequestBase & { op: "start"; params: StartParams | NodeStartParams })
    | (RequestBase & { op: "type"; data: string; by?: string; port?: SerialPort })
    | (RequestBase & { op: "net_in"; frame: Uint8Array })
    | (RequestBase & { op: "speed"; x: number })
    | (RequestBase & { op: "pause" })
    | (RequestBase & { op: "resume" })
    | (RequestBase & { op: "go_live" })
    | (RequestBase & { op: "check"; pause?: boolean })
    | (RequestBase & { op: "run_until"; target: number })
    | (RequestBase & { op: "snapshot" })
    | (RequestBase & { op: "journal" })
    | (RequestBase & { op: "digest" });

export type WorkerOp = WorkerRequest["op"];

/** The `value` of `done` for each request. */
export interface WorkerReplies {
    start: StartReply;
    type: undefined;
    net_in: undefined;
    speed: undefined;
    pause: undefined;
    resume: undefined;
    go_live: undefined;
    /** Index of the recorded `check` event. */
    check: number;
    /** The vtime the machine stopped at. */
    run_until: number;
    snapshot: Snapshot;
    journal: JournalReply;
    /** Hash of guest RAM. */
    digest: string;
}

export type WorkerDone = { [Op in WorkerOp]: { op: "done"; id: number; value: WorkerReplies[Op] } }[WorkerOp];

/**
 * `error` has two forms: the reply to a request (`id` set, no `log`) and an engine error
 * (`log` set, `id` absent), after which the engine loop is stopped for good.
 */
export interface WorkerError {
    op: "error";
    id?: number;
    message: string;
    log?: LogDelta | null;
}

/** Messages from the Worker that are not replies. `serial*` carry no `log`. */
export type WorkerEvent =
    | { op: "serial"; data: Uint8Array; vtime: number }
    | { op: "serial1"; data: Uint8Array }
    | { op: "serial2"; data: Uint8Array }
    | { op: "net_out"; frame: Uint8Array }
    | { op: "status"; status: MachineStatus; log: LogDelta | null }
    | ({ op: "end" } & EngineEnd)
    | { op: "snapshot"; snap: Snapshot; log: LogDelta | null };

export type WorkerMessage = WorkerDone | WorkerError | WorkerEvent;
