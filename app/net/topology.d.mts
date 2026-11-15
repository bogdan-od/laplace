import type { Journal } from "../core/journal.mjs";
import type { ProfileName } from "../profiles.mjs";
import type { Switch, SwitchPort } from "./switch.mjs";

export const TOPOLOGY_FORMAT: "v86-topology/1";
export const MIN_MACHINES: number;
export const MAX_MACHINES: number;

export type PortMode = "access" | "trunk";

export interface AccessPort {
    mode: "access";
    /** 1..4094 */
    vlan: number;
}

export interface TrunkPort {
    mode: "trunk";
    /** Non-empty list of VLANs, each 1..4094. */
    allowed: number[];
    /** Must be in `allowed`; untagged frames go to this VLAN. Without it untagged frames are dropped. */
    native?: number | null;
}

export type PortConfig = AccessPort | TrunkPort;

export interface TopologyMachine {
    id: string;
    title?: string;
    profile: ProfileName;
    /** Typed into the terminal as `system`; every `{mac}` is replaced by `fill_setup`. */
    setup?: string;
}

export interface TopologySwitch {
    id: string;
}

/** Machine to switch. A machine has at most one such link; a single machine without a switch has none. */
export type MachineLink = {
    machine: string;
    switch: string;
    to?: never;
    uplink?: never;
} & PortConfig;

/** Switch to switch: trunk only. Cycles are forbidden (there is no STP). */
export type SwitchLink = {
    to: string;
    switch: string;
    machine?: never;
    uplink?: never;
} & TrunkPort;

/** Exit to the outside world; at most one per topology. */
export type UplinkLink = {
    uplink: "relay";
    switch: string;
    machine?: never;
    to?: never;
} & PortConfig;

export type TopologyLink = MachineLink | SwitchLink | UplinkLink;

export interface Topology {
    format: "v86-topology/1";
    title?: string;
    /** 1 to 6 machines. Machine and switch ids share one namespace. */
    machines: TopologyMachine[];
    switches: TopologySwitch[];
    links: TopologyLink[];
    /** A task with broken machines: the key is a machine id, the value is the journal that machine starts from. */
    journals?: Record<string, Journal>;
}

/** Messages in Ukrainian naming the offending nodes; an empty array means the description is valid. Never throws on garbage. */
export function validate_topology(desc: unknown): string[];
export function fill_setup(setup: string, mac: string): string;

/** What `build_topology` needs from a machine. `off` is optional. */
export interface TopologyNetMachine {
    net_in(frame: Uint8Array): void;
    on(name: "net_out", fn: (frame: Uint8Array) => void): void;
    off?(name: "net_out", fn: (frame: Uint8Array) => void): void;
}

export interface TopologyRelay {
    send(frame: Uint8Array): void;
    /** Frames from outside arrive here; the topology sets it, `null` after `teardown`. */
    on_frame: ((frame: Uint8Array) => void) | null;
}

export interface BuildOptions<M extends TopologyNetMachine> {
    create_machine(machine: TopologyMachine): M;
    /** Without a relay the `uplink` link is silently skipped. */
    relay?: TopologyRelay | null;
}

export interface BuiltTopology<M extends TopologyNetMachine> {
    switches: Map<string, Switch>;
    machines: Map<string, M>;
    ports: SwitchPort[];
    /** Frames that arrive after `teardown` are dropped. */
    teardown(): void;
}

/** Builds the network from an already validated description. */
export function build_topology<M extends TopologyNetMachine>(desc: Topology, options: BuildOptions<M>): BuiltTopology<M>;
