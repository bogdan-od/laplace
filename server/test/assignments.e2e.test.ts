import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type {
  ApiError,
  Assignment,
  CalendarEntry,
  ClassDetail,
  MyAssignment,
} from '@shared/api';
import { UNDO_MS } from '@shared/limits';
import {
  HintUses,
  NO_ATTEMPTS,
  Progress,
  type ProgressProvider,
} from '../src/assignments/providers';
import { AssignmentsService } from '../src/assignments/assignments.service';
import { createItem, journalText, putJournal } from './fixtures';
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

const error = (res: { body: unknown }): ApiError => res.body as ApiError;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

interface Scene {
  owner: Client;
  assistant: Client;
  student: Client;
  stranger: Client;
  classId: number;
  itemId: number;
  assignment: Assignment;
}

/** A class with an owner, an assistant and a student; one assignment with every journal role. */
async function scene(due: number | null = NOW + HOUR): Promise<Scene> {
  const owner = await teacherClient(t, 'Власник');
  const assistant = await teacherClient(t, 'Асистент');
  const stranger = await teacherClient(t, 'Сторонній');
  const { id: classId, code } = await createClass(owner);
  const student = await studentClient(t, code);
  await owner
    .post(`/api/classes/${classId}/assistants`)
    .send({ login: (await whoAmI(assistant)).login })
    .expect(201);
  const item = await createItem(owner, { brief: 'Налаштуйте мережу' });
  await owner
    .patch(`/api/library/${item.id}`)
    .send({
      checks: [{ node: 'm1', title: 'Ping', command: 'ping -c1 10.0.0.1' }],
      hints: [
        { text: 'Перша', penalty: 1 },
        { text: 'Друга', penalty: 2 },
      ],
    })
    .expect(200);
  await putJournal(owner, item.id, journalText());
  await putJournal(
    owner,
    item.id,
    journalText({ events: 6 }),
    'm1',
    'reference',
  );
  const res = await owner
    .post(`/api/library/${item.id}/assign`)
    .send({ class_id: classId, due_at: due, max_grade: 10, shared_lan: false })
    .expect(201);
  return {
    owner,
    assistant,
    student,
    stranger,
    classId,
    itemId: item.id,
    assignment: res.body as Assignment,
  };
}

afterEach(() => {
  t.app.get(Progress).use(NO_ATTEMPTS);
  t.app.get(HintUses).use({ opened: () => [] });
});

