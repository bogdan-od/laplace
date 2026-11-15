// WebSocket protocol at /ws. One connection per tab, authenticated by the session cookie on connect.
// Without join a connection receives only personal messages (notify, submission, check-run).
// join enters the assignment room: live terminals, teacher input, network between students.
// Names and fields of signal/frame/serial/input/ping/pong/peer-*/replaced/joined are the ones
// app/net/room.mjs and mesh.mjs speak.

import type { Activity, CheckRun, Id, StudentProgress, SubmissionSummary, UserRef } from "./api.js";

/** A student is "p<number in class>" (guest address 10.0.0.N), a teacher or assistant "t<user id>". */
export type PeerId = `p${number}` | `t${number}`;

export interface Peer {
  id: PeerId;
  user_id: Id;
  role: "student" | "teacher";
  name: string;
  /** Machine ids of the student's topology (several terminals on one tile). */
  machines?: string[];
}

export type SerialPort = 0 | 2;

export type ClientMessage =
  | { type: "join"; assignment_id: Id; machines?: string[] }
  | { type: "signal"; to: PeerId; data: unknown }
  | { type: "frame"; to: PeerId; data: string }
  | { type: "serial"; data: string; port?: SerialPort; machine?: string; full?: true }
  | { type: "input"; to: PeerId; data: string; port: SerialPort; machine?: string }
  | { type: "freeze"; frozen: boolean }
  | { type: "ping" };

export type ServerMessage =
  | { type: "joined"; id: PeerId; role: "student" | "teacher"; peers: Peer[]; frozen: boolean; resumed: boolean }
  | ({ type: "peer-joined" } & Peer)
  | { type: "peer-left"; id: PeerId }
  | { type: "signal"; from: PeerId; data: unknown }
  | { type: "frame"; from: PeerId; data: string }
  | { type: "serial"; from: PeerId; data: string; port?: SerialPort; machine?: string; full?: true }
  | { type: "input"; from: PeerId; data: string; port: SerialPort; machine?: string }
  | { type: "frozen"; frozen: boolean; by: UserRef }
  | { type: "tile"; assignment_id: Id; progress: StudentProgress }
  | { type: "notify"; activity: Activity }
  | { type: "submission"; assignment_id: Id; student_id: Id; submission: SubmissionSummary }
  | { type: "check-run"; run: CheckRun }
  | { type: "replaced" }
  | { type: "pong" }
  | { type: "error"; message: string };

export type ClientMessageType = ClientMessage["type"];
export type ServerMessageType = ServerMessage["type"];
