import type { HostNanSign } from "./host_nan.mjs";
import type { JournalEvent, RateState, SerialPort } from "./journal.mjs";
import type { Snapshot, SnapshotClock } from "./snapfile.mjs";
import type { V86Config } from "../profiles.mjs";

/** Value of the `m` field of a `check` recorded after restoring from a mid-journal snapshot: the rest of memory is not compared. */
export const NO_REST_DIGEST: string;

export function ram_digest(): string;
export function state_digest(): string;

export type EngineMode = "replay" | "live";
export type JournalEnd = "pause" | "live";

/** Snapshot the engine starts from: all wasm memory as one array. */
export interface StartSnapshot {
    clock: SnapshotClock;
    state: ArrayBuffer;
    mem: Uint8Array;
    jit: [number, Uint8Array][];
}

export interface CreateMachineOptions {
    config: V86Config;
    seed?: number;
    /** Without a value: the host's current time. Ignored when a snapshot is given. */
    epoch?: number;
    events?: JournalEvent[];
    /** Replay starts from event `next`. */
    next?: number;
    snapshot?: StartSnapshot | null;
    /** What to do after the last replayed event. With nothing to replay (`next >= events.length`) `live` starts live at once. */
    on_journal_end?: JournalEnd;
    check_every_ms?: number;
    /** 0 means no automatic snapshots. */
    snap_every_ms?: number;
    /** Hashes of chunks the receiver already has: the engine does not resend their bytes. */
    known_hashes?: string[];
    recorded_host_nan?: HostNanSign | null;
    /** Start from the boot snapshot: the guest randomness stream is reset to `seed`. */
    reseed?: boolean;
    image_timeout_ms?: number;
}

export interface EngineStatus {
    mode: EngineMode;
    paused: boolean;
    ended: boolean;
    vtime: number;
    /** Events `[0, next)` are applied. */
    next: number;
    total: number;
    per_ms: number;
    instructions: number;
}

/** Status from events: `waiting` is set only while the engine waits for the host (image file, 9p reply). */
export interface MachineStatus extends EngineStatus {
    waiting?: boolean;
}

export interface EngineEnd {
    vtime: number;
    events: number;
}

export interface EngineEvents {
    /** Output of ttyS0. */
    serial: Uint8Array;
    /** Output of ttyS1 (system channel). */
    serial1: Uint8Array;
    /** Output of ttyS2 (teacher terminal). */
    serial2: Uint8Array;
    /** Live mode only. */
    net_out: Uint8Array;
    status: MachineStatus;
    /** Emitted once per machine lifetime. */
    end: EngineEnd;
    /** After an error the engine loop is stopped for good: requests are left unanswered. */
    error: string;
    snapshot: Snapshot;
}

export interface EngineMachine {
    /** Resolves when the emulator is loaded and running. */
    ready: Promise<void>;
    rate0: RateState;
    /** The machine's journal: replay reads it, live mode appends. `go_live` cuts it to the applied events. */
    events: JournalEvent[];
    /** One handler per name: a later `on` replaces the earlier one. */
    on<K extends keyof EngineEvents>(name: K, fn: (value: EngineEvents[K]) => void): void;
    /** Ignored outside live mode. */
    type(data: string, by?: string, port?: SerialPort): void;
    /** Ignored outside live mode. */
    net_in(frame: Uint8Array): void;
    /** 1 is real time, 0 is maximum speed. */
    set_speed(x: number): void;
    /** Takes effect at the next tick: the guest still executes one more slice. */
    pause(): void;
    /** Does nothing for a finished replay on pause: only `go_live` revives it. */
    resume(): void;
    go_live(): void;
    /** Resolves with the vtime it stopped at. Outside replay, or after its end, resolves at once. */
    run_until(target: number): Promise<number>;
    snapshot(): Promise<Snapshot>;
    /** The engine waits for async work (JIT compilation, 9p read) and the guest is not running. */
    stalled(): boolean;
    snapshot_after_event(index: number): Promise<Snapshot>;
    /** Rejects outside live mode. Resolves with the index of the recorded `check` event. */
    check(options?: { pause?: boolean }): Promise<number>;
    status(): EngineStatus;
    ram_digest(): string;
    state_digest(): string;
    vtime(): number;
    instructions(): number;
}

/** Once per execution realm (Worker, Node process): it replaces globals, and a second call throws. */
export function create_machine(options: CreateMachineOptions): EngineMachine;