describe('GET /api/assignments/:id', () => {
  test('401 without a login, 404 for a stranger and for a missing id', async () => {
    const s = await scene();
    await t.client().get(`/api/assignments/${s.assignment.id}`).expect(401);
    await s.stranger.get(`/api/assignments/${s.assignment.id}`).expect(404);
    await s.owner.get('/api/assignments/99999').expect(404);
    await s.owner.get('/api/assignments/abc').expect(404);
  });

  test('a teacher sees checks, hint texts and every journal', async () => {
    const s = await scene();
    for (const who of [s.owner, s.assistant]) {
      const a = (
        await who.get(`/api/assignments/${s.assignment.id}`).expect(200)
      ).body as Assignment;
      assert.equal(a.class_name, '10-А');
      assert.equal(a.brief, 'Налаштуйте мережу');
      assert.equal(a.checks?.[0]?.command, 'ping -c1 10.0.0.1');
      assert.deepEqual(
        a.hints.map((h) => [h.index, h.penalty, h.text]),
        [
          [0, 1, 'Перша'],
          [1, 2, 'Друга'],
        ],
      );
      assert.deepEqual(
        a.journals.map((j) => j.role),
        ['reference', 'start'],
      );
      assert.equal(a.frozen, false);
      assert.equal(a.shared_lan, false);
      assert.equal(a.item_id, s.itemId);
    }
  });

  test('a student sees no checks, no reference journal and closed hints', async () => {
    const s = await scene();
    const res = await s.student
      .get(`/api/assignments/${s.assignment.id}`)
      .expect(200);
    const a = res.body as Assignment;
    assert.equal(a.checks, null);
    assert.equal(a.item_id, s.itemId);
    assert.deepEqual(
      a.journals.map((j) => j.role),
      ['start'],
    );
    assert.deepEqual(a.hints, [
      { index: 0, penalty: 1, text: null },
      { index: 1, penalty: 2, text: null },
    ]);
    assert.equal(a.my_status, 'idle');
    assert.deepEqual(a.counts, {});
    assert.ok(!JSON.stringify(res.body).includes('ping -c1'));
    assert.ok(!JSON.stringify(res.body).includes('Перша'));
  });

  test('hints the student opened (HintUsesProvider) show their text', async () => {
    const s = await scene();
    const me = await whoAmI(s.student);
    t.app.get(HintUses).use({
      opened: (assignmentId, userId) =>
        assignmentId === s.assignment.id && userId === me.id ? [1] : [],
    });
    const a = (
      await s.student.get(`/api/assignments/${s.assignment.id}`).expect(200)
    ).body as Assignment;
    assert.deepEqual(
      a.hints.map((h) => h.text),
      [null, 'Друга'],
    );
  });

  test('progress from the provider fills counts, my_status, my_grade and my_attempt_id', async () => {
    const s = await scene();
    const provider: ProgressProvider = {
      assignment: (_id, viewer) =>
        viewer.role === 'student'
          ? {
              counts: {},
              my_status: 'done',
              my_grade: 9,
              my_attempt_id: 42,
              to_review: 0,
            }
          : {
              counts: { done: 3, work: 1 },
              my_status: null,
              my_grade: null,
              my_attempt_id: null,
              to_review: 2,
            },
      classCounters: () => ({ to_review: 2, open_help: 1 }),
      student: () => null,
    };
    t.app.get(Progress).use(provider);
    const student = (
      await s.student.get(`/api/assignments/${s.assignment.id}`).expect(200)
    ).body as Assignment;
    assert.equal(student.my_status, 'done');
    assert.equal(student.my_grade, 9);
    assert.equal(student.my_attempt_id, 42);
    const teacher = (
      await s.owner.get(`/api/assignments/${s.assignment.id}`).expect(200)
    ).body as Assignment;
    assert.deepEqual(teacher.counts, { done: 3, work: 1 });
    const detail = (await s.owner.get(`/api/classes/${s.classId}`).expect(200))
      .body as ClassDetail;
    assert.equal(detail.to_review, 2);
    assert.equal(detail.open_help, 1);
    assert.deepEqual(detail.assignments[0]?.counts, { done: 3, work: 1 });
  });
});

describe('PATCH, DELETE and restore', () => {
  test('401, 404 for a stranger, 403 for a student', async () => {
    const s = await scene();
    const url = `/api/assignments/${s.assignment.id}`;
    await t.client().patch(url).send({ title: 'x' }).expect(401);
    await t.client().delete(url).expect(401);
    await t.client().post(`${url}/restore`).expect(401);
    await s.stranger.patch(url).send({ title: 'x' }).expect(404);
    await s.stranger.delete(url).expect(404);
    await s.stranger.post(`${url}/restore`).expect(404);
    await s.student.patch(url).send({ title: 'x' }).expect(403);
    await s.student.delete(url).expect(403);
    await s.student.post(`${url}/restore`).expect(403);
  });

  test('a teacher edits title, brief, due date, grade and checks', async () => {
    const s = await scene();
    const url = `/api/assignments/${s.assignment.id}`;
    const res = await s.assistant
      .patch(url)
      .send({
        title: ' Нова назва ',
        brief: 'Новий опис',
        due_at: null,
        max_grade: 12,
        checks: [{ node: 'm1', title: 'Нова', command: 'true' }],
      })
      .expect(200);
    const a = res.body as Assignment;
    assert.equal(a.title, 'Нова назва');
    assert.equal(a.brief, 'Новий опис');
    assert.equal(a.due_at, null);
    assert.equal(a.max_grade, 12);
    assert.equal(a.checks?.[0]?.title, 'Нова');
    await s.owner.patch(url).send({}).expect(200);
    const kept = (await s.owner.get(url).expect(200)).body as Assignment;
    assert.deepEqual(kept, a);
  });

  test('400 on a wrong body', async () => {
    const s = await scene();
    const url = `/api/assignments/${s.assignment.id}`;
    await s.owner.patch(url).send({ title: '' }).expect(400);
    await s.owner.patch(url).send({ max_grade: 0 }).expect(400);
    await s.owner.patch(url).send({ max_grade: 101 }).expect(400);
    await s.owner.patch(url).send({ due_at: 'tomorrow' }).expect(400);
    await s.owner.patch(url).send({ due_at: -1 }).expect(400);
    await s.owner.patch(url).send({ frozen: true }).expect(400);
    await s.owner
      .patch(url)
      .send({ checks: [{ node: 'm1', title: 'x', command: '' }] })
      .expect(400);
    const unknown = await s.owner
      .patch(url)
      .send({ checks: [{ node: 'ghost', title: 'x', command: 'true' }] })
      .expect(400);
    assert.match(error(unknown).message, /ghost/);
  });

  test('delete hides the assignment, restore inside the window returns it', async () => {
    const s = await scene();
    const url = `/api/assignments/${s.assignment.id}`;
    await s.owner.delete(url).expect(200);
    await s.owner.get(url).expect(404);
    await s.student.get(url).expect(404);
    const detail = (await s.owner.get(`/api/classes/${s.classId}`).expect(200))
      .body as ClassDetail;
    assert.equal(detail.assignments.length, 0);
    t.clock.advance(UNDO_MS);
    const back = (await s.owner.post(`${url}/restore`).expect(200))
      .body as Assignment;
    assert.equal(back.id, s.assignment.id);
    await s.student.get(url).expect(200);
    await s.owner.post(`${url}/restore`).expect(200);

    await s.owner.delete(url).expect(200);
    t.clock.advance(UNDO_MS * 6 + 1);
    await s.owner.post(`${url}/restore`).expect(404);
  });
});

