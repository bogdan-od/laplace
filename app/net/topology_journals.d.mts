import type { Journal } from "../core/journal.mjs";
import type { Topology } from "./topology.mjs";

export type LaunchPhase = "replay" | "live";

/** A topology description that carries journals (the "broken topology" task). */
export type TopologyWithJournals = Topology & { journals: Record<string, Journal> };

/** What `launch_topology` needs from a machine. */
export interface LaunchableMachine {
    start(): Promise<unknown>;
    on(name: "end", fn: () => void): void;
    on(name: "error", fn: (message: string) => void): void;
    set_speed(x: number): void;
    go_live(): Promise<unknown>;
}

/** What `checked_journals` needs from a machine. */
export interface CheckableMachine {
    /** `check` is asked to pause the machine; the result is not inspected. */
    check(options: { pause: boolean }): unknown;
    journal(): Promise<Journal>;
    resume(): void;
    /** A machine already paused before the call stays paused. */
    user_paused?: boolean;
}

/** True when `journals` is present and non-empty. */
export function has_journals(desc: Topology): desc is TopologyWithJournals;

export interface LaunchOptions<M extends LaunchableMachine> {
    /** How to start a machine; default `machine.start()`. */
    start?: (machine: M) => Promise<unknown>;
    on_phase?: (phase: LaunchPhase) => void;
}

/**
 * Starts all machines one by one; those in `replayed` replay their journals at maximum speed, then all of them
 * `go_live()` in one tick. A start failure or replay mismatch of any machine rejects the promise and nobody goes live.
 */
export function launch_topology<M extends LaunchableMachine>(
    machines: Map<string, M>,
    replayed: Iterable<string>,
    options?: LaunchOptions<M>,
): Promise<void>;

/** How long to wait for `check` from all machines. */
export const CHECK_TIMEOUT_MS: number;

export interface CheckedJournalsOptions {
    timeout_ms?: number;
}

/**
 * Journals of all machines, each ending with a `check`. All machines pause in their `check` tick first, then the
 * journals are taken; afterwards machines that were not paused before the call resume, on errors and timeouts too.
 */
export function checked_journals(
    machines: Iterable<readonly [string, CheckableMachine]>,
    options?: CheckedJournalsOptions,
): Promise<Journal[]>;

export function save_topology_journals(desc: Topology, machines: Map<string, CheckableMachine>): Promise<TopologyWithJournals>;
