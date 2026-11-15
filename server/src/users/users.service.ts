import { Injectable } from '@nestjs/common';
import type { Id, Me, Role } from '@shared/api';
import { Clock } from '../common/clock';
import { conflict } from '../common/api-exception';
import { Db, isUniqueViolation } from '../db/db';

export interface UserRow {
  id: Id;
  login: string;
  password_hash: string;
  name: string;
  role: Role;
  created_at: number;
  last_seen_at: number | null;
}

export interface NewUser {
  login: string;
  name: string;
  role: Role;
  passwordHash: string;
}

export const toMe = (
  user: Pick<UserRow, 'id' | 'login' | 'name' | 'role'>,
): Me => ({
  id: user.id,
  login: user.login,
  name: user.name,
  role: user.role,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The login must already be lower case. A taken login is 409 login_taken. */
  create(user: NewUser): Id {
    try {
      return this.db.run(
        'INSERT INTO users (login, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
        user.login,
        user.passwordHash,
        user.name,
        user.role,
        this.clock.now(),
      ).id;
    } catch (error) {
      if (isUniqueViolation(error, 'users.login')) {
        throw conflict('Цей логін уже зайнятий', 'login_taken');
      }
      throw error;
    }
  }

  byId(id: Id): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  byLogin(login: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE login = ?', login);
  }

  loginExists(login: string): boolean {
    return (
      this.db.get('SELECT 1 AS found FROM users WHERE login = ?', login) !==
      undefined
    );
  }

  rename(id: Id, name: string): void {
    this.db.run('UPDATE users SET name = ? WHERE id = ?', name, id);
  }

  setPasswordHash(id: Id, passwordHash: string): void {
    this.db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      passwordHash,
      id,
    );
  }
}