describe('GET /api/assignments/:id/journals/:node', () => {
  test('a teacher reads both roles, a student only start', async () => {
    const s = await scene();
    const base = `/api/assignments/${s.assignment.id}/journals/m1`;
    const start = await s.student.get(`${base}?role=start`).expect(200);
    assert.equal((start.body as { events: unknown[] }).events.length, 4);
    await s.student.get(`${base}?role=reference`).expect(403);
    const reference = await s.owner.get(`${base}?role=reference`).expect(200);
    assert.equal((reference.body as { events: unknown[] }).events.length, 6);
  });

  test('401, 404 for a stranger, a missing journal and 400 without a role', async () => {
    const s = await scene();
    const base = `/api/assignments/${s.assignment.id}/journals/m1`;
    await t.client().get(`${base}?role=start`).expect(401);
    await s.stranger.get(`${base}?role=start`).expect(404);
    await s.owner
      .get(`/api/assignments/${s.assignment.id}/journals/ghost?role=start`)
      .expect(404);
    await s.owner.get(base).expect(400);
    await s.owner.get(`${base}?role=both`).expect(400);
  });
});

describe('class pages', () => {
  test('ClassDetail lists assignments newest first and next_due_at skips past dates', async () => {
    const s = await scene(NOW + 5 * HOUR);
    const item = await createItem(s.owner, { title: 'Друге' });
    const make = (due: number | null) =>
      s.owner
        .post(`/api/library/${item.id}/assign`)
        .send({
          class_id: s.classId,
          due_at: due,
          max_grade: 5,
          shared_lan: false,
        })
        .expect(201);
    await make(NOW - HOUR);
    await make(NOW + 2 * HOUR);
    await make(null);
    for (const who of [s.owner, s.student]) {
      const detail = (await who.get(`/api/classes/${s.classId}`).expect(200))
        .body as ClassDetail;
      assert.equal(detail.assignments.length, 4);
      assert.equal(detail.next_due_at, NOW + 2 * HOUR);
      assert.ok(
        detail.assignments.every(
          (a, i, all) => i === 0 || (all[i - 1]?.id ?? 0) > a.id,
        ),
      );
      const list = (await who.get('/api/classes').expect(200)).body as {
        id: number;
        next_due_at: number | null;
      }[];
      assert.equal(
        list.find((c) => c.id === s.classId)?.next_due_at,
        NOW + 2 * HOUR,
      );
    }
  });
});

