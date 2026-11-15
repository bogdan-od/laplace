import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import { SESSION_TTL_MS } from '@shared/limits';
import { createHash, randomBytes } from 'node:crypto';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { AuthUser } from './auth.types';

const TOKEN_BYTES = 32;
const LAST_SEEN_STEP_MS = 60_000;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Returns the cookie token; only its sha256 is stored. */
  create(userId: Id): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.clock.now();
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      hashToken(token),
      userId,
      now,
      now + SESSION_TTL_MS,
    );
    return token;
  }

  /** The user of a live session, or undefined. Also used by the WebSocket gateway. */
  userFromToken(token: unknown): AuthUser | undefined {
    if (typeof token !== 'string' || token === '') return undefined;
    const now = this.clock.now();
    const row = this.db.get<AuthUser & { last_seen_at: number | null }>(
      `SELECT u.id, u.login, u.name, u.role, u.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      hashToken(token),
      now,
    );
    if (!row) return undefined;
    if (
      row.last_seen_at === null ||
      now - row.last_seen_at >= LAST_SEEN_STEP_MS
    ) {
      this.db.run(
        'UPDATE users SET last_seen_at = ? WHERE id = ?',
        now,
        row.id,
      );
    }
    return { id: row.id, login: row.login, name: row.name, role: row.role };
  }

  destroy(token: unknown): void {
    if (typeof token !== 'string') return;
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  }

  /** Drops every session of the user except the one with the given token. */
  destroyOthers(userId: Id, keepToken: unknown): void {
    const keep = typeof keepToken === 'string' ? hashToken(keepToken) : '';
    this.db.run(
      'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?',
      userId,
      keep,
    );
  }
}
