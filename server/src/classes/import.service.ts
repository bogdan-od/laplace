import { Injectable } from '@nestjs/common';
import type { ImportedStudent, ImportResult, Id } from '@shared/api';
import {
  LOGIN_RE,
  MAX_NAME_CHARS,
  MAX_STUDENTS_PER_CLASS,
} from '@shared/limits';
import type { AuthUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { Db } from '../db/db';
import { hashPassword } from '../users/password';
import { UsersService } from '../users/users.service';
import { Access } from './access.service';
import { CsvLineError, CsvRow, parseStudentsCsv } from './csv';
import { newStudentPassword } from './invite-code';
import { classFullMessage, MembershipService } from './membership.service';
import { transliterate } from './translit';

/** Passwords are hashed this many at a time: scrypt runs in the libuv pool (4 threads by default). */
const HASH_BATCH = 8;
const MIN_LOGIN_CHARS = 3;
const MAX_LOGIN_BASE_CHARS = 28;
const FALLBACK_LOGIN = 'student';

interface PreparedRow {
  row: CsvRow;
  password: string;
  hash: string;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
    private readonly users: UsersService,
    private readonly membership: MembershipService,
  ) {}

  /** Every line is its own transaction: a bad line does not cancel the others. */
  async importStudents(
    user: AuthUser,
    classId: Id,
    csv: string,
  ): Promise<ImportResult> {
    this.access.require(user.id, classId, 'teacher');
    const parsed = parseStudentsCsv(csv);
    const created: ImportedStudent[] = [];
    const errors: CsvLineError[] = [...parsed.errors];
    for (let i = 0; i < parsed.rows.length; i += HASH_BATCH) {
      const batch = parsed.rows.slice(i, i + HASH_BATCH);
      if (this.studentCount(classId) >= MAX_STUDENTS_PER_CLASS) {
        for (const row of parsed.rows.slice(i)) {
          errors.push({ line: row.line, message: classFullMessage() });
        }
        break;
      }
      for (const item of await this.prepare(batch)) {
        const outcome = this.createStudent(classId, item);
        if ('message' in outcome) errors.push(outcome);
        else created.push(outcome);
      }
    }
    errors.sort((a, b) => a.line - b.line);
    return { created, errors };
  }

  private prepare(rows: CsvRow[]): Promise<PreparedRow[]> {
    return Promise.all(
      rows.map(async (row) => {
        const password = newStudentPassword();
        return { row, password, hash: await hashPassword(password) };
      }),
    );
  }

  private createStudent(
    classId: Id,
    { row, password, hash }: PreparedRow,
  ): ImportedStudent | CsvLineError {
    if (row.name.length > MAX_NAME_CHARS) {
      return {
        line: row.line,
        message: `Ім’я довше за ${MAX_NAME_CHARS} символів`,
      };
    }
    try {
      return this.db.tx(() => {
        const login = this.loginFor(row);
        const id = this.users.create({
          login,
          name: row.name,
          role: 'student',
          passwordHash: hash,
        });
        const { number } = this.membership.joinAsStudent(
          classId,
          { id },
          { record: false },
        );
        return { name: row.name, login, number, password };
      });
    } catch (error) {
      if (error instanceof ApiException) {
        return { line: row.line, message: error.message };
      }
      throw error;
    }
  }

  private loginFor(row: CsvRow): string {
    if (row.login === null) return this.freeLogin(row.name);
    const login = row.login.toLowerCase();
    if (!LOGIN_RE.test(login)) {
      throw new ApiException(
        400,
        `Логін "${row.login}" не підходить: 3-32 символи, малі латинські літери, цифри та . _ -`,
      );
    }
    if (this.users.loginExists(login)) {
      throw new ApiException(409, `Логін "${login}" уже зайнятий`);
    }
    return login;
  }

  /** Surname in Latin; a number is appended (2, 3, ...) while the login is taken or too short. */
  private freeLogin(name: string): string {
    const surname = name.split(' ')[0] ?? '';
    const base =
      transliterate(surname).slice(0, MAX_LOGIN_BASE_CHARS) || FALLBACK_LOGIN;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}${n}`;
      if (
        candidate.length >= MIN_LOGIN_CHARS &&
        !this.users.loginExists(candidate)
      ) {
        return candidate;
      }
    }
  }

  private studentCount(classId: Id): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'student'",
      classId,
    );
    return row?.n ?? 0;
  }
}
