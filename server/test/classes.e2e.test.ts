import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MAX_STUDENTS_PER_CLASS, UNDO_MS } from '@shared/limits';
import {
  body,
  Client,
  createClass,
  createTestApp,
  fillStudents,
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

interface Detail {
  id: number;
  name: string;
  subject: string;
  my_role: string;
  students: number;
  invite_code: string | null;
  members: {
    user_id: number;
    name: string;
    login: string;
    role: string;
    number: number | null;
  }[];
  owner: { id: number; name: string };
  assignments: unknown[];
  to_review: number;
  open_help: number;
  next_due_at: number | null;
  is_demo: boolean;
}

const detail = (res: { body: unknown }): Detail => res.body as Detail;

/** A teacher with a class, an assistant, a student and a stranger teacher. */
async function scene(): Promise<{
  owner: Client;
  assistant: Client;
  student: Client;
  stranger: Client;
  classId: number;
  code: string;
  studentId: number;
  assistantId: number;
}> {
  const owner = await teacherClient(t, 'Власник');
  const assistant = await teacherClient(t, 'Асистент');
  const stranger = await teacherClient(t, 'Сторонній');
  const { id: classId, code } = await createClass(owner);
  const student = await studentClient(t, code, 'Студент Перший');
  const assistantMe = await whoAmI(assistant);
  await owner
    .post(`/api/classes/${classId}/assistants`)
    .send({ login: assistantMe.login })
    .expect(201);
  return {
    owner,
    assistant,
    student,
    stranger,
    classId,
    code,
    studentId: (await whoAmI(student)).id,
    assistantId: assistantMe.id,
  };
}

describe('GET /api/classes', () => {
  test('401 without a login', async () => {
    const res = await t.client().get('/api/classes').expect(401);
    assert.equal(body(res).code, 'not_logged_in');
  });

  test('lists the classes of the owner, assistant and student; a stranger sees none', async () => {
    const s = await scene();
    const roles = async (client: Client): Promise<string[]> =>
      ((await client.get('/api/classes').expect(200)).body as Detail[])
        .filter((c) => c.id === s.classId)
        .map((c) => c.my_role);
    assert.deepEqual(await roles(s.owner), ['owner']);
    assert.deepEqual(await roles(s.assistant), ['assistant']);
    assert.deepEqual(await roles(s.student), ['student']);
    assert.deepEqual(await roles(s.stranger), []);
    const summary = (
      (await s.owner.get('/api/classes').expect(200)).body as Detail[]
    )[0];
    assert.ok(summary);
    assert.deepEqual(
      [
        summary.students,
        summary.to_review,
        summary.open_help,
        summary.next_due_at,
        summary.is_demo,
      ],
      [1, 0, 0, null, false],
    );
  });
});

describe('POST /api/classes', () => {
  test('401 without a login, 403 for a student, 400 for a bad body', async () => {
    await t
      .client()
      .post('/api/classes')
      .send({ name: 'X', subject: '' })
      .expect(401);
    const owner = await teacherClient(t);
    const { code } = await createClass(owner);
    const student = await studentClient(t, code);
    const res = await student
      .post('/api/classes')
      .send({ name: 'X', subject: '' })
      .expect(403);
    assert.equal(body(res).statusCode, 403);
    for (const payload of [
      {},
      { name: '', subject: '' },
      { name: 'X' },
      { name: 'X', subject: '', extra: 1 },
    ]) {
      await owner.post('/api/classes').send(payload).expect(400);
    }
  });

  test('creates a class with a fresh invite code from the allowed alphabet', async () => {
    const owner = await teacherClient(t, 'Олена');
    const res = await owner
      .post('/api/classes')
      .send({ name: ' 11-Б ', subject: '' })
      .expect(201);
    const c = detail(res);
    assert.equal(c.name, '11-Б');
    assert.equal(c.my_role, 'owner');
    assert.match(
      c.invite_code ?? '',
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/,
    );
    assert.deepEqual([c.members, c.assignments, c.students], [[], [], 0]);
    assert.equal(c.owner.name, 'Олена');
  });
});

describe('GET /api/classes/:id', () => {
  test('401, 404 for a stranger and for a bad id', async () => {
    const s = await scene();
    await t.client().get(`/api/classes/${s.classId}`).expect(401);
    await s.stranger.get(`/api/classes/${s.classId}`).expect(404);
    await s.owner.get('/api/classes/abc').expect(404);
    await s.owner.get('/api/classes/999999').expect(404);
  });

  test('a teacher sees the invite code and members, a student does not', async () => {
    const s = await scene();
    const asOwner = detail(
      await s.owner.get(`/api/classes/${s.classId}`).expect(200),
    );
    assert.equal(asOwner.invite_code, s.code);
    assert.deepEqual(
      asOwner.members.map((m) => [m.role, m.number, m.name]),
      [
        ['assistant', null, 'Асистент'],
        ['student', 1, 'Студент Перший'],
      ],
    );
    const asAssistant = detail(
      await s.assistant.get(`/api/classes/${s.classId}`).expect(200),
    );
    assert.equal(asAssistant.my_role, 'assistant');
    assert.equal(asAssistant.invite_code, s.code);
    const asStudent = detail(
      await s.student.get(`/api/classes/${s.classId}`).expect(200),
    );
    assert.equal(asStudent.invite_code, null);
    assert.deepEqual(asStudent.members, []);
    assert.equal(asStudent.students, 1);
  });
});

describe('PATCH /api/classes/:id', () => {
  test('401, 404 stranger, 403 student, 400 bad body', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}`;
    await t.client().patch(url).send({ name: 'X' }).expect(401);
    await s.stranger.patch(url).send({ name: 'X' }).expect(404);
    await s.student.patch(url).send({ name: 'X' }).expect(403);
    for (const payload of [{ name: '' }, { name: 5 }, { owner_id: 1 }]) {
      await s.owner.patch(url).send(payload).expect(400);
    }
  });

  test('the owner and an assistant can change the name and subject', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}`;
    const res = await s.owner.patch(url).send({ name: '10-Б' }).expect(200);
    assert.deepEqual(
      [detail(res).name, detail(res).subject],
      ['10-Б', 'Інформатика'],
    );
    const res2 = await s.assistant
      .patch(url)
      .send({ subject: 'Мережі' })
      .expect(200);
    assert.deepEqual(
      [detail(res2).name, detail(res2).subject],
      ['10-Б', 'Мережі'],
    );
  });
});

