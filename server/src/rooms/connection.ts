import type { Id } from '@shared/api';
import type { PeerId } from '@shared/ws';
import type { ServerMessage } from '@shared/ws';
import type { AuthUser } from '../auth/auth.types';

/** ws `readyState` of an open socket. */
const OPEN = 1;

/** A client that does not read is closed once this much waits in its send buffer. */
export const MAX_BUFFERED_BYTES = 4 * 2 ** 20;

/** The part of a ws `WebSocket` that a connection uses; tests pass a fake. */
export interface Socket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface Room {
  readonly assignmentId: Id;
  readonly classId: Id;
  machines: ReadonlySet<string>;
  sharedLan: boolean;
  readonly peers: Map<PeerId, Connection>;
}

export interface Seat {
  readonly room: Room;
  readonly id: PeerId;
  readonly role: 'student' | 'teacher';
  readonly machines: string[] | undefined;
}

/** One authenticated WebSocket of one tab. */
export class Connection {
  /** Set while the connection is in an assignment room. */
  seat: Seat | null = null;
  /** The client has sent `ping`, so its silence means it is gone. */
  pinged = false;
  lastSeenAt: number;

  constructor(
    readonly socket: Socket,
    readonly user: AuthUser,
    now: number,
  ) {
    this.lastSeenAt = now;
  }

  /** False if the message was not sent; a client with a full buffer is dropped on the spot. */
  send(message: ServerMessage): boolean {
    if (this.socket.readyState !== OPEN) return false;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.socket.terminate();
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }
}
