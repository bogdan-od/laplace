// The teacher's side of the assignment room: the tiles of the
// class page. The student list comes from HTTP and is then replaced piece by piece by `tile`; the last lines of each
// student's console come from `serial`. No React here: `use-teacher-room.ts` is the hook.
// ⏎ Room messages are keyed by `PeerId`, the page by `user_id`; `joined.peers` and `peer-joined` link the two.
// Port 0 (the student's own console) is mirrored into `screens` for the tiles. The raw bytes of every port (0 and the
// hidden terminal 2) are also kept per (student, machine, port) for the big terminal of the student page, which draws
// `serialHistory` and then the live bytes of `onSerial`; `sendInput` types into a port of the student's machine.

import { from_base64 } from "@core/net/base64.mjs";
import type { Id, StudentProgress } from "@shared/api";
import type { Peer, PeerId, SerialPort } from "@shared/ws";
import type { Socket } from "@/lib/socket";
import { ScreenMirror } from "./screen-mirror";
import { SerialHistory, type SerialListener } from "./serial-history";

export type TeacherRoomSocket = Pick<Socket, "on" | "send" | "join" | "leave">;

/** The raw output kept per (student, machine, port); older bytes are cut off from the start. */
export const SERIAL_HISTORY_BYTES = 256 * 1024;

const serialKey = (userId: Id, machine: string, port: SerialPort) => `${userId}/${machine}/${port}`;

export interface StudentPresence {
  peer: PeerId;
  /** Machine ids of the student's topology, as the student announced them. */
  machines: readonly string[];
}

export interface TeacherRoomSnapshot {
  /** The server confirmed our `join` (again after every reconnect). */
  joined: boolean;
  frozen: boolean;
  /** The student list has arrived at least once. */
  loaded: boolean;
  loadError: unknown;
  students: readonly StudentProgress[];
  /** Students who are in the room now, by user id. */
  online: Readonly<Record<Id, StudentPresence>>;
  /** Last lines of each student's console: user id, then machine id ("" when the student did not name one). */
  screens: Readonly<Record<Id, Readonly<Record<string, readonly string[]>>>>;
}

export interface TeacherRoomOptions {
  socket: TeacherRoomSocket;
  assignmentId: Id;
  fetchStudents: (assignmentId: Id) => Promise<StudentProgress[]>;
}

export const EMPTY_ROOM: TeacherRoomSnapshot = {
  joined: false,
  frozen: false,
  loaded: false,
  loadError: null,
  students: [],
  online: {},
  screens: {},
};

const NO_MACHINE = "";

/** A student's console for a tile: the named machine, or the first of the student's machines that has output. */
export function screenOf(
  snapshot: TeacherRoomSnapshot,
  userId: Id,
  machine?: string,
): { machine: string; lines: readonly string[] } | null {
  const machines = snapshot.screens[userId];
  if (!machines) return null;
  const announced = snapshot.online[userId]?.machines ?? [];
  const id = machine ?? announced.find((name) => machines[name]) ?? Object.keys(machines)[0];
  const lines = id === undefined ? undefined : machines[id];
  return id === undefined || lines === undefined ? null : { machine: id, lines };
}

function sameLines(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((line, index) => line === b[index]);
}

export class TeacherRoom {
  readonly #options: TeacherRoomOptions;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: (() => void)[] = [];
  /** peer id -> user id for the students who are in the room. */
  readonly #users = new Map<PeerId, Id>();
  readonly #mirrors = new Map<string, ScreenMirror>();
  readonly #history = new SerialHistory(SERIAL_HISTORY_BYTES);
  /** Tiles that arrived while a student list request was running; they are put over the list. */
  #tilesDuringLoad = new Map<Id, StudentProgress>();
  #loading = false;
  #state: TeacherRoomSnapshot = EMPTY_ROOM;
  #loadId = 0;
  #disposed = false;

  constructor(options: TeacherRoomOptions) {
    this.#options = options;
  }

