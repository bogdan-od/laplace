// The student's side of the assignment room: the machine's console output
// goes to teachers, teacher input comes back, the teacher can freeze the work. Works over the tab's `Socket`.

import { to_base64 } from "@core/net/base64.mjs";
import type { Socket } from "@/lib/socket";
import type { SerialPort } from "@shared/ws";
import { MAX_SERIAL_HISTORY_CHARS } from "@shared/limits";

export type RoomSocket = Pick<Socket, "on" | "send" | "join" | "leave">;

export type OutputEvent = { kind: "data"; port: SerialPort; bytes: Uint8Array } | { kind: "reset" };

/** What the room needs from one machine of the session. */
export interface RoomEndpoint {
  node: string;
  subscribe(listener: (event: OutputEvent) => void): () => void;
  /** The last bytes of the retained console output of a port. */
  history(port: SerialPort, maxBytes: number): Uint8Array;
  /** Teacher input: port 0 is typed as the teacher into the student's console, port 2 is the hidden terminal. */
  teacherInput(port: SerialPort, data: string): void;
}

export interface RoomLinkOptions {
  socket: RoomSocket;
  assignmentId: number;
  endpoints: readonly RoomEndpoint[];
  onFrozen(frozen: boolean): void;
  /** Called with the role the server gave: only a student sends output. */
  onJoined?(info: { id: string; role: "student" | "teacher" }): void;
  now?: () => number;
}

/** Output is sent at once unless a message went out less than this long ago; a timer sends the rest. */
export const FLUSH_MS = 100;
/** A history of this many bytes is below MAX_SERIAL_HISTORY_CHARS after base64 (4 chars per 3 bytes). */
export const HISTORY_BYTES = Math.floor((MAX_SERIAL_HISTORY_CHARS / 4) * 3) - 3;
/** A single serial message carries at most 64 KiB (base64 characters). */
export const PIECE_BYTES = 48 * 1024;
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63]);
const TEACHER_PORT: SerialPort = 2;

function isSerialPort(value: unknown): value is SerialPort {
  return value === 0 || value === 2;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface Mirror {
  endpoint: RoomEndpoint;
  port: SerialPort;
  pending: Uint8Array[];
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RoomLink {
  readonly #options: RoomLinkOptions;
  readonly #now: () => number;
  readonly #mirrors: Mirror[] = [];
  readonly #unsubscribe: (() => void)[] = [];
  #joined = false;
  #disposed = false;

  constructor(options: RoomLinkOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    for (const endpoint of options.endpoints) {
      for (const port of [0, TEACHER_PORT] as const) {
        this.#mirrors.push({ endpoint, port, pending: [], sentAt: -Infinity, timer: null });
      }
    }
  }

  get joined(): boolean {
    return this.#joined;
  }

  start(): void {
    const { socket, assignmentId, endpoints } = this.#options;
    this.#unsubscribe.push(
      socket.on("joined", (message) => this.#onJoined(message.id, message.role, message.frozen)),
      socket.on("peer-joined", (message) => {
        if (this.#joined && message.role === "teacher") this.#sendHistory();
      }),
      socket.on("input", (message) => {
        if (!this.#joined || !isSerialPort(message.port) || typeof message.data !== "string") return;
        this.#endpointFor(message.machine)?.teacherInput(message.port, message.data);
      }),
      socket.on("frozen", (message) => this.#options.onFrozen(message.frozen)),
    );
    for (const endpoint of endpoints) {
      this.#unsubscribe.push(endpoint.subscribe((event) => this.#onOutput(endpoint, event)));
    }
    socket.join(assignmentId, endpoints.map((endpoint) => endpoint.node));
  }

  dispose(): void {
    this.#disposed = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const mirror of this.#mirrors) {
      if (mirror.timer !== null) clearTimeout(mirror.timer);
      mirror.timer = null;
    }
    this.#options.socket.leave();
  }

  #endpointFor(machine: string | undefined): RoomEndpoint | undefined {
    const { endpoints } = this.#options;
    if (machine === undefined) return endpoints.length === 1 ? endpoints[0] : undefined;
    return endpoints.find((endpoint) => endpoint.node === machine);
  }

  #onJoined(id: string, role: "student" | "teacher", frozen: boolean): void {
    this.#options.onJoined?.({ id, role });
    this.#options.onFrozen(frozen);
    this.#joined = role === "student";
    // Output produced before the server knew us is part of the history sent now.
    for (const mirror of this.#mirrors) mirror.pending = [];
    if (this.#joined) this.#sendHistory();
  }

  #onOutput(endpoint: RoomEndpoint, event: OutputEvent): void {
    for (const mirror of this.#mirrors) {
      if (mirror.endpoint !== endpoint) continue;
      if (event.kind === "reset") {
        // ESC c clears the teacher's terminal; the machine then emits the output that survived the rollback.
        // Only the student console is re-emitted, so the hidden terminal of the teacher is left alone.
        if (mirror.port !== 0) continue;
        mirror.pending = this.#joined ? [TERMINAL_RESET] : [];
        this.#flush(mirror, true);
      } else if (event.port === mirror.port) {
        if (this.#joined) mirror.pending.push(event.bytes);
        // Browsers slow timers of a background tab to once a second, so a message is not left to the timer.
        this.#flush(mirror, false);
      }
    }
  }

  #flush(mirror: Mirror, force: boolean): void {
    if (this.#disposed || mirror.pending.length === 0) return;
    const wait = FLUSH_MS - (this.#now() - mirror.sentAt);
    if (!force && wait > 0) {
      mirror.timer ??= setTimeout(() => {
        mirror.timer = null;
        this.#flush(mirror, true);
      }, wait);
      return;
    }
    if (mirror.timer !== null) clearTimeout(mirror.timer);
    mirror.timer = null;
    const bytes = concat(mirror.pending.splice(0));
    for (let from = 0; from < bytes.length; from += PIECE_BYTES) {
      this.#send(mirror.endpoint.node, mirror.port, bytes.subarray(from, from + PIECE_BYTES), false);
    }
    mirror.sentAt = this.#now();
  }

  /** The whole retained output replaces the tile of the teacher: after a join, a reconnect, a new teacher. */
  #sendHistory(): void {
    for (const mirror of this.#mirrors) {
      mirror.pending = [];
      const history = mirror.endpoint.history(mirror.port, HISTORY_BYTES);
      if (history.length > 0) this.#send(mirror.endpoint.node, mirror.port, history, true);
    }
  }

  #send(machine: string, port: SerialPort, bytes: Uint8Array, full: boolean): void {
    const data = to_base64(bytes);
    const base = { type: "serial" as const, data, machine };
    const withPort = port === TEACHER_PORT ? { ...base, port } : base;
    this.#options.socket.send(full ? { ...withPort, full: true } : withPort);
  }
}
