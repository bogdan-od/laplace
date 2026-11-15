import type { RateState } from "./journal.mjs";

export interface SnapshotClock {
    base: number;
    wraps: number;
    last: number;
    warp: number;
    rate: RateState;
    epoch: number;
    /** State of the guest randomness stream. */
    rng: number;
    /** State of the host randomness stream (Math.random). */
    host_rng: number;
    vtime: number;
    /** Hash of guest RAM. */
    ram: string;
    /** Hash of the rest of wasm memory. */
    rest: string;
    /** Journal events `[0, next)` are already applied. */
    next: number;
    /** Snapshot of a live branch: not usable as a start point for someone else's events. */
    live: boolean;
}

/**
 * Engine snapshot. A chunk's bytes are `null` when the receiver already has them by hash. `State` is the
 * `ArrayBuffer` from v86; in `Machine` it is the device state cut into chunks.
 */
export interface Snapshot<State = ArrayBuffer> {
    clock: SnapshotClock;
    state: State;
    mem_size: number;
    /** `[hash, bytes | null]` for each 64 KB piece of wasm memory. */
    chunks: [string, Uint8Array | null][];
    /** `[index, hash, bytes | null]` for JIT modules. */
    jit: [number, string, Uint8Array | null][];
}

/** Snapshot with all bytes present: the result of `read_snapshot`. */
export interface FullSnapshot extends Snapshot {
    chunks: [string, Uint8Array][];
    jit: [number, string, Uint8Array][];
}

/** Snapshot assembled into contiguous memory. */
export interface Materialized<State = ArrayBuffer> {
    clock: SnapshotClock;
    state: State;
    mem: Uint8Array;
    jit: [number, Uint8Array][];
    hashes: string[];
    blob(hash: string): Uint8Array;
}

/** `lookup(hash)` supplies the bytes the engine did not resend. */
export function materialize<State>(
    snap: Snapshot<State>,
    lookup?: (hash: string) => Uint8Array | null | undefined,
): Materialized<State>;
export function encode_snapshot(snap: Snapshot, lookup?: (hash: string) => Uint8Array | null | undefined): Promise<Uint8Array>;
export function read_snapshot(gz: Uint8Array): Promise<FullSnapshot>;
export function decode_snapshot(gz: Uint8Array): Promise<Materialized>;
