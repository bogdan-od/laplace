import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import { BranchJournals } from '../src/attempts/branch-journals';
import { journalSegments, pathBytes } from '../src/attempts/journal-path';
import { Db } from '../src/db/db';

/** Event number `n` as a journal event; the number is in `data`, `c` grows with it. */
const event = (n: number) => ({ t: 'serial', c: n, w: 0, data: String(n) });

interface BranchSpec {
  parent?: { id: number; event: number };
  /** Chunks of own events, each a list of event numbers. */
  chunks: number[][];
}

let db: Db;
let journals: BranchJournals;
let attemptId = 0;

before(() => {
  process.env.LAPLACE_DB = ':memory:';
  db = new Db();
  journals = new BranchJournals(db);
  const user = db.run(
    "INSERT INTO users (login, password_hash, name, role, created_at) VALUES ('u', 'x', 'U', 'student', 0)",
  ).id;
  const cls = db.run(
    "INSERT INTO classes (owner_id, name, invite_code, created_at) VALUES (?, 'C', 'AAAAAAAA', 0)",
    user,
  ).id;
  const assignment = db.run(
    `INSERT INTO assignments (class_id, kind, title, brief, topology, checks, hints, created_at)
     VALUES (?, 'task', 'T', '', '{}', '[]', '[]', 0)`,
    cls,
  ).id;
  attemptId = db.run(
    'INSERT INTO attempts (assignment_id, user_id, variant, created_at) VALUES (?, ?, 1, 0)',
    assignment,
    user,
  ).id;
});
after(() => db.onModuleDestroy());