describe('GET /api/me/assignments', () => {
  test('401 without a login', async () => {
    await t.client().get('/api/me/assignments').expect(401);
  });

  test('a student gets the assignments of all their classes with class names; teachers get none', async () => {
    const s = await scene();
    const other = await createClass(s.owner, 'Другий клас');
    await s.student.post(`/api/invites/${other.code}/accept`).expect(200);
    const item = await createItem(s.owner, { title: 'Друге' });
    await s.owner
      .post(`/api/library/${item.id}/assign`)
      .send({
        class_id: other.id,
        due_at: null,
        max_grade: 5,
        shared_lan: false,
      })
      .expect(201);

    const mine = (await s.student.get('/api/me/assignments').expect(200))
      .body as MyAssignment[];
    assert.deepEqual(
      mine.map((a) => [a.title, a.class_name !== '', a.my_status]).sort(),
      [
        ['Друге', true, 'idle'],
        [s.assignment.title, true, 'idle'],
      ].sort(),
    );
    assert.ok(mine.every((a) => Object.keys(a.counts).length === 0));
    for (const teacher of [s.owner, s.assistant, s.stranger]) {
      assert.deepEqual(
        (await teacher.get('/api/me/assignments').expect(200)).body,
        [],
      );
    }
  });

  test('frozen tells the assignment the teacher froze', async () => {
    const s = await scene();
    const read = async (): Promise<boolean[]> =>
      (
        (await s.student.get('/api/me/assignments').expect(200))
          .body as MyAssignment[]
      ).map((a) => a.frozen);
    assert.deepEqual(await read(), [false]);
    t.app.get(AssignmentsService).setFrozen(s.assignment.id, true);
    assert.deepEqual(await read(), [true]);
    t.app.get(AssignmentsService).setFrozen(s.assignment.id, false);
    assert.deepEqual(await read(), [false]);
  });

  test('a student removed from the class gets an empty list', async () => {
    const s = await scene();
    const me = await whoAmI(s.student);
    await s.owner
      .delete(`/api/classes/${s.classId}/members/${me.id}`)
      .expect(200);
    assert.deepEqual(
      (await s.student.get('/api/me/assignments').expect(200)).body,
      [],
    );
  });
});

describe('calendar', () => {
  test('401, 400 on a bad query', async () => {
    await t.client().get('/api/calendar?from=0&to=10').expect(401);
    await t.client().get('/api/calendar.ics').expect(401);
    const s = await scene();
    await s.owner.get('/api/calendar').expect(400);
    await s.owner.get('/api/calendar?from=0').expect(400);
    await s.owner.get('/api/calendar?from=a&to=5').expect(400);
    await s.owner.get('/api/calendar?from=-5&to=5').expect(400);
  });

  test('due dates in [from, to) over my classes; strangers see none', async () => {
    const s = await scene(NOW + 10 * HOUR);
    const url = (from: number, to: number) =>
      `/api/calendar?from=${from}&to=${to}`;
    const due = NOW + 10 * HOUR;
    for (const who of [s.owner, s.assistant, s.student]) {
      const hit = (await who.get(url(due, due + 1)).expect(200))
        .body as CalendarEntry[];
      assert.equal(hit.length, 1);
      assert.deepEqual(hit[0], {
        assignment_id: s.assignment.id,
        title: 'Налаштування мережі',
        class_id: s.classId,
        class_name: '10-А',
        due_at: due,
        my_status: who === s.student ? 'idle' : null,
        to_review: 0,
      });
      assert.equal(
        (await who.get(url(due - 5, due)).expect(200)).body.length,
        0,
      );
      assert.equal(
        (await who.get(url(due + 1, due + 9)).expect(200)).body.length,
        0,
      );
    }
    assert.deepEqual(
      (await s.stranger.get(url(0, due * 2)).expect(200)).body,
      [],
    );
  });

  test('to_review comes from the progress provider for teachers only', async () => {
    const s = await scene(NOW + 20 * HOUR);
    t.app.get(Progress).use({
      assignment: (_id, viewer) => ({
        counts: {},
        my_status: viewer.role === 'student' ? 'work' : null,
        my_grade: null,
        my_attempt_id: null,
        to_review: 4,
      }),
      classCounters: () => ({ to_review: 4, open_help: 0 }),
      student: () => null,
    });
    const query = `/api/calendar?from=${NOW}&to=${NOW + 30 * HOUR}`;
    const teacher = (await s.owner.get(query).expect(200))
      .body as CalendarEntry[];
    assert.equal(teacher[0]?.to_review, 4);
    assert.equal(teacher[0]?.my_status, null);
    const student = (await s.student.get(query).expect(200))
      .body as CalendarEntry[];
    assert.equal(student[0]?.to_review, 0);
    assert.equal(student[0]?.my_status, 'work');
  });

  test('deleted assignments and deleted classes drop out', async () => {
    const s = await scene(NOW + 40 * HOUR);
    const query = `/api/calendar?from=${NOW + 40 * HOUR}&to=${NOW + 41 * HOUR}`;
    assert.equal((await s.owner.get(query).expect(200)).body.length, 1);
    await s.owner.delete(`/api/assignments/${s.assignment.id}`).expect(200);
    assert.equal((await s.owner.get(query).expect(200)).body.length, 0);
    await s.owner
      .post(`/api/assignments/${s.assignment.id}/restore`)
      .expect(200);
    assert.equal((await s.owner.get(query).expect(200)).body.length, 1);
    await s.owner.delete(`/api/classes/${s.classId}`).expect(200);
    assert.equal((await s.owner.get(query).expect(200)).body.length, 0);
  });
});