describe('DELETE /api/classes/:id and restore', () => {
  test('401, 404 stranger, 403 student and assistant', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}`;
    await t.client().delete(url).expect(401);
    await s.stranger.delete(url).expect(404);
    await s.student.delete(url).expect(403);
    await s.assistant.delete(url).expect(403);
  });

  test('a deleted class disappears everywhere; restore brings it back', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}`;
    await s.owner.delete(url).expect(200);
    await s.owner.get(url).expect(404);
    await s.student.get(url).expect(404);
    await s.owner.patch(url).send({ name: 'X' }).expect(404);
    await t.client().get(`/api/invites/${s.code}`).expect(404);
    const list = (await s.owner.get('/api/classes').expect(200))
      .body as Detail[];
    assert.ok(!list.some((c) => c.id === s.classId));

    await s.student.post(`${url}/restore`).expect(404);
    await s.stranger.post(`${url}/restore`).expect(404);
    await t.client().post(`${url}/restore`).expect(401);
    t.clock.advance(UNDO_MS * 6);
    const restored = detail(await s.owner.post(`${url}/restore`).expect(200));
    assert.equal(restored.id, s.classId);
    await s.student.get(url).expect(200);
    await t.client().get(`/api/invites/${s.code}`).expect(200);
  });

  test('restore after UNDO_MS x 6 is 404', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}`;
    await s.owner.delete(url).expect(200);
    t.clock.advance(UNDO_MS * 6 + 1);
    await s.owner.post(`${url}/restore`).expect(404);
    await s.owner.get(url).expect(404);
  });

  test('restore of a live class: 403 for a student and an assistant, harmless for the owner', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/restore`;
    await s.student.post(url).expect(403);
    await s.assistant.post(url).expect(403);
    await s.stranger.post(url).expect(404);
    await s.owner.post(url).expect(200);
  });
});

