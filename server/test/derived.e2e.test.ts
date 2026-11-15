import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';
import type { ApiError, Assignment, Topology } from '@shared/api';
import { JournalAssembly, NO_BRANCHES } from '../src/journals/journal-assembly';
import { createItem, Item, journalText, PAIR, putJournal } from './fixtures';
import {
  Client,
  createClass,
  createTestApp,
  studentClient,
  teacherClient,
  TestApp,
  whoAmI,
} from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});
// These tests stand in for the journal assembler; the real one is tested in submit.e2e.test.ts.
beforeEach(() => {
  t.app.get(JournalAssembly).use(NO_BRANCHES);
});
afterEach(() => {
  t.app.get(JournalAssembly).use(NO_BRANCHES);
});

const error = (res: { body: unknown }): ApiError => res.body as ApiError;
const EVENTS = 5;

interface Seeded {
  owner: Client;
  assistant: Client;
  stranger: Client;
  student: Client;
  submissionId: number;
  branchId: number;
  assignment: Assignment;
}

/** An assignment with one student attempt: a start branch and a submission (attempt tables, inserted directly). */
async function seed(topology: Topology | null = null): Promise<Seeded> {
  const owner = await teacherClient(t);
  const assistant = await teacherClient(t);
  const stranger = await teacherClient(t);
  const { id: classId, code } = await createClass(owner);
  const student = await studentClient(t, code);
  await owner
    .post(`/api/classes/${classId}/assistants`)
    .send({ login: (await whoAmI(assistant)).login })
    .expect(201);
  const item = await createItem(owner, topology ? { topology } : {});
  await putJournal(owner, item.id, journalText());
  const assignment = (
    await owner
      .post(`/api/library/${item.id}/assign`)
      .send({
        class_id: classId,
        due_at: null,
        max_grade: 10,
        shared_lan: false,
      })
      .expect(201)
  ).body as Assignment;
  const me = await whoAmI(student);
  const attempt = t.db.run(
    'INSERT INTO attempts (assignment_id, user_id, variant, created_at) VALUES (?, ?, 1, 0)',
    assignment.id,
    me.id,
  ).id;
  const branchId = t.db.run(
    `INSERT INTO branches (attempt_id, node_id, parent_id, fork_event, kind, author_id, header, event_count, created_at, updated_at)
     VALUES (?, 'm1', NULL, 0, 'start', ?, '{}', ?, 0, 0)`,
    attempt,
    me.id,
    EVENTS,
  ).id;
  const submissionId = t.db.run(
    'INSERT INTO submissions (attempt_id, created_at) VALUES (?, 0)',
    attempt,
  ).id;
  t.db.run(
    `INSERT INTO submission_journals (submission_id, node_id, branch_id, event_count, digest)
     VALUES (?, 'm1', ?, ?, 'd')`,
    submissionId,
    branchId,
    EVENTS,
  );
  return {
    owner,
    assistant,
    stranger,
    student,
    submissionId,
    branchId,
    assignment,
  };
}

function fakeAssembler(text: string): [number, number | undefined][] {
  const calls: [number, number | undefined][] = [];
  t.app.get(JournalAssembly).use({
    assemble: (branchId, to) => {
      calls.push([branchId, to]);
      return Readable.from([Buffer.from(text)]);
    },
  });
  return calls;
}

const readJournal = async (client: Client, itemId: number): Promise<unknown> =>
  (
    await client
      .get(`/api/library/${itemId}/journals/m1?role=start`)
      .expect(200)
  ).body;

