import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import type { ServerMessage } from '@shared/ws';
import type { Connection } from './connection';

/** Every open connection, by user: the addressees of personal messages. */
@Injectable()
export class Connections {
  private readonly byUser = new Map<Id, Set<Connection>>();

  add(connection: Connection): void {
    const set = this.byUser.get(connection.user.id) ?? new Set();
    set.add(connection);
    this.byUser.set(connection.user.id, set);
  }

  remove(connection: Connection): void {
    const set = this.byUser.get(connection.user.id);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.byUser.delete(connection.user.id);
  }

  all(): Connection[] {
    return [...this.byUser.values()].flatMap((set) => [...set]);
  }

  /** Sends to every connection of the users. */
  sendToUsers(userIds: Iterable<Id>, message: ServerMessage): void {
    for (const userId of new Set(userIds)) {
      for (const connection of this.byUser.get(userId) ?? []) {
        connection.send(message);
      }
    }
  }
}