describe('POST /api/classes/:id/invite', () => {
  test('401, 404, 403 student and assistant', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/invite`;
    await t.client().post(url).expect(401);
    await s.stranger.post(url).expect(404);
    await s.student.post(url).expect(403);
    await s.assistant.post(url).expect(403);
  });

  test('issues a new code; the old one stops working', async () => {
    const s = await scene();
    const res = await s.owner
      .post(`/api/classes/${s.classId}/invite`)
      .expect(200);
    const fresh = detail(res).invite_code;
    assert.ok(fresh);
    assert.notEqual(fresh, s.code);
    await t.client().get(`/api/invites/${s.code}`).expect(404);
    await t.client().get(`/api/invites/${fresh}`).expect(200);
  });
});

describe('GET /api/invites/:code and accept', () => {
  test('GET is public and describes the class; unknown codes are 404', async () => {
    const s = await scene();
    const res = await t
      .client()
      .get(`/api/invites/${s.code.toLowerCase()}`)
      .expect(200);
    assert.deepEqual(res.body, {
      code: s.code,
      class_name: '10-А',
      subject: 'Інформатика',
      teacher_name: 'Власник',
    });
    await t.client().get('/api/invites/ZZZZZZZZ').expect(404);
    await t.client().get('/api/invites/short').expect(404);
  });

  test('accept: 401 without a login, 404 for an unknown code, 403 for a teacher', async () => {
    const s = await scene();
    await t.client().post(`/api/invites/${s.code}/accept`).expect(401);
    await s.stranger.post('/api/invites/ZZZZZZZZ/accept').expect(404);
    await s.stranger.post(`/api/invites/${s.code}/accept`).expect(403);
  });

  test('a registered student joins another class by code; a second accept changes nothing', async () => {
    const s = await scene();
    const other = await teacherClient(t);
    const { id: otherId, code: otherCode } = await createClass(other, '9-В');
    const res = await s.student
      .post(`/api/invites/${otherCode}/accept`)
      .expect(200);
    assert.deepEqual(
      [body(res).id, body(res).my_role, body(res).students],
      [otherId, 'student', 1],
    );
    await s.student.post(`/api/invites/${otherCode}/accept`).expect(200);
    const members = detail(
      await other.get(`/api/classes/${otherId}`).expect(200),
    ).members;
    assert.equal(members.length, 1);
  });
});

describe('student numbers', () => {
  test('numbers go 1, 2, 3; after removing 2 the next student gets 2', async () => {
    const owner = await teacherClient(t);
    const { id, code } = await createClass(owner);
    for (let i = 0; i < 3; i++)
      await studentClient(t, code, `Студент ${i + 1}`);
    const members = async (): Promise<Detail['members']> =>
      detail(await owner.get(`/api/classes/${id}`).expect(200)).members;
    assert.deepEqual(
      (await members()).map((m) => m.number),
      [1, 2, 3],
    );

    const second = (await members())[1];
    assert.ok(second);
    await owner
      .delete(`/api/classes/${id}/members/${second.user_id}`)
      .expect(200);
    assert.deepEqual(
      (await members()).map((m) => m.number),
      [1, 3],
    );

    await studentClient(t, code, 'Новий');
    assert.deepEqual(
      (await members()).map((m) => [m.number, m.name]),
      [
        [1, 'Студент 1'],
        [2, 'Новий'],
        [3, 'Студент 3'],
      ],
    );
  });

  test('the 255th student is 409 and no account is left behind', async () => {
    const owner = await teacherClient(t);
    const { id, code } = await createClass(owner);
    fillStudents(t, id, MAX_STUDENTS_PER_CLASS);
    const attempt = {
      login: 'late.student',
      password: 'password123',
      name: 'Запізнілий',
      role: 'student',
      invite_code: code,
    };
    const res = await t
      .client()
      .post('/api/auth/register')
      .send(attempt)
      .expect(409);
    assert.equal(body(res).message, 'У класі вже 254 студенти');
    assert.equal(
      t.db.get('SELECT 1 FROM users WHERE login = ?', 'late.student'),
      undefined,
    );
    const registered = await studentClient(
      t,
      (await createClass(owner, 'Інший')).code,
    );
    const accept = await registered
      .post(`/api/invites/${code}/accept`)
      .expect(409);
    assert.equal(body(accept).message, 'У класі вже 254 студенти');
  });
});

describe('POST /api/classes/:id/import', () => {
  const csv = [
    'ПІБ;логін',
    'Щербак Іван Петрович',
    '',
    'Щербак Марія;maria.shcherbak',
    'Яценко Оксана,yatsenko',
    'Їжак Петро',
    'Ґудзь Олег;Bad Login',
    'Згурський Андрій;Maria.Shcherbak',
    'Хтось;a;b',
    'Коваль Ірина',
  ].join('\r\n');

  test('401, 404, 403 student, 400 bad body', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/import`;
    await t.client().post(url).send({ csv: 'А Б' }).expect(401);
    await s.stranger.post(url).send({ csv: 'А Б' }).expect(404);
    await s.student.post(url).send({ csv: 'А Б' }).expect(403);
    for (const payload of [
      {},
      { csv: 5 },
      { csv: 'x', more: 1 },
      { csv: 'x'.repeat(200_001) },
    ]) {
      await s.owner.post(url).send(payload).expect(400);
    }
  });

  test('bad lines are reported, the others are created and can log in', async () => {
    const s = await scene();
    const res = await s.assistant
      .post(`/api/classes/${s.classId}/import`)
      .send({ csv })
      .expect(201);
    const result = res.body as {
      created: {
        name: string;
        login: string;
        number: number;
        password: string;
      }[];
      errors: { line: number; message: string }[];
    };
    assert.deepEqual(
      result.created.map((c) => [c.name, c.login, c.number]),
      [
        ['Щербак Іван Петрович', 'shcherbak', 2],
        ['Щербак Марія', 'maria.shcherbak', 3],
        ['Яценко Оксана', 'yatsenko', 4],
        ['Їжак Петро', 'yizhak', 5],
        ['Коваль Ірина', 'koval', 6],
      ],
    );
    assert.deepEqual(
      result.errors.map((e) => e.line),
      [7, 8, 9],
    );
    assert.match(result.errors[0]?.message ?? '', /Bad Login/);
    assert.match(result.errors[1]?.message ?? '', /maria\.shcherbak/);
    assert.ok(
      result.created.every((c) =>
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(c.password),
      ),
    );
    const first = result.created[0];
    assert.ok(first);
    await t
      .client()
      .post('/api/auth/login')
      .send({ login: first.login, password: first.password })
      .expect(200);
    const row = t.db.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE login = ?',
      'koval',
    );
    assert.ok(
      row && !row.password_hash.includes(result.created[4]?.password ?? '?'),
    );
    assert.equal(
      t.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM activity WHERE kind = 'member_joined' AND class_id = ?",
        s.classId,
      )?.n,
      1,
      'imported students do not produce member_joined',
    );
  });

  test('a repeated surname gets a number: melnychuk2', async () => {
    const owner = await teacherClient(t);
    const { id } = await createClass(owner);
    const res = await owner
      .post(`/api/classes/${id}/import`)
      .send({ csv: 'Мельничук А\nМельничук Б\nМельничук В' })
      .expect(201);
    const logins = (res.body as { created: { login: string }[] }).created.map(
      (c) => c.login,
    );
    assert.deepEqual(logins, ['melnychuk', 'melnychuk2', 'melnychuk3']);
  });

  test('lines beyond 254 students are errors, earlier ones are created', async () => {
    const owner = await teacherClient(t);
    const { id } = await createClass(owner);
    fillStudents(t, id, MAX_STUDENTS_PER_CLASS - 1);
    const res = await owner
      .post(`/api/classes/${id}/import`)
      .send({ csv: 'Один Перший\nДва Другий' })
      .expect(201);
    const result = res.body as {
      created: { number: number }[];
      errors: { line: number; message: string }[];
    };
    assert.deepEqual(
      result.created.map((c) => c.number),
      [MAX_STUDENTS_PER_CLASS],
    );
    assert.deepEqual(result.errors, [
      { line: 2, message: 'У класі вже 254 студенти' },
    ]);
  });
});