describe('POST /api/library/lesson-from-submission', () => {
  const url = '/api/library/lesson-from-submission';

  test('401, 403 for a student account, 400 on a wrong body, 404 for an unknown submission', async () => {
    const s = await seed();
    await t
      .client()
      .post(url)
      .send({ submission_id: 1, node: 'm1' })
      .expect(401);
    await s.student
      .post(url)
      .send({ submission_id: s.submissionId, node: 'm1' })
      .expect(403);
    await s.owner.post(url).send({ node: 'm1' }).expect(400);
    await s.owner.post(url).send({ submission_id: 0, node: 'm1' }).expect(400);
    await s.owner.post(url).send({ submission_id: s.submissionId }).expect(400);
    await s.owner
      .post(url)
      .send({ submission_id: s.submissionId, node: 'm1', x: 1 })
      .expect(400);
    const res = await s.owner
      .post(url)
      .send({ submission_id: 999_999, node: 'm1' })
      .expect(404);
    assert.equal(error(res).message, 'Спробу не знайдено');
  });

  test('a teacher of another class gets 404, a teacher of this class 404 until the submission is assembled', async () => {
    const s = await seed();
    const body = { submission_id: s.submissionId, node: 'm1' };
    await s.stranger.post(url).send(body).expect(404);
    for (const who of [s.owner, s.assistant]) {
      const res = await who.post(url).send(body).expect(404);
      assert.equal(error(res).message, 'Спробу не знайдено');
    }
  });

  test('a node outside the assignment and a multi-machine submission are 400', async () => {
    const s = await seed();
    const res = await s.owner
      .post(url)
      .send({ submission_id: s.submissionId, node: 'zzz' })
      .expect(400);
    assert.match(error(res).message, /zzz/);
    const pair = await seed(PAIR);
    const many = await pair.owner
      .post(url)
      .send({ submission_id: pair.submissionId, node: 'm1' })
      .expect(400);
    assert.match(error(many).message, /однією машиною/);
  });

  test('with an assembler it makes a lesson without header.lesson', async () => {
    const s = await seed();
    const calls = fakeAssembler(journalText({ events: EVENTS, lesson: true }));
    const res = await s.assistant
      .post(url)
      .send({ submission_id: s.submissionId, node: 'm1' })
      .expect(201);
    const lesson = res.body as Item;
    assert.equal(lesson.kind, 'lesson');
    assert.equal(lesson.title, 'Налаштування мережі');
    assert.deepEqual(calls, [[s.branchId, EVENTS]]);
    assert.deepEqual(
      lesson.journals.map((j) => `${j.node}/${j.role}`),
      ['m1/start'],
    );
    const journal = (await readJournal(s.assistant, lesson.id)) as {
      header: Record<string, unknown>;
      events: unknown[];
    };
    assert.equal('lesson' in journal.header, false);
    assert.equal(journal.events.length, EVENTS);
    await s.owner.get(`/api/library/${lesson.id}`).expect(404);
  });

  test('an assembled journal that fails the strict check is 400 journal_invalid', async () => {
    const s = await seed();
    fakeAssembler(journalText({ events: EVENTS, broken: true }));
    const res = await s.owner
      .post(url)
      .send({ submission_id: s.submissionId, node: 'm1' })
      .expect(400);
    assert.equal(error(res).code, 'journal_invalid');
  });
});

describe('POST /api/library/clip', () => {
  const url = '/api/library/clip';
  const body = (branchId: number, extra: Record<string, unknown> = {}) => ({
    branch_id: branchId,
    to_event: 3,
    from_ms: 1200,
    title: 'Помилка в ip',
    ...extra,
  });

  test('401, 403 for a student account, 400 on a wrong body, 404 for an unknown branch', async () => {
    const s = await seed();
    await t.client().post(url).send(body(1)).expect(401);
    await s.student.post(url).send(body(s.branchId)).expect(403);
    await s.owner
      .post(url)
      .send({ ...body(s.branchId), title: '' })
      .expect(400);
    await s.owner
      .post(url)
      .send({ ...body(s.branchId), to_event: -1 })
      .expect(400);
    await s.owner
      .post(url)
      .send({ ...body(s.branchId), from_ms: 'x' })
      .expect(400);
    await s.owner.post(url).send({ branch_id: s.branchId }).expect(400);
    const res = await s.owner.post(url).send(body(999_999)).expect(404);
    assert.equal(error(res).message, 'Спробу не знайдено');
  });

  test('rights: a stranger gets 404; the class teachers 404 until the submission is assembled', async () => {
    const s = await seed();
    await s.stranger.post(url).send(body(s.branchId)).expect(404);
    for (const who of [s.owner, s.assistant]) {
      const res = await who.post(url).send(body(s.branchId)).expect(404);
      assert.equal(error(res).message, 'Спробу не знайдено');
    }
  });

  test('to_event past the end of the branch is 400', async () => {
    const s = await seed();
    const res = await s.owner
      .post(url)
      .send(body(s.branchId, { to_event: EVENTS + 1 }))
      .expect(400);
    assert.match(error(res).message, /за межами/);
  });

  test('with an assembler it makes a one-machine clip', async () => {
    const s = await seed(PAIR);
    t.db.run("UPDATE branches SET node_id = 'm2' WHERE id = ?", s.branchId);
    const calls = fakeAssembler(journalText({ events: 3, profile: 'alpine' }));
    const res = await s.owner.post(url).send(body(s.branchId)).expect(201);
    const clip = res.body as Item;
    assert.equal(clip.kind, 'clip');
    assert.equal(clip.title, 'Помилка в ip');
    assert.equal(clip.clip_from_ms, 1200);
    assert.deepEqual(calls, [[s.branchId, 3]]);
    assert.deepEqual(clip.topology, {
      format: 'v86-topology/1',
      machines: [{ id: 'm2', profile: 'alpine' }],
      switches: [],
      links: [],
    });
    assert.deepEqual(
      clip.journals.map((j) => `${j.node}/${j.role}`),
      ['m2/start'],
    );
    const journal = (
      await s.owner
        .get(`/api/library/${clip.id}/journals/m2?role=start`)
        .expect(200)
    ).body as { events: unknown[] };
    assert.equal(journal.events.length, 3);
    const published = await s.owner
      .post(`/api/library/${clip.id}/embed`)
      .expect(201);
    assert.ok((published.body as { token: string }).token);
  });
});
