import type { IncomingMessage } from 'node:http';
import {
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { MAX_WS_MESSAGE_BYTES } from '@shared/limits';
import type { RawData, WebSocket } from 'ws';
import { SESSION_COOKIE } from '../auth/auth.types';
import { SessionService } from '../auth/session.service';
import { Clock } from '../common/clock';
import { describeError } from '../runner/describe-error';
import { parseClientMessage } from './client-messages';
import { Connection } from './connection';
import { Connections } from './connections';
import { RoomsService } from './rooms.service';
import { WsConfig } from './ws-config';

/** Close code for a connection without a session. */
const CLOSE_NOT_LOGGED_IN = 4401;

/**
 * A ws server drops a connection whose frame exceeds `maxPayload`; the contract wants such a
 * message ignored, so the limit sits well above MAX_WS_MESSAGE_BYTES and is only a memory bound.
 */
const MAX_PAYLOAD_BYTES = 4 * MAX_WS_MESSAGE_BYTES;

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

@WebSocketGateway({ path: '/ws', maxPayload: MAX_PAYLOAD_BYTES })
export class RoomsGateway
  implements
    OnGatewayConnection,
    OnModuleInit,
    OnModuleDestroy,
    OnApplicationShutdown
{
  private readonly log = new Logger(RoomsGateway.name);
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    private readonly sessions: SessionService,
    private readonly rooms: RoomsService,
    private readonly connections: Connections,
    private readonly config: WsConfig,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.sweep = setInterval(() => this.dropSilent(), this.config.sweepMs);
    this.sweep.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweep);
  }

  onApplicationShutdown(): void {
    for (const connection of this.connections.all()) {
      connection.socket.terminate();
    }
  }

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const user = this.sessions.userFromToken(
      cookieValue(request.headers.cookie, SESSION_COOKIE),
    );
    if (!user) {
      socket.close(CLOSE_NOT_LOGGED_IN, 'not logged in');
      return;
    }
    const connection = new Connection(socket, user, Date.now());
    this.connections.add(connection);
    socket.on('message', (data, isBinary) =>
      this.onMessage(connection, data, isBinary),
    );
    socket.on('close', () => this.onClose(connection));
  }

  private onMessage(
    connection: Connection,
    data: RawData,
    isBinary: boolean,
  ): void {
    connection.lastSeenAt = Date.now();
    if (isBinary || byteLength(data) > MAX_WS_MESSAGE_BYTES) return;
    try {
      const message = parseClientMessage(decode(data));
      if (message) this.rooms.handle(connection, message);
    } catch (error) {
      this.log.error(`message failed: ${describeError(error)}`);
    }
  }

  private onClose(connection: Connection): void {
    this.connections.remove(connection);
    try {
      this.rooms.leave(connection);
    } catch (error) {
      this.log.error(`leaving a room failed: ${describeError(error)}`);
    }
  }

  /** Drops the clients that pinged and then went quiet. */
  private dropSilent(): void {
    const limit = Date.now() - this.config.staleMs;
    for (const connection of this.connections.all()) {
      if (connection.pinged && connection.lastSeenAt < limit) {
        connection.socket.terminate();
      }
    }
  }
}