describe('POST /api/classes/:id/assistants', () => {
  test('401, 404, 403 student and assistant, 400 bad body', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/assistants`;
    const login = (await whoAmI(s.stranger)).login;
    await t.client().post(url).send({ login }).expect(401);
    await s.stranger.post(url).send({ login }).expect(404);
    await s.student.post(url).send({ login }).expect(403);
    await s.assistant.post(url).send({ login }).expect(403);
    for (const payload of [{}, { login: '' }, { login, extra: 1 }]) {
      await s.owner.post(url).send(payload).expect(400);
    }
  });

  test('adds an assistant by login; unknown login, the owner and a student are refused', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/assistants`;
    const strangerLogin = (await whoAmI(s.stranger)).login;
    const res = await s.owner
      .post(url)
      .send({ login: strangerLogin.toUpperCase() })
      .expect(201);
    assert.deepEqual(
      detail(res)
        .members.filter((m) => m.role === 'assistant')
        .map((m) => m.name),
      ['Асистент', 'Сторонній'],
    );
    await s.owner.post(url).send({ login: strangerLogin }).expect(201);
    assert.equal(
      detail(await s.owner.get(`/api/classes/${s.classId}`)).members.length,
      3,
    );
    await s.stranger.get(`/api/classes/${s.classId}`).expect(200);
    await s.owner.post(url).send({ login: 'no.such.user' }).expect(404);
    await s.owner
      .post(url)
      .send({ login: (await whoAmI(s.owner)).login })
      .expect(400);
    await s.owner
      .post(url)
      .send({ login: (await whoAmI(s.student)).login })
      .expect(409);
  });
});

describe('DELETE /api/classes/:id/members/:userId', () => {
  test('401, 404 stranger, 403 student', async () => {
    const s = await scene();
    const url = `/api/classes/${s.classId}/members/${s.studentId}`;
    await t.client().delete(url).expect(401);
    await s.stranger.delete(url).expect(404);
    await s.student.delete(url).expect(403);
  });

  test('404 for a user who is not a member (also the owner)', async () => {
    const s = await scene();
    const ownerId = (await whoAmI(s.owner)).id;
    await s.owner
      .delete(`/api/classes/${s.classId}/members/${ownerId}`)
      .expect(404);
    await s.owner.delete(`/api/classes/${s.classId}/members/abc`).expect(404);
  });

  test('an assistant can remove a student but not an assistant; the owner can remove both', async () => {
    const s = await scene();
    const base = `/api/classes/${s.classId}/members`;
    await s.assistant.delete(`${base}/${s.assistantId}`).expect(403);
    await s.assistant.delete(`${base}/${s.studentId}`).expect(200);
    await s.student.get(`/api/classes/${s.classId}`).expect(404);
    await s.owner.delete(`${base}/${s.assistantId}`).expect(200);
    await s.assistant.get(`/api/classes/${s.classId}`).expect(404);
  });
});
