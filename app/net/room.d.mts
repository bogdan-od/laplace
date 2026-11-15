import type { SerialPort } from "../core/journal.mjs";
import type { TaskKind } from "./room_fields.mjs";

export type PeerRole = "student" | "teacher";
/** `open` after a join, `lost` while reconnecting, `replaced` when another tab with the same key took the seat (no reconnect). */
export type RoomState = "connecting" | "open" | "lost" | "replaced";

/** A room member as the `Room` keeps it (without the id, which is the map key). */
export interface Peer {
    role: PeerRole;
    name: string;
    /** Machine ids of a student on the topology page. */
    machines?: string[];
}

export interface PeerInfo extends Peer {
    id: string;
}

export interface ReportMessage {
    type: "report";
    from: string;
    name: string;
    kind: "problem" | "submit";
    journal_id: string;
    note?: string;
    /** Client reference; a retry with the same `ref` is safe. */
    ref: string | null;
    at: number;
    machine?: string;
    /** Reports of one press on the topology page share a group. */
    group?: string;
}

export interface JoinedMessage {
    type: "joined";
    id: string;
    peers: PeerInfo[];
    task: string | null;
    /** Absent means `"journal"`. */
    kind?: TaskKind;
    resumed: boolean;
    /** Accumulated reports, for teachers only. */
    reports: ReportMessage[];
}

export type SignalData =
    | { kind: "offer"; sdp: string }
    | { kind: "answer"; sdp: string }
    | { kind: "candidate"; candidate: RTCIceCandidateInit };

/** Messages from the server. `replaced` is handled inside `Room` and never reaches handlers. */
export interface RoomEvents {
    joined: JoinedMessage;
    "peer-joined": { type: "peer-joined" } & PeerInfo;
    "peer-left": { type: "peer-left"; id: string };
    signal: { type: "signal"; from: string; data: SignalData };
    /** A frame through the server, between students only. */
    frame: { type: "frame"; from: string; data: string };
    /** Output of a student's machine to teachers; `full` replaces the tile contents. */
    serial: { type: "serial"; from: string; data: string; machine?: string; full?: true };
    /** Teacher input to a student. */
    input: { type: "input"; from: string; data: string; machine?: string };
    task: { type: "task"; from: string; journal_id: string | null; kind?: TaskKind };
    report: ReportMessage;
    "report-ack": { type: "report-ack"; ref: string };
    pong: { type: "pong" };
    /** Emitted by `Room` itself on every state change. */
    state: { type: "state"; state: RoomState };
}

/** Messages to the server. `join` is sent by `Room` itself after the connection opens. */
export type RoomOutgoing =
    | { type: "ping" }
    | { type: "signal"; to: string; data: SignalData }
    | { type: "frame"; to: string; data: string }
    | { type: "serial"; machine?: string; data: string; full?: boolean }
    | { type: "input"; to: string; machine?: string; data: string }
    | { type: "task"; journal_id: string | null; kind?: TaskKind }
    | {
          type: "report";
          ref: string;
          journal_id: string;
          kind: "problem" | "submit";
          note: string;
          machine?: string;
          group?: string;
      };

export interface RoomOptions {
    /** Page URL the WebSocket address is derived from; default `location.href`. */
    url?: string;
    room: string;
    role?: PeerRole;
    name?: string;
    /** Machine ids of a student on the topology page. */
    machines?: string[] | null;
    /** Where the student's key and last seat number are kept; default `sessionStorage`. */
    storage?: Pick<Storage, "getItem" | "setItem">;
}

/** The number in a student id `pN`; 1 for `p1`. */
export function number_of(id: string): number;

/**
 * A room on the server. Reconnects without end; a student stays the same member by the key in storage
 * (and so keeps the same 10.0.0.N in the guest).
 */
export class Room {
    #private;
    id: string | null;
    peers: Map<string, Peer>;
    task: string | null;
    task_kind: TaskKind;
    reports: ReportMessage[];
    state: RoomState;
    constructor(options: RoomOptions);
    get is_open(): boolean;
    /** Resolves after the first join; later the room recovers from breaks by itself. */
    connect(): Promise<Room>;
    on<K extends keyof RoomEvents>(type: K, fn: (message: RoomEvents[K]) => void): void;
    /** `false`: there is no connection now and the message was not sent. */
    send(message: RoomOutgoing): boolean;
}