/** Unfolds RFC 5545 lines and returns the properties of each VEVENT. */
function events(ics: string): Record<string, string>[] {
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  const found: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT' && current) {
      found.push(current);
      current = null;
    } else if (current) {
      const colon = line.indexOf(':');
      current[line.slice(0, colon)] = line.slice(colon + 1);
    }
  }
  return found;
}

describe('GET /api/calendar.ics', () => {
  test('is an RFC 5545 calendar with a VEVENT per due date in UTC', async () => {
    const owner = await teacherClient(t);
    const { id: classId } = await createClass(owner, 'Клас 11-Б, група; 2');
    const item = await createItem(owner, { title: 'Завдання, з комою' });
    const make = (due: number | null) =>
      owner
        .post(`/api/library/${item.id}/assign`)
        .send({
          class_id: classId,
          due_at: due,
          max_grade: 5,
          shared_lan: false,
        })
        .expect(201);
    const first = (await make(1_700_003_600_000)).body as Assignment;
    await make(1_800_000_000_000);
    await make(null);
    const deleted = (await make(1_900_000_000_000)).body as Assignment;
    await owner.delete(`/api/assignments/${deleted.id}`).expect(200);

    const res = await owner.get('/api/calendar.ics').buffer(true).expect(200);
    assert.match(String(res.headers['content-type']), /^text\/calendar/);
    assert.equal(
      res.headers['content-disposition'],
      'attachment; filename="laplace.ics"',
    );
    const text = res.text;
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(text.includes('VERSION:2.0\r\n'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
    const list = events(text);
    assert.equal(list.length, 2);
    const one = list.find((e) => e.UID === `assignment-${first.id}@laplace`);
    assert.ok(one);
    assert.equal(one.DTSTART, '20231114T231320Z');
    assert.equal(one.DTEND, '20231114T231320Z');
    assert.match(one.DTSTAMP ?? '', /^\d{8}T\d{6}Z$/);
    assert.equal(one.SUMMARY, 'Клас 11-Б\\, група\\; 2: Завдання\\, з комою');
    for (const line of text.split('\r\n')) {
      assert.ok(Buffer.byteLength(line) <= 75, line);
    }
  });

  test('a student gets their class, a stranger an empty calendar', async () => {
    const s = await scene(1_700_003_600_000);
    const mine = await s.student
      .get('/api/calendar.ics')
      .buffer(true)
      .expect(200);
    assert.equal(events(mine.text).length, 1);
    const none = await s.stranger
      .get('/api/calendar.ics')
      .buffer(true)
      .expect(200);
    assert.equal(events(none.text).length, 0);
    assert.ok(none.text.startsWith('BEGIN:VCALENDAR'));
  });
});
