import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from './db';

function memoryDb(): Db {
  process.env.LAPLACE_DB = ':memory:';
  return new Db();
}

test('Db applies schema.sql to an empty database and enables foreign keys', () => {
  const db = memoryDb();
  assert.ok(db.userVersion() > 0);
  assert.equal(db.sql.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  db.onModuleDestroy();
});

test('Db migrates a database left at version 1 and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'laplace-db-'));
  process.env.LAPLACE_DB = join(dir, 'old.sqlite');
  try {
    const old = new Db();
    old.sql.exec(
      `DROP TABLE lti_grade_links; DROP TABLE lti_users; DROP TABLE lti_states;
       DROP TABLE lti_tool_keys; DROP TABLE lti_platforms; PRAGMA user_version = 1`,
    );
    old.run(
      "INSERT INTO users (login, password_hash, name, role, created_at) VALUES ('kept', 'x', 'n', 'teacher', 0)",
    );
    old.onModuleDestroy();
    const migrated = new Db();
    assert.equal(migrated.userVersion(), 2);
    assert.equal(
      migrated.get<{ n: number }>('SELECT COUNT(*) AS n FROM lti_platforms')?.n,
      0,
    );
    assert.equal(
      migrated.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n,
      1,
    );
    migrated.onModuleDestroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Db.tx commits, rolls back on an exception, and nested calls join the outer one', () => {
  const db = memoryDb();
  const insert = (login: string): void => {
    db.run(
      "INSERT INTO users (login, password_hash, name, role, created_at) VALUES (?, 'x', 'n', 'teacher', 0)",
      login,
    );
  };
  const count = (): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? -1;

  db.tx(() => {
    insert('a');
    db.tx(() => insert('b'));
  });
  assert.equal(count(), 2);

  assert.throws(() =>
    db.tx(() => {
      insert('c');
      db.tx(() => insert('d'));
      throw new Error('boom');
    }),
  );
  assert.equal(count(), 2);
  db.onModuleDestroy();
});

test('Db.afterCommit runs after commit and is dropped on rollback', () => {
  const db = memoryDb();
  const seen: string[] = [];
  db.tx(() => {
    db.afterCommit(() => seen.push('committed'));
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, ['committed']);
  assert.throws(() =>
    db.tx(() => {
      db.afterCommit(() => seen.push('rolled back'));
      throw new Error('boom');
    }),
  );
  assert.deepEqual(seen, ['committed']);
  db.afterCommit(() => seen.push('outside'));
  assert.deepEqual(seen, ['committed', 'outside']);
  db.onModuleDestroy();
});
