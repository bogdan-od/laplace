import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { repoRoot } from '../repo-root';

export const DB_FILE = join('data', 'laplace.sqlite');
const SCHEMA_FILE = join('server', 'src', 'db', 'schema.sql');
const MIGRATIONS_DIR = join('server', 'src', 'db', 'migrations');
const MIGRATION_FILE = /^(\d+)-.*\.sql$/;

export type SqlParam = null | number | bigint | string;

export interface RunResult {
  changes: number;
  /** Row id of the last INSERT on this connection. */
  id: number;
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly sql: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTx = false;
  private commitHooks: (() => void)[] = [];

  constructor() {
    const root = repoRoot();
    const file = process.env.LAPLACE_DB ?? join(root, DB_FILE);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL');
    this.sql.exec('PRAGMA foreign_keys = ON');
    if (this.userVersion() === 0) {
      // schema.sql sets PRAGMA user_version itself.
      this.sql.exec(readFileSync(join(root, SCHEMA_FILE), 'utf8'));
    }
    this.migrate(join(root, MIGRATIONS_DIR));
  }

  userVersion(): number {
    const row = this.sql.prepare('PRAGMA user_version').get();
    return Number(row?.user_version ?? 0);
  }

  /**
   * The row type R is declared by the caller next to its SQL. Values come from SQLite, whose
   * column types STRICT tables guarantee, so the row is not re-validated here.
   */
  get<R>(query: string, ...params: SqlParam[]): R | undefined {
    return this.statement(query).get(...params) as R | undefined;
  }

  all<R>(query: string, ...params: SqlParam[]): R[] {
    return this.statement(query).all(...params) as R[];
  }

  run(query: string, ...params: SqlParam[]): RunResult {
    const result = this.statement(query).run(...params);
    return {
      changes: Number(result.changes),
      id: Number(result.lastInsertRowid),
    };
  }

  /**
   * Runs fn in BEGIN IMMEDIATE ... COMMIT; an exception rolls back. A nested call joins the outer
   * transaction. fn must be synchronous: nothing may interleave with an open transaction.
   */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    let result: T;
    try {
      result = fn();
      if (isThenable(result)) {
        throw new Error('Db.tx callback must be synchronous');
      }
      this.sql.exec('COMMIT');
    } catch (error) {
      this.commitHooks = [];
      this.inTx = false;
      this.rollback();
      throw error;
    }
    this.inTx = false;
    const hooks = this.commitHooks;
    this.commitHooks = [];
    for (const hook of hooks) hook();
    return result;
  }

  /** Runs fn after the current transaction commits (at once outside a transaction). */
  afterCommit(fn: () => void): void {
    if (this.inTx) this.commitHooks.push(fn);
    else fn();
  }

  onModuleDestroy(): void {
    this.sql.close();
  }

  /** Runs the migrations numbered above user_version, in order; each file sets user_version itself. */
  private migrate(dir: string): void {
    const pending = readdirSync(dir)
      .flatMap((file) => {
        const number = Number(MIGRATION_FILE.exec(file)?.[1]);
        return Number.isInteger(number) ? [{ file, number }] : [];
      })
      .sort((a, b) => a.number - b.number);
    for (const { file, number } of pending) {
      if (number <= this.userVersion()) continue;
      this.sql.exec(readFileSync(join(dir, file), 'utf8'));
    }
  }

  private statement(query: string): StatementSync {
    let statement = this.statements.get(query);
    if (!statement) {
      statement = this.sql.prepare(query);
      this.statements.set(query, statement);
    }
    return statement;
  }

  private rollback(): void {
    try {
      this.sql.exec('ROLLBACK');
    } catch {
      // SQLite already rolled the transaction back on its own (for example after a full disk).
    }
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** True for SQLite's UNIQUE violation on the given column list, e.g. "users.login". */
export function isUniqueViolation(error: unknown, columns: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`UNIQUE constraint failed: ${columns}`)
  );
}
