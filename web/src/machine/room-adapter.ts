// Adapter that lets `Mesh` (app/net/mesh.mjs) run over the tab's `Socket` instead of `Room`.
// Mesh reads from the room: `id`, `peers`, `on("peer-joined" | "peer-left" | "signal" | "frame" | "joined")`
// and `send({ type: "signal" | "frame", to, data })`. The server's messages carry the same fields, so
// this is a translation of event names and of the member list.

import type { Room } from "@core/net/room.mjs";
import type { ClientMessage } from "@shared/ws";
import type { RoomSocket } from "./room-link";

type Handler = (message: never) => void;

const PEER_ID_RE = /^[pt]\d+$/;

interface PeerEntry {
  role: "student" | "teacher";
  name: string;
  machines?: string[];
}

export type MeshMessage =
  | { type: "signal"; to: string; data: unknown }
  | { type: "frame"; to: string; data: string };

export class MeshRoom {
  id = "";
  peers = new Map<string, PeerEntry>();
  readonly #socket: RoomSocket;
  readonly #handlers = new Map<string, Set<Handler>>();
  readonly #unsubscribe: (() => void)[];

  constructor(socket: RoomSocket) {
    this.#socket = socket;
    this.#unsubscribe = [
      socket.on("joined", (message) => {
        this.id = message.id;
        this.peers = new Map(message.peers.map((peer) => [peer.id, toEntry(peer)]));
        this.#emit("joined", message);
      }),
      socket.on("peer-joined", (message) => {
        this.peers.set(message.id, toEntry(message));
        this.#emit("peer-joined", message);
      }),
      socket.on("peer-left", (message) => {
        this.peers.delete(message.id);
        this.#emit("peer-left", message);
      }),
      socket.on("signal", (message) => this.#emit("signal", message)),
      socket.on("frame", (message) => this.#emit("frame", message)),
    ];
  }

  on(type: string, handler: Handler): void {
    const set = this.#handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.#handlers.set(type, set);
  }

  /** `false` means the message was not sent (no connection, or the recipient is not a valid member id). */
  send(message: MeshMessage): boolean {
    if (!PEER_ID_RE.test(message.to)) return false;
    const to = message.to as `p${number}` | `t${number}`;
    const outgoing: ClientMessage =
      message.type === "signal" ? { type: "signal", to, data: message.data } : { type: "frame", to, data: message.data };
    return this.#socket.send(outgoing);
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#handlers.clear();
  }

  #emit(type: string, message: unknown): void {
    for (const handler of [...(this.#handlers.get(type) ?? [])]) (handler as (value: unknown) => void)(message);
  }
}

function toEntry(peer: { role: "student" | "teacher"; name: string; machines?: string[] }): PeerEntry {
  const entry: PeerEntry = { role: peer.role, name: peer.name };
  if (peer.machines) entry.machines = peer.machines;
  return entry;
}

/**
 * `Mesh` is typed against the `Room` class, which has private fields, so no other object satisfies
 * the type. The members Mesh really uses are listed above; this is the one place that crosses the gap.
 */
export function asMeshRoom(room: MeshRoom): Room {
  return room as unknown as Room;
}
