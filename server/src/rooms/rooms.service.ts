import { Injectable, Logger } from '@nestjs/common';
import type { Assignment, Id } from '@shared/api';
import type { ClientMessage, Peer, PeerId, ServerMessage } from '@shared/ws';
import { AssignmentsService } from '../assignments/assignments.service';
import { ApiException } from '../common/api-exception';
import { Access } from '../classes/access.service';
import { Clock } from '../common/clock';
import { describeError } from '../runner/describe-error';
import { Connection, Room, Seat } from './connection';
import { TeacherInputs } from './teacher-inputs';

/** A user who left a room less than this long ago comes back with `resumed: true`. */
const RESUME_WINDOW_MS = 6 * 3600_000;
const NOT_FOUND_TEXT = 'Завдання не знайдено';
const SERVER_ERROR_TEXT = 'Помилка сервера';

type JoinMessage = Extract<ClientMessage, { type: 'join' }>;

const departureKey = (assignmentId: Id, userId: Id): string =>
  `${assignmentId}:${userId}`;

/** Rooms of assignments and the forwarding inside them. */
@Injectable()
export class RoomsService {
  private readonly log = new Logger(RoomsService.name);
  private readonly rooms = new Map<Id, Room>();
  /** When a user last left a room, for `resumed`; swept lazily. */
  private readonly departures = new Map<string, number>();

  constructor(
    private readonly assignments: AssignmentsService,
    private readonly access: Access,
    private readonly teacherInputs: TeacherInputs,
    private readonly clock: Clock,
  ) {}

  /** Connections of the teachers in the room of an assignment. */
  teachersOf(assignmentId: Id): Connection[] {
    const room = this.rooms.get(assignmentId);
    if (!room) return [];
    return [...room.peers.values()].filter(
      (peer) => peer.seat?.role === 'teacher',
    );
  }

  /** Applies a validated message of a connection. Never throws. */
  handle(connection: Connection, message: ClientMessage): void {
    try {
      this.dispatch(connection, message);
    } catch (error) {
      this.log.error(
        `message "${message.type}" failed: ${describeError(error)}`,
      );
    }
  }

  /** The connection closed: leave its room. */
  leave(connection: Connection): void {
    const seat = connection.seat;
    if (!seat) return;
    connection.seat = null;
    const { room } = seat;
    if (room.peers.get(seat.id) === connection) {
      room.peers.delete(seat.id);
      this.broadcast(room, { type: 'peer-left', id: seat.id });
    }
    this.departures.set(
      departureKey(room.assignmentId, connection.user.id),
      this.clock.now(),
    );
    if (room.peers.size === 0 && this.rooms.get(room.assignmentId) === room) {
      this.rooms.delete(room.assignmentId);
    }
  }

