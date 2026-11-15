import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import type { ApiError, Assignment, Topology } from '@shared/api';
import { UNDO_MS } from '@shared/limits';
import {
  createItem,
  Item,
  journalText,
  PAIR,
  putJournal,
  SINGLE,
} from './fixtures';
import {
  body,
  createClass,
  createTestApp,
  studentClient,
  teacherClient,
  TestApp,
} from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

const error = (res: { body: unknown }): ApiError => res.body as ApiError;

const journalFiles = (): string[] =>
  readdirSync(t.journalDir).filter((name) => name.endsWith('.json'));

describe('library items', () => {
  test('401 without a login on every item route', async () => {
    const anon = t.client();
    await anon.get('/api/library').expect(401);
    await anon.post('/api/library').send({}).expect(401);
    await anon.get('/api/library/1').expect(401);
    await anon.patch('/api/library/1').send({}).expect(401);
    await anon.delete('/api/library/1').expect(401);
    await anon.post('/api/library/1/restore').expect(401);
    await anon.get('/api/library/1/journals/m1?role=start').expect(401);
    await anon.delete('/api/library/1/journals/m1?role=start').expect(401);
    await anon.post('/api/library/1/assign').send({}).expect(401);
    await anon.post('/api/library/1/embed').expect(401);
    await anon.delete('/api/library/1/embed').expect(401);
    await anon.post('/api/library/clip').send({}).expect(401);
    await anon.post('/api/library/lesson-from-submission').send({}).expect(401);
    await anon
      .put('/api/library/1/journals/m1?role=start')
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(401);
  });

  test('a student has no library: 403', async () => {
    const teacher = await teacherClient(t);
    const { code } = await createClass(teacher);
    const student = await studentClient(t, code);
    await student.get('/api/library').expect(403);
    await student
      .post('/api/library')
      .send({ kind: 'task', title: 'X', topology: SINGLE })
      .expect(403);
  });

  test('every item route is 403 for a student', async () => {
    const teacher = await teacherClient(t);
    const { code } = await createClass(teacher);
    const student = await studentClient(t, code);
    const item = await createItem(teacher);
    const base = `/api/library/${item.id}`;
    await student.get(base).expect(403);
    await student.patch(base).send({ title: 'x' }).expect(403);
    await student.delete(base).expect(403);
    await student.post(`${base}/restore`).expect(403);
    await student
      .put(`${base}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(403);
    await student.get(`${base}/journals/m1?role=start`).expect(403);
    await student.delete(`${base}/journals/m1?role=start`).expect(403);
    await student
      .post(`${base}/assign`)
      .send({ class_id: 1, due_at: null, max_grade: 5, shared_lan: false })
      .expect(403);
    await student.post(`${base}/embed`).expect(403);
    await student.delete(`${base}/embed`).expect(403);
  });

  test('create, list, get, patch', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher, { brief: 'Опис' });
    assert.equal(item.kind, 'task');
    assert.deepEqual(item.journals, []);
    assert.equal(item.embed_token, null);
    assert.deepEqual(item.topology, SINGLE);

    const list = await teacher.get('/api/library').expect(200);
    const listed = list.body as {
      id: number;
      machines: number;
      assigned: unknown[];
    }[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, item.id);
    assert.equal(listed[0]?.machines, 1);
    assert.deepEqual(listed[0]?.assigned, []);

    const patched = await teacher
      .patch(`/api/library/${item.id}`)
      .send({
        title: '  Нова назва ',
        checks: [{ node: 'm1', title: 'Ping', command: 'ping -c1 10.0.0.1' }],
        hints: [{ text: 'Подивись у ip a', penalty: 2 }],
      })
      .expect(200);
    const view = patched.body as Item;
    assert.equal(view.title, 'Нова назва');
    assert.equal(view.checks.length, 1);
    assert.equal(view.hints.length, 1);
    const again = await teacher.get(`/api/library/${item.id}`).expect(200);
    assert.deepEqual(again.body, patched.body);
  });

  test('items of another teacher are 404', async () => {
    const owner = await teacherClient(t);
    const other = await teacherClient(t);
    const item = await createItem(owner);
    await other.get(`/api/library/${item.id}`).expect(404);
    await other
      .patch(`/api/library/${item.id}`)
      .send({ title: 'x' })
      .expect(404);
    await other.delete(`/api/library/${item.id}`).expect(404);
    await other.post(`/api/library/${item.id}/restore`).expect(404);
    await other.post(`/api/library/${item.id}/embed`).expect(404);
    assert.deepEqual((await other.get('/api/library').expect(200)).body, []);
  });

  test('400 on a wrong body', async () => {
    const teacher = await teacherClient(t);
    const post = (payload: unknown) =>
      teacher.post('/api/library').send(payload as object);
    await post({ kind: 'task', topology: SINGLE }).expect(400);
    await post({ kind: 'book', title: 'X', topology: SINGLE }).expect(400);
    await post({ kind: 'task', title: 'X', topology: 'no' }).expect(400);
    await post({ kind: 'task', title: 'X', topology: SINGLE, extra: 1 }).expect(
      400,
    );
    const item = await createItem(teacher);
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({ title: '' })
      .expect(400);
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({ hints: [{ text: 'x', penalty: -1 }] })
      .expect(400);
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({ checks: [{ node: 'm1', title: 'x' }] })
      .expect(400);
  });

  test('a topology with a switch loop is 400 topology_invalid', async () => {
    const teacher = await teacherClient(t);
    const looped: Topology = {
      ...PAIR,
      links: [
        ...PAIR.links,
        { switch: 'sw', to: 'sw', mode: 'trunk', allowed: [1] },
      ],
    };
    const res = await teacher
      .post('/api/library')
      .send({ kind: 'task', title: 'X', topology: looped })
      .expect(400);
    assert.equal(error(res).code, 'topology_invalid');
    assert.match(error(res).message, /цикл/);
  });

  test('a machine with two links is 400, a machine with none is fine', async () => {
    const teacher = await teacherClient(t);
    const doubled: Topology = {
      ...PAIR,
      links: [
        ...PAIR.links,
        { machine: 'm1', switch: 'sw', mode: 'access', vlan: 2 },
      ],
    };
    await teacher
      .post('/api/library')
      .send({ kind: 'task', title: 'X', topology: doubled })
      .expect(400);
    await createItem(teacher, { topology: SINGLE });
  });

  test('journals sent inside the topology are dropped', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher, {
      topology: { ...SINGLE, journals: { m1: { header: {}, events: [] } } },
    });
    assert.equal('journals' in item.topology, false);
  });

  test('a lesson and a clip hold exactly one machine', async () => {
    const teacher = await teacherClient(t);
    await teacher
      .post('/api/library')
      .send({ kind: 'lesson', title: 'X', topology: PAIR })
      .expect(400);
    const lesson = await createItem(teacher, { kind: 'lesson' });
    await teacher
      .patch(`/api/library/${lesson.id}`)
      .send({ topology: PAIR })
      .expect(400);
  });

  test('patch checks must name a machine of the topology', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const res = await teacher
      .patch(`/api/library/${item.id}`)
      .send({ checks: [{ node: 'ghost', title: 'T', command: 'true' }] })
      .expect(400);
    assert.match(error(res).message, /ghost/);
  });

  test('clip_from_ms is only for clips', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({ clip_from_ms: 5 })
      .expect(400);
    const clip = await createItem(teacher, { kind: 'clip' });
    const res = await teacher
      .patch(`/api/library/${clip.id}`)
      .send({ clip_from_ms: 1500 })
      .expect(200);
    assert.equal((res.body as Item).clip_from_ms, 1500);
  });

  test('delete hides the item and restore brings it back inside the undo window', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    await teacher.delete(`/api/library/${item.id}`).expect(200);
    await teacher.get(`/api/library/${item.id}`).expect(404);
    assert.deepEqual((await teacher.get('/api/library').expect(200)).body, []);
    t.clock.advance(UNDO_MS);
    await teacher.post(`/api/library/${item.id}/restore`).expect(200);
    await teacher.get(`/api/library/${item.id}`).expect(200);

    await teacher.delete(`/api/library/${item.id}`).expect(200);
    t.clock.advance(UNDO_MS * 6 + 1);
    await teacher.post(`/api/library/${item.id}/restore`).expect(404);
  });

  test('a topology edit drops journals of removed machines and refuses a profile change', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher, { topology: PAIR });
    await putJournal(teacher, item.id, journalText(), 'm1');
    await putJournal(
      teacher,
      item.id,
      journalText({ profile: 'alpine' }),
      'm2',
    );
    const profileChange: Topology = {
      ...PAIR,
      machines: [
        { id: 'm1', profile: 'alpine' },
        { id: 'm2', profile: 'alpine' },
      ],
    };
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({ topology: profileChange })
      .expect(400);
    const res = await teacher
      .patch(`/api/library/${item.id}`)
      .send({ topology: SINGLE })
      .expect(200);
    assert.deepEqual(
      (res.body as Item).journals.map((j) => j.node),
      ['m1'],
    );
  });
});

describe('journal files', () => {
  test('put, get, delete; the bytes come back unchanged', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const text = journalText({ events: 6 });
    const withJournal = await putJournal(teacher, item.id, text);
    assert.deepEqual(withJournal.journals, [
      { node: 'm1', role: 'start', size: Buffer.byteLength(text) },
    ]);
    const got = await teacher
      .get(`/api/library/${item.id}/journals/m1?role=start`)
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(null, Buffer.concat(parts).toString()));
      })
      .expect(200);
    assert.equal(got.body, text);
    assert.match(String(got.headers['content-type']), /application\/json/);

    await teacher
      .get(`/api/library/${item.id}/journals/m1?role=reference`)
      .expect(404);
    const removed = await teacher
      .delete(`/api/library/${item.id}/journals/m1?role=start`)
      .expect(200);
    assert.deepEqual((removed.body as Item).journals, []);
    await teacher
      .delete(`/api/library/${item.id}/journals/m1?role=start`)
      .expect(404);
  });

  test('the same journal uploaded twice is one file on disk', async () => {
    const teacher = await teacherClient(t);
    const text = journalText({ events: 9 });
    const first = await createItem(teacher);
    const second = await createItem(teacher);
    const before = journalFiles().length;
    await putJournal(teacher, first.id, text);
    await putJournal(teacher, first.id, text);
    await putJournal(teacher, second.id, text, 'm1', 'reference');
    assert.equal(journalFiles().length, before + 1);
    const rows = t.db.all<{ journal_sha: string }>(
      'SELECT journal_sha FROM item_journals WHERE item_id IN (?, ?)',
      first.id,
      second.id,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.journal_sha, rows[1]?.journal_sha);
    assert.equal(
      t.db.all(
        'SELECT 1 FROM journal_files WHERE sha256 = ?',
        rows[0]?.journal_sha ?? '',
      ).length,
      1,
    );
  });

  test('a journal with a decreasing c is 400 journal_invalid with the core text and no content', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const secret = 'ENTROPY-OF-THE-SESSION';
    const res = await teacher
      .put(`/api/library/${item.id}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText({ events: 5, broken: true, secret }))
      .expect(400);
    assert.equal(error(res).code, 'journal_invalid');
    assert.match(error(res).message, /порядок порушено/);
    assert.ok(!JSON.stringify(res.body).includes(secret));
  });

  test('not JSON, wrong format and a hostile shape are 400', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const put = (payload: string) =>
      teacher
        .put(`/api/library/${item.id}/journals/m1?role=start`)
        .set('Content-Type', 'application/json')
        .send(payload);
    const garbage = await put('{"header": ').expect(400);
    assert.equal(error(garbage).message, 'Журнал не є коректним JSON');
    const wrongFormat = await put(
      JSON.stringify({ header: { format: 'v86-replay/1' }, events: [] }),
    ).expect(400);
    assert.equal(error(wrongFormat).code, 'journal_invalid');
    const hostile = await put(
      JSON.stringify({
        header: { format: 'v86-replay/9', profile: 'buildroot', seed: 1 },
        events: [null],
      }),
    ).expect(400);
    assert.equal(error(hostile).code, 'journal_invalid');
    await put('"a string"').expect(400);
  });

  test('a body that is not JSON content-type is 400', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    await teacher
      .put(`/api/library/${item.id}/journals/m1?role=start`)
      .set('Content-Type', 'text/plain')
      .send(journalText())
      .expect(400);
  });

  test('a journal of another profile is 400', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const res = await teacher
      .put(`/api/library/${item.id}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText({ profile: 'alpine' }))
      .expect(400);
    assert.match(error(res).message, /alpine/);
    assert.match(error(res).message, /buildroot/);
  });

  test('an unknown machine, a missing role and a stranger', async () => {
    const owner = await teacherClient(t);
    const other = await teacherClient(t);
    const item = await createItem(owner);
    await owner
      .put(`/api/library/${item.id}/journals/ghost?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(400);
    await owner
      .put(`/api/library/${item.id}/journals/m1`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(400);
    await owner
      .put(`/api/library/${item.id}/journals/m1?role=other`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(400);
    await other
      .put(`/api/library/${item.id}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(404);
    await other
      .get(`/api/library/${item.id}/journals/m1?role=start`)
      .expect(404);
  });

  test('lesson journals need header.lesson; only tasks have a reference', async () => {
    const teacher = await teacherClient(t);
    const lesson = await createItem(teacher, { kind: 'lesson' });
    const res = await teacher
      .put(`/api/library/${lesson.id}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(journalText())
      .expect(400);
    assert.match(error(res).message, /header\.lesson/);
    await teacher
      .put(`/api/library/${lesson.id}/journals/m1?role=reference`)
      .set('Content-Type', 'application/json')
      .send(journalText({ lesson: true }))
      .expect(400);
    await putJournal(teacher, lesson.id, journalText({ lesson: true }));
  });

  test('a body above 1 MiB reaches the journal route but not an ordinary one', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const big = journalText({ events: 30_000 });
    assert.ok(Buffer.byteLength(big) > 2 ** 20);
    const stored = await putJournal(teacher, item.id, big);
    assert.equal(stored.journals[0]?.size, Buffer.byteLength(big));

    const res = await teacher
      .post('/api/library')
      .send({
        kind: 'task',
        title: 'X',
        topology: SINGLE,
        brief: 'x'.repeat(2 ** 20 + 1),
      })
      .expect(413);
    assert.equal(error(res).statusCode, 413);
    assert.equal(typeof error(res).message, 'string');
  });

  test('an anonymous caller does not get the large limit', async () => {
    const big = journalText({ events: 30_000 });
    const res = await t
      .client()
      .put('/api/library/1/journals/m1?role=start')
      .set('Content-Type', 'application/json')
      .send(big)
      .expect(413);
    assert.equal(error(res).statusCode, 413);
  });
});