/** Inserts a branch and its chunks the way the chunk route leaves them in the database. */
function addBranch(spec: BranchSpec): number {
  const fork = spec.parent?.event ?? 0;
  const id = db.run(
    `INSERT INTO branches (attempt_id, node_id, parent_id, fork_event, kind, author_id, header,
                           event_count, created_at, updated_at)
     VALUES (?, 'm1', ?, ?, ?, 1, '{"h":1}', ?, 0, 0)`,
    attemptId,
    spec.parent?.id ?? null,
    fork,
    spec.parent ? 'rollback' : 'start',
    fork,
  ).id;
  let count = fork;
  let bytes = 0;
  for (const numbers of spec.chunks) {
    const text = JSON.stringify(numbers.map(event));
    db.run(
      'INSERT INTO chunks (branch_id, first_event, event_count, bytes, events, received_at) VALUES (?, ?, ?, ?, ?, 0)',
      id,
      count,
      numbers.length,
      Buffer.byteLength(text),
      text,
    );
    count += numbers.length;
    bytes += Buffer.byteLength(text);
  }
  db.run(
    'UPDATE branches SET event_count = ?, bytes = ? WHERE id = ?',
    count,
    bytes,
    id,
  );
  return id;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

async function read(
  branchId: number,
  to?: number,
): Promise<{ header: unknown; numbers: number[] }> {
  const parts: string[] = [];
  for await (const part of journals.assemble(branchId, to)) {
    parts.push(String(part));
  }
  const journal = JSON.parse(parts.join('')) as {
    header: unknown;
    events: { data: string; c: number }[];
  };
  for (const e of journal.events) assert.equal(e.c, Number(e.data));
  return {
    header: journal.header,
    numbers: journal.events.map((e) => Number(e.data)),
  };
}

const eventCount = (branchId: number): number =>
  db.get<{ event_count: number }>(
    'SELECT event_count FROM branches WHERE id = ?',
    branchId,
  )?.event_count ?? -1;

describe('journal assembly over branches', () => {
  test('a start branch of three chunks is all its events in order', async () => {
    const start = addBranch({
      chunks: [range(0, 4), range(4, 7), range(7, 10)],
    });
    const { header, numbers } = await read(start);
    assert.deepEqual(numbers, range(0, 10));
    assert.deepEqual(header, { h: 1 });
  });

  test('an empty branch is a journal without events', async () => {
    const start = addBranch({ chunks: [] });
    assert.deepEqual((await read(start)).numbers, []);
  });

  test('a rollback to event 5 of 10 plus 3 own events', async () => {
    const start = addBranch({ chunks: [range(0, 6), range(6, 10)] });
    const rollback = addBranch({
      parent: { id: start, event: 5 },
      chunks: [[100, 101], [102]],
    });
    assert.deepEqual((await read(rollback)).numbers, [
      ...range(0, 5),
      100,
      101,
      102,
    ]);
    assert.equal(eventCount(rollback), 8);
    // The parent is unchanged by the fork.
    assert.deepEqual((await read(start)).numbers, range(0, 10));
  });

  test('a rollback to the very start has only its own events', async () => {
    const start = addBranch({ chunks: [range(0, 10)] });
    const rollback = addBranch({
      parent: { id: start, event: 0 },
      chunks: [[100, 101, 102]],
    });
    assert.deepEqual((await read(rollback)).numbers, [100, 101, 102]);
    assert.equal(eventCount(rollback), 3);
  });

  test('a fork at the end of the parent takes the whole parent', async () => {
    const start = addBranch({ chunks: [range(0, 10)] });
    const next = addBranch({
      parent: { id: start, event: 10 },
      chunks: [[100]],
    });
    assert.deepEqual((await read(next)).numbers, [...range(0, 10), 100]);
  });

  describe('three levels: start, rollback to 7, reply to 4 of the rollback', () => {
    let start = 0;
    let rollback = 0;
    let reply = 0;
    let continuation = 0;
    before(() => {
      start = addBranch({ chunks: [range(0, 5), range(5, 10)] });
      rollback = addBranch({
        parent: { id: start, event: 7 },
        chunks: [
          [100, 101, 102],
          [103, 104],
        ],
      });
      // Event 4 of the rollback's journal lies in the part it inherited from the start.
      reply = addBranch({
        parent: { id: rollback, event: 4 },
        chunks: [[200, 201]],
      });
      // Event 9 of the rollback's journal is its own event 102.
      continuation = addBranch({
        parent: { id: rollback, event: 9 },
        chunks: [[300]],
      });
    });

    test('every branch takes the right events of every ancestor', async () => {
      assert.deepEqual((await read(rollback)).numbers, [
        ...range(0, 7),
        100,
        101,
        102,
        103,
        104,
      ]);
      assert.deepEqual((await read(reply)).numbers, [...range(0, 4), 200, 201]);
      assert.deepEqual((await read(continuation)).numbers, [
        ...range(0, 7),
        100,
        101,
        300,
      ]);
      assert.equal(eventCount(reply), 6);
      assert.equal(eventCount(continuation), 10);
    });

    test('?to cuts at every level, also inside an inherited part and inside a chunk', async () => {
      assert.deepEqual((await read(start, 3)).numbers, range(0, 3));
      assert.deepEqual((await read(rollback, 3)).numbers, range(0, 3));
      assert.deepEqual((await read(rollback, 8)).numbers, [
        ...range(0, 7),
        100,
      ]);
      assert.deepEqual((await read(reply, 2)).numbers, range(0, 2));
      assert.deepEqual((await read(reply, 4)).numbers, range(0, 4));
      assert.deepEqual((await read(reply, 5)).numbers, [...range(0, 4), 200]);
      assert.deepEqual((await read(continuation, 8)).numbers, [
        ...range(0, 7),
        100,
      ]);
      assert.deepEqual((await read(continuation, 0)).numbers, []);
    });

    test('?to past the end gives the whole journal', async () => {
      assert.deepEqual((await read(reply, 1000)).numbers, [
        ...range(0, 4),
        200,
        201,
      ]);
    });

    test('lastEvent reads c and w at any fork', () => {
      const path = journals.path(continuation);
      assert.ok(path);
      assert.deepEqual(journals.lastEvent(path.branches, 9), { c: 101, w: 0 });
      assert.deepEqual(journals.lastEvent(path.branches, 10), { c: 300, w: 0 });
      assert.deepEqual(journals.lastEvent(path.branches, 3), { c: 2, w: 0 });
      assert.equal(journals.lastEvent(path.branches, 0), null);
    });
  });

  test('an unknown branch is 404', () => {
    assert.throws(() => journals.assemble(999_999), { status: 404 });
  });
});

describe('journal size along the path', () => {
  const branch = (id: number, fork: number, count: number, bytes: number) => ({
    id,
    fork_event: fork,
    event_count: count,
    bytes,
  });

  test('pathBytes counts the whole chunks of ancestors, also after the fork', () => {
    const path = [branch(1, 0, 10, 40), branch(2, 5, 8, 10)];
    assert.equal(pathBytes(path), 50);
    assert.ok(
      pathBytes([branch(1, 0, 10, MAX_JOURNAL_BYTES), branch(2, 5, 6, 1)]) >
        MAX_JOURNAL_BYTES,
    );
  });

  test('segments of a path with a fork below the parent fork', () => {
    const path = [branch(1, 0, 10, 0), branch(2, 7, 12, 0), branch(3, 4, 6, 0)];
    assert.deepEqual(journalSegments(path), [
      { branch_id: 1, from: 0, to: 4 },
      { branch_id: 3, from: 4, to: 6 },
    ]);
  });
});