  private dispatch(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        connection.pinged = true;
        connection.send({ type: 'pong' });
        return;
      case 'join':
        this.join(connection, message);
        return;
      case 'signal':
      case 'frame':
      case 'serial':
      case 'input':
      case 'freeze':
        if (connection.seat) this.forward(connection, connection.seat, message);
        return;
      default: {
        const unhandled: never = message;
        throw new Error(`unhandled message ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private forward(
    from: Connection,
    seat: Seat,
    message: Exclude<ClientMessage, { type: 'join' | 'ping' }>,
  ): void {
    switch (message.type) {
      case 'signal':
        this.send(seat, message.to, {
          type: 'signal',
          from: seat.id,
          data: message.data,
        });
        return;
      case 'frame':
        if (seat.role === 'student' && seat.room.sharedLan) {
          this.sendToStudent(seat, message.to, {
            type: 'frame',
            from: seat.id,
            data: message.data,
          });
        }
        return;
      case 'serial':
        this.serial(seat, message);
        return;
      case 'input':
        this.input(from, seat, message);
        return;
      case 'freeze':
        this.freeze(from, seat, message.frozen);
        return;
      default: {
        const unhandled: never = message;
        throw new Error(`unhandled message ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private serial(
    seat: Seat,
    message: Extract<ClientMessage, { type: 'serial' }>,
  ): void {
    if (seat.role !== 'student') return;
    if (
      message.machine !== undefined &&
      !seat.room.machines.has(message.machine)
    ) {
      return;
    }
    const forwarded: ServerMessage = {
      type: 'serial',
      from: seat.id,
      data: message.data,
      ...(message.port === undefined ? {} : { port: message.port }),
      ...(message.machine === undefined ? {} : { machine: message.machine }),
      ...(message.full ? { full: message.full } : {}),
    };
    for (const peer of seat.room.peers.values()) {
      if (peer.seat?.role === 'teacher') peer.send(forwarded);
    }
  }

  private input(
    from: Connection,
    seat: Seat,
    message: Extract<ClientMessage, { type: 'input' }>,
  ): void {
    if (seat.role !== 'teacher') return;
    const target = seat.room.peers.get(message.to);
    if (target?.seat?.role !== 'student') return;
    const nodeId = this.inputMachine(seat.room, message.machine);
    if (nodeId === undefined) return;
    // The row goes first: a teacher's input that was delivered is always on record.
    this.teacherInputs.record({
      assignmentId: seat.room.assignmentId,
      studentId: target.user.id,
      nodeId,
      port: message.port,
      data: message.data,
      authorId: from.user.id,
    });
    target.send({
      type: 'input',
      from: seat.id,
      data: message.data,
      port: message.port,
      ...(message.machine === undefined ? {} : { machine: message.machine }),
    });
  }

  /** The machine an input is for; one without `machine` is for the only machine of a one-machine topology. */
  private inputMachine(
    room: Room,
    machine: string | undefined,
  ): string | undefined {
    if (machine !== undefined)
      return room.machines.has(machine) ? machine : undefined;
    return room.machines.size === 1 ? [...room.machines][0] : undefined;
  }

  private freeze(from: Connection, seat: Seat, frozen: boolean): void {
    if (seat.role !== 'teacher') return;
    this.assignments.setFrozen(seat.room.assignmentId, frozen);
    this.broadcast(seat.room, {
      type: 'frozen',
      frozen,
      by: { id: from.user.id, name: from.user.name },
    });
  }

  private join(connection: Connection, message: JoinMessage): void {
    this.leave(connection);
    const prepared = this.prepareSeat(connection, message);
    if (typeof prepared === 'string') {
      connection.send({ type: 'error', message: prepared });
      return;
    }
    const { assignment, seatId, role, machines } = prepared;
    const room = this.roomFor(assignment);
    const key = departureKey(room.assignmentId, connection.user.id);
    const left = this.departures.get(key);
    const present = room.peers.get(seatId);
    const resumed =
      present !== undefined ||
      (left !== undefined && this.clock.now() - left < RESUME_WINDOW_MS);
    this.departures.delete(key);
    this.sweepDepartures();
    if (present) this.replace(room, present);
    const others = [...room.peers.values()];
    connection.seat = { room, id: seatId, role, machines };
    room.peers.set(seatId, connection);
    connection.send({
      type: 'joined',
      id: seatId,
      role,
      peers: others.map((peer) => this.describe(peer)),
      frozen: assignment.frozen,
      resumed,
    });
    const joined: ServerMessage = {
      type: 'peer-joined',
      ...this.describe(connection),
    };
    for (const peer of others) peer.send(joined);
  }

  /** What the user may be in this room, or the text of the error to send. */
  private prepareSeat(
    connection: Connection,
    message: JoinMessage,
  ):
    | string
    | {
        assignment: Assignment;
        seatId: PeerId;
        role: 'student' | 'teacher';
        machines: string[] | undefined;
      } {
    let assignment: Assignment;
    try {
      assignment = this.assignments.get(connection.user, message.assignment_id);
    } catch (error) {
      if (error instanceof ApiException) return error.message;
      this.log.error(`join failed: ${describeError(error)}`);
      return SERVER_ERROR_TEXT;
    }
    const classRole = this.access.roleOf(
      connection.user.id,
      assignment.class_id,
    );
    if (classRole === null) return NOT_FOUND_TEXT;
    const known = new Set(
      assignment.topology.machines.map((machine) => machine.id),
    );
    if (!(message.machines ?? []).every((machine) => known.has(machine))) {
      return 'Невідома машина в топології завдання';
    }
    if (classRole !== 'student') {
      return {
        assignment,
        seatId: `t${connection.user.id}`,
        role: 'teacher',
        machines: undefined,
      };
    }
    const number = this.access.studentNumber(
      connection.user.id,
      assignment.class_id,
    );
    if (number === null) return NOT_FOUND_TEXT;
    return {
      assignment,
      seatId: `p${number}`,
      role: 'student',
      machines: message.machines,
    };
  }

  private roomFor(assignment: Assignment): Room {
    const room = this.rooms.get(assignment.id) ?? {
      assignmentId: assignment.id,
      classId: assignment.class_id,
      machines: new Set<string>(),
      sharedLan: false,
      peers: new Map<PeerId, Connection>(),
    };
    room.machines = new Set(
      assignment.topology.machines.map((machine) => machine.id),
    );
    room.sharedLan = assignment.shared_lan;
    this.rooms.set(assignment.id, room);
    return room;
  }

  /** The second connection of one user takes the seat: the first is told and closed. */
  private replace(room: Room, old: Connection): void {
    const seat = old.seat;
    if (!seat) return;
    old.seat = null;
    room.peers.delete(seat.id);
    old.send({ type: 'replaced' });
    old.socket.close(1000, 'replaced');
    this.broadcast(room, { type: 'peer-left', id: seat.id });
  }

  private describe(connection: Connection): Peer {
    const seat = connection.seat;
    if (!seat) throw new Error('describe: connection is not in a room');
    return {
      id: seat.id,
      user_id: connection.user.id,
      role: seat.role,
      name: connection.user.name,
      ...(seat.machines ? { machines: seat.machines } : {}),
    };
  }

  private broadcast(room: Room, message: ServerMessage): void {
    for (const peer of room.peers.values()) peer.send(message);
  }

  private send(seat: Seat, to: PeerId, message: ServerMessage): void {
    if (to === seat.id) return;
    seat.room.peers.get(to)?.send(message);
  }

  private sendToStudent(seat: Seat, to: PeerId, message: ServerMessage): void {
    if (to === seat.id) return;
    const target = seat.room.peers.get(to);
    if (target?.seat?.role === 'student') target.send(message);
  }

  private sweepDepartures(): void {
    const limit = this.clock.now() - RESUME_WINDOW_MS;
    for (const [key, at] of this.departures) {
      if (at < limit) this.departures.delete(key);
    }
  }
}