  get assignmentId(): Id {
    return this.#options.assignmentId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): TeacherRoomSnapshot => this.#state;

  /** May be called again after `dispose` (React runs effects twice in development). */
  start(): void {
    this.#disposed = false;
    const { socket, assignmentId } = this.#options;
    this.#unsubscribe.push(
      socket.on("joined", (message) => {
        if (message.role !== "teacher") return;
        this.#users.clear();
        const online: Record<Id, StudentPresence> = {};
        for (const peer of message.peers) this.#addPeer(peer, online);
        this.#set({ joined: true, frozen: message.frozen, online });
        void this.#load();
      }),
      socket.on("peer-joined", (message) => {
        const online = { ...this.#state.online };
        this.#addPeer(message, online);
        this.#set({ online });
      }),
      socket.on("peer-left", (message) => {
        const userId = this.#users.get(message.id);
        if (userId === undefined) return;
        this.#users.delete(message.id);
        const online = { ...this.#state.online };
        delete online[userId];
        this.#set({ online });
      }),
      socket.on("frozen", (message) => this.#set({ frozen: message.frozen })),
      socket.on("tile", (message) => {
        if (message.assignment_id === assignmentId) this.#applyTile(message.progress);
      }),
      socket.on("serial", (message) => {
        const userId = this.#users.get(message.from);
        if (userId === undefined) return;
        let bytes: Uint8Array;
        try {
          bytes = from_base64(message.data);
        } catch {
          return;
        }
        const machine = message.machine ?? NO_MACHINE;
        const port = message.port ?? 0;
        const full = message.full === true;
        this.#history.write(serialKey(userId, machine, port), bytes, full);
        if (port === 0) this.#writeSerial(userId, machine, bytes, full);
      }),
    );
    // The socket repeats this join after a reconnect and the server answers with `joined` again.
    socket.join(assignmentId);
  }

  /** Freezes or unfreezes the work of the whole class; the state changes when the server's `frozen` arrives. */
  freeze(frozen: boolean): boolean {
    return this.#options.socket.send({ type: "freeze", frozen });
  }

  /** What a port of a student's machine has printed so far, oldest first; `machine` is "" when the student names none. */
  serialHistory(userId: Id, machine: string, port: SerialPort): readonly Uint8Array[] {
    return this.#history.read(serialKey(userId, machine, port));
  }

  /** Live bytes of the port; `full` means the history was replaced. Returns the unsubscribe. */
  onSerial(userId: Id, machine: string, port: SerialPort, listener: SerialListener): () => void {
    return this.#history.listen(serialKey(userId, machine, port), listener);
  }

  /** Types into a port of the student's machine. false when the student is not in the room or the connection is down. */
  sendInput(userId: Id, data: string, target: { port: SerialPort; machine?: string }): boolean {
    const peer = this.#state.online[userId]?.peer;
    if (peer === undefined) return false;
    return this.#options.socket.send({ type: "input", to: peer, data, port: target.port, machine: target.machine });
  }

  dispose(): void {
    this.#disposed = true;
    this.#history.clear();
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const mirror of this.#mirrors.values()) mirror.dispose();
    this.#mirrors.clear();
    this.#options.socket.leave();
  }

  #addPeer(peer: Peer, online: Record<Id, StudentPresence>): void {
    if (peer.role !== "student") return;
    this.#users.set(peer.id, peer.user_id);
    online[peer.user_id] = { peer: peer.id, machines: peer.machines ?? [] };
  }

  #set(patch: Partial<TeacherRoomSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }

  async #load(): Promise<void> {
    const loadId = ++this.#loadId;
    this.#tilesDuringLoad = new Map();
    this.#loading = true;
    let list: StudentProgress[];
    try {
      list = await this.#options.fetchStudents(this.#options.assignmentId);
    } catch (error) {
      if (loadId === this.#loadId && !this.#disposed) {
        this.#loading = false;
        this.#set({ loadError: error });
      }
      return;
    }
    if (loadId !== this.#loadId || this.#disposed) return;
    this.#loading = false;
    const students = list.map((student) => this.#tilesDuringLoad.get(student.user_id) ?? student);
    const known = new Set(students.map((student) => student.user_id));
    for (const tile of this.#tilesDuringLoad.values()) if (!known.has(tile.user_id)) students.push(tile);
    this.#tilesDuringLoad = new Map();
    this.#set({ students, loaded: true, loadError: null });
  }

  #applyTile(progress: StudentProgress): void {
    if (this.#loading) this.#tilesDuringLoad.set(progress.user_id, progress);
    const students = [...this.#state.students];
    const index = students.findIndex((student) => student.user_id === progress.user_id);
    if (index === -1) students.push(progress);
    else students[index] = progress;
    this.#set({ students });
  }

  #writeSerial(userId: Id, machine: string, bytes: Uint8Array, full: boolean): void {
    const key = `${userId}/${machine}`;
    let mirror = this.#mirrors.get(key);
    if (!mirror) {
      mirror = new ScreenMirror();
      this.#mirrors.set(key, mirror);
    }
    const target = mirror;
    void target.write(bytes, full).then(() => {
      if (this.#disposed) return;
      const lines = target.lines();
      if (sameLines(this.#state.screens[userId]?.[machine], lines)) return;
      const screens = { ...this.#state.screens, [userId]: { ...this.#state.screens[userId], [machine]: lines } };
      this.#set({ screens });
    });
  }
}