describe('assign', () => {
  async function ready(): Promise<{
    teacher: Awaited<ReturnType<typeof teacherClient>>;
    classId: number;
    code: string;
  }> {
    const teacher = await teacherClient(t);
    const { id, code } = await createClass(teacher);
    return { teacher, classId: id, code };
  }

  const assignBody = (
    classId: number,
    extra: Record<string, unknown> = {},
  ) => ({
    class_id: classId,
    due_at: 1_700_100_000_000,
    max_grade: 12,
    shared_lan: false,
    ...extra,
  });

  test('copies the item with its journals and records the activity', async () => {
    const { teacher, classId } = await ready();
    const item = await createItem(teacher, { brief: 'Опис' });
    await teacher
      .patch(`/api/library/${item.id}`)
      .send({
        checks: [{ node: 'm1', title: 'Ping', command: 'ping -c1 x' }],
        hints: [{ text: 'Підказка', penalty: 1 }],
      })
      .expect(200);
    await putJournal(teacher, item.id, journalText());
    await putJournal(
      teacher,
      item.id,
      journalText({ events: 5 }),
      'm1',
      'reference',
    );

    const res = await teacher
      .post(`/api/library/${item.id}/assign`)
      .send(assignBody(classId))
      .expect(201);
    const assignment = res.body as Assignment;
    assert.equal(assignment.class_id, classId);
    assert.equal(assignment.title, 'Налаштування мережі');
    assert.equal(assignment.max_grade, 12);
    assert.equal(assignment.due_at, 1_700_100_000_000);
    assert.equal(assignment.checks?.length, 1);
    assert.equal(assignment.hints[0]?.text, 'Підказка');
    assert.deepEqual(
      assignment.journals.map((j) => `${j.node}/${j.role}`).sort(),
      ['m1/reference', 'm1/start'],
    );
    const shared = t.db.all<{ journal_sha: string }>(
      'SELECT journal_sha FROM assignment_journals WHERE assignment_id = ? ORDER BY role',
      assignment.id,
    );
    const source = t.db.all<{ journal_sha: string }>(
      'SELECT journal_sha FROM item_journals WHERE item_id = ? ORDER BY role',
      item.id,
    );
    assert.deepEqual(shared, source);

    const log = t.db.all<{ kind: string; assignment_id: number; text: string }>(
      "SELECT kind, assignment_id, text FROM activity WHERE kind = 'assignment_created' AND assignment_id = ?",
      assignment.id,
    );
    assert.equal(log.length, 1);
    assert.equal(log[0]?.text, 'Налаштування мережі');

    const listed = await teacher.get('/api/library').expect(200);
    assert.deepEqual(
      (listed.body as { id: number; assigned: unknown[] }[]).find(
        (i) => i.id === item.id,
      )?.assigned,
      [{ class_id: classId, class_name: '10-А', assignment_id: assignment.id }],
    );
  });

  test('editing or deleting the item afterwards does not change the assignment', async () => {
    const { teacher, classId } = await ready();
    const item = await createItem(teacher, { brief: 'Старий опис' });
    await putJournal(teacher, item.id, journalText());
    const assignment = (
      await teacher
        .post(`/api/library/${item.id}/assign`)
        .send(assignBody(classId))
        .expect(201)
    ).body as Assignment;

    await teacher
      .patch(`/api/library/${item.id}`)
      .send({
        title: 'Інша назва',
        brief: 'Новий опис',
        topology: PAIR,
        checks: [{ node: 'm2', title: 'T', command: 'true' }],
        hints: [{ text: 'нова', penalty: 3 }],
      })
      .expect(200);
    await teacher
      .delete(`/api/library/${item.id}/journals/m1?role=start`)
      .expect(200);
    await teacher.delete(`/api/library/${item.id}`).expect(200);

    const after = (
      await teacher.get(`/api/assignments/${assignment.id}`).expect(200)
    ).body as Assignment;
    assert.deepEqual(after, assignment);
    assert.equal(after.title, 'Налаштування мережі');
    assert.equal(after.brief, 'Старий опис');
    assert.deepEqual(after.topology, SINGLE);
    assert.equal(after.journals.length, 1);
  });

  test('only into a class where I teach', async () => {
    const { teacher, classId, code } = await ready();
    const stranger = await teacherClient(t);
    const student = await studentClient(t, code);
    void student;
    const item = await createItem(teacher);
    await stranger
      .post(`/api/library/${(await createItem(stranger)).id}/assign`)
      .send(assignBody(classId))
      .expect(404);
    await teacher
      .post(`/api/library/${item.id}/assign`)
      .send(assignBody(classId + 1000))
      .expect(404);
  });

  test('an assistant may assign into the class he assists', async () => {
    const owner = await teacherClient(t);
    const { id } = await createClass(owner);
    const assistant = await teacherClient(t);
    const login = (await assistant.get('/api/me')).body.login as string;
    await owner
      .post(`/api/classes/${id}/assistants`)
      .send({ login })
      .expect(201);
    const item = await createItem(assistant);
    await assistant
      .post(`/api/library/${item.id}/assign`)
      .send(assignBody(id))
      .expect(201);
  });

  test('400 on a wrong body, a clip and shared_lan on two machines', async () => {
    const { teacher, classId } = await ready();
    const item = await createItem(teacher);
    const post = (payload: object) =>
      teacher.post(`/api/library/${item.id}/assign`).send(payload);
    await post({
      class_id: classId,
      due_at: null,
      max_grade: 0,
      shared_lan: false,
    }).expect(400);
    await post({
      class_id: classId,
      due_at: null,
      max_grade: 101,
      shared_lan: false,
    }).expect(400);
    await post({ class_id: classId, max_grade: 10, shared_lan: false }).expect(
      400,
    );
    await post({ class_id: classId, due_at: null, max_grade: 10 }).expect(400);
    await post({
      class_id: 'a',
      due_at: null,
      max_grade: 10,
      shared_lan: false,
    }).expect(400);
    await post(assignBody(classId, { due_at: null })).expect(201);

    const pair = await createItem(teacher, { topology: PAIR });
    const res = await teacher
      .post(`/api/library/${pair.id}/assign`)
      .send(assignBody(classId, { shared_lan: true }))
      .expect(400);
    assert.match(error(res).message, /Спільна мережа/);
    await teacher
      .post(`/api/library/${pair.id}/assign`)
      .send(assignBody(classId))
      .expect(201);
    const single = await createItem(teacher);
    const ok = await teacher
      .post(`/api/library/${single.id}/assign`)
      .send(assignBody(classId, { shared_lan: true }))
      .expect(201);
    assert.equal((ok.body as Assignment).shared_lan, true);
    assert.equal((ok.body as Assignment).item_id, single.id);

    const clip = await createItem(teacher, { kind: 'clip' });
    await teacher
      .post(`/api/library/${clip.id}/assign`)
      .send(assignBody(classId))
      .expect(400);
    const lesson = await createItem(teacher, { kind: 'lesson' });
    const noJournal = await teacher
      .post(`/api/library/${lesson.id}/assign`)
      .send(assignBody(classId))
      .expect(400);
    assert.match(error(noJournal).message, /Урок без журналу/);
  });
});

describe('embed', () => {
  test('publish, read without a login, revoke', async () => {
    const teacher = await teacherClient(t);
    const lesson = await createItem(teacher, {
      kind: 'lesson',
      title: 'Урок про ip',
    });
    const noJournal = await teacher
      .post(`/api/library/${lesson.id}/embed`)
      .expect(400);
    assert.match(error(noJournal).message, /журнал/);
    const text = journalText({ lesson: true });
    await putJournal(teacher, lesson.id, text);

    const info = (
      await teacher.post(`/api/library/${lesson.id}/embed`).expect(201)
    ).body as { token: string; url: string };
    assert.match(info.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(info.url, `/embed/${info.token}`);
    const again = (
      await teacher.post(`/api/library/${lesson.id}/embed`).expect(201)
    ).body as { token: string };
    assert.equal(again.token, info.token);
    assert.equal(
      ((await teacher.get(`/api/library/${lesson.id}`)).body as Item)
        .embed_token,
      info.token,
    );

    const payload = await t
      .client()
      .get(`/api/embed/${info.token}`)
      .expect(200);
    assert.deepEqual(payload.body, {
      title: 'Урок про ip',
      journal: JSON.parse(text),
      from_ms: null,
    });

    await teacher.delete(`/api/library/${lesson.id}/embed`).expect(200);
    await t.client().get(`/api/embed/${info.token}`).expect(404);
    assert.equal(
      ((await teacher.get(`/api/library/${lesson.id}`)).body as Item)
        .embed_token,
      null,
    );
    const fresh = (
      await teacher.post(`/api/library/${lesson.id}/embed`).expect(201)
    ).body as { token: string };
    assert.notEqual(fresh.token, info.token);
    await t.client().get(`/api/embed/${info.token}`).expect(404);
    await t.client().get(`/api/embed/${fresh.token}`).expect(200);
  });

  test('a clip carries from_ms; tasks cannot be published', async () => {
    const teacher = await teacherClient(t);
    const clip = await createItem(teacher, { kind: 'clip', title: 'Фрагмент' });
    await putJournal(teacher, clip.id, journalText());
    await teacher
      .patch(`/api/library/${clip.id}`)
      .send({ clip_from_ms: 250 })
      .expect(200);
    const info = (
      await teacher.post(`/api/library/${clip.id}/embed`).expect(201)
    ).body as { token: string };
    const payload = await t
      .client()
      .get(`/api/embed/${info.token}`)
      .expect(200);
    assert.equal(body(payload).from_ms, 250);

    const task = await createItem(teacher);
    await putJournal(teacher, task.id, journalText());
    await teacher.post(`/api/library/${task.id}/embed`).expect(400);
  });

  test('only the owner publishes or revokes; bad tokens are 404', async () => {
    const owner = await teacherClient(t);
    const other = await teacherClient(t);
    const lesson = await createItem(owner, { kind: 'lesson' });
    await putJournal(owner, lesson.id, journalText({ lesson: true }));
    await other.post(`/api/library/${lesson.id}/embed`).expect(404);
    const { token } = (
      await owner.post(`/api/library/${lesson.id}/embed`).expect(201)
    ).body as {
      token: string;
    };
    await other.delete(`/api/library/${lesson.id}/embed`).expect(404);
    await t.client().get(`/api/embed/${token}`).expect(200);
    await t.client().get('/api/embed/short').expect(404);
    await t
      .client()
      .get(`/api/embed/${'A'.repeat(22)}`)
      .expect(404);
    await owner.delete(`/api/library/${lesson.id}`).expect(200);
    await t.client().get(`/api/embed/${token}`).expect(404);
  });
});
