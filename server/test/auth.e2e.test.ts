import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SESSION_TTL_MS } from '@shared/limits';
import {
  body,
  createClass,
  createTestApp,
  TestApp,
  studentClient,
  teacherClient,
  whoAmI,
} from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

const teacherBody = {
  login: 'ivan.petrenko',
  password: 'password123',
  name: 'Іван Петренко',
  role: 'teacher',
};

describe('POST /api/auth/register', () => {
  test('creates a teacher, sets an HttpOnly cookie and logs in', async () => {
    const client = t.client();
    const res = await client
      .post('/api/auth/register')
      .send(teacherBody)
      .expect(201);
    assert.deepEqual(body(res), {
      id: body(res).id,
      login: 'ivan.petrenko',
      name: 'Іван Петренко',
      role: 'teacher',
    });
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    assert.match(cookie, /sid=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/);
    await client.get('/api/me').expect(200);
  });

  test('stores only the sha256 of the session token', async () => {
    const client = t.client();
    const res = await client
      .post('/api/auth/register')
      .send({ ...teacherBody, login: 'hash.check' })
      .expect(201);
    const token = /sid=([^;]+)/.exec(
      (res.headers['set-cookie'] as unknown as string[]).join(';'),
    )?.[1];
    assert.ok(token);
    const rows = t.db.all<{ token_hash: string }>(
      'SELECT token_hash FROM sessions',
    );
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every(
        (row) =>
          row.token_hash !== token && /^[0-9a-f]{64}$/.test(row.token_hash),
      ),
    );
  });

  test('stores the login in lower case and the password as scrypt', async () => {
    await t
      .client()
      .post('/api/auth/register')
      .send({ ...teacherBody, login: 'Mixed.Case' })
      .expect(201);
    const row = t.db.get<{ login: string; password_hash: string }>(
      'SELECT login, password_hash FROM users WHERE login = ?',
      'mixed.case',
    );
    assert.ok(row);
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  });

  test('409 login_taken for a taken login, whatever its case', async () => {
    const res = await t
      .client()
      .post('/api/auth/register')
      .send({ ...teacherBody, login: 'IVAN.PETRENKO' })
      .expect(409);
    assert.equal(body(res).code, 'login_taken');
    assert.equal(body(res).statusCode, 409);
    assert.equal(typeof body(res).message, 'string');
  });

  test('400 for a malformed body, with a Ukrainian one-sentence message', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...teacherBody, login: 'ab' }, /^Поле login: /],
      [
        { ...teacherBody, password: 'short' },
        /^Поле password: має містити щонайменше 8 символів$/,
      ],
      [{ ...teacherBody, name: '   ' }, /^Поле name: не може бути порожнім$/],
      [{ ...teacherBody, role: 'admin' }, /^Поле role: /],
      [{ ...teacherBody, extra: 1 }, /^Поле extra: не передбачено$/],
      [{}, /^Поле /],
    ];
    for (const [payload, message] of cases) {
      const res = await t
        .client()
        .post('/api/auth/register')
        .send(payload)
        .expect(400);
      assert.match(String(body(res).message), message);
      assert.equal(body(res).statusCode, 400);
    }
  });

  test('400 on malformed JSON, still in the ApiError shape with a generic text', async () => {
    const res = await t
      .client()
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"login": ')
      .expect(400);
    assert.equal(body(res).statusCode, 400);
    assert.equal(body(res).message, 'Некоректний запит');
  });

  test('a student needs a valid invite code: 400 bad_invite', async () => {
    const studentBody = {
      login: 'no.code',
      password: 'password123',
      name: 'Без коду',
      role: 'student',
    };
    for (const extra of [
      {},
      { invite_code: 'ZZZZZZZZ' },
      { invite_code: 'bad' },
    ]) {
      const res = await t
        .client()
        .post('/api/auth/register')
        .send({ ...studentBody, ...extra })
        .expect(400);
      assert.equal(body(res).code, 'bad_invite');
    }
    assert.equal(
      t.db.get('SELECT 1 FROM users WHERE login = ?', 'no.code'),
      undefined,
    );
  });

  test('a teacher with an invite code is rejected', async () => {
    const owner = await teacherClient(t);
    const { code } = await createClass(owner);
    const res = await t
      .client()
      .post('/api/auth/register')
      .send({ ...teacherBody, login: 'teacher.code', invite_code: code })
      .expect(400);
    assert.equal(body(res).code, 'bad_invite');
  });

  test('a student with a code joins at once and gets number 1', async () => {
    const owner = await teacherClient(t);
    const { id, code } = await createClass(owner);
    const student = await studentClient(t, code.toLowerCase());
    const res = await student.get(`/api/classes/${id}`).expect(200);
    assert.equal(body(res).my_role, 'student');
    const members = (await owner.get(`/api/classes/${id}`).expect(200))
      .body as {
      members: { number: number; role: string }[];
    };
    assert.deepEqual(
      members.members.map((m) => [m.role, m.number]),
      [['student', 1]],
    );
  });
});

describe('POST /api/auth/login', () => {
  test('logs in with the right password (login in any case)', async () => {
    const client = t.client();
    const res = await client
      .post('/api/auth/login')
      .send({ login: 'Ivan.Petrenko', password: 'password123' })
      .expect(200);
    assert.equal(body(res).login, 'ivan.petrenko');
    await client.get('/api/me').expect(200);
  });

  test('401 without not_logged_in for a wrong password or an unknown login', async () => {
    for (const payload of [
      { login: 'ivan.petrenko', password: 'wrong-password' },
      { login: 'nobody.here', password: 'password123' },
    ]) {
      const res = await t
        .client()
        .post('/api/auth/login')
        .send(payload)
        .expect(401);
      assert.equal(body(res).code, undefined);
      assert.equal(body(res).message, 'Неправильний логін або пароль');
    }
  });

  test('400 for a malformed body', async () => {
    await t.client().post('/api/auth/login').send({ login: 'x' }).expect(400);
    await t
      .client()
      .post('/api/auth/login')
      .send({ login: 'x', password: 1 })
      .expect(400);
  });
});

describe('sessions', () => {
  test('401 not_logged_in without a session on every protected auth route', async () => {
    for (const [method, url] of [
      ['get', '/api/me'],
      ['patch', '/api/me'],
      ['post', '/api/auth/logout'],
    ] as const) {
      const res = await t.client()[method](url).send({}).expect(401);
      assert.equal(body(res).code, 'not_logged_in');
      assert.equal(body(res).statusCode, 401);
    }
  });

  test('POST /api/auth/logout ends the session and clears the cookie', async () => {
    const client = await teacherClient(t);
    const res = await client.post('/api/auth/logout').expect(200);
    assert.match(
      (res.headers['set-cookie'] as unknown as string[]).join(';'),
      /sid=;/,
    );
    await client.get('/api/me').expect(401);
  });

  test('a session expires after SESSION_TTL_MS', async () => {
    const client = await teacherClient(t);
    t.clock.advance(SESSION_TTL_MS - 1);
    await client.get('/api/me').expect(200);
    t.clock.advance(2);
    await client.get('/api/me').expect(401);
  });

  test('last_seen_at is refreshed at most once a minute', async () => {
    const client = await teacherClient(t);
    const { id } = await whoAmI(client);
    const seen = (): number | null =>
      t.db.get<{ last_seen_at: number | null }>(
        'SELECT last_seen_at FROM users WHERE id = ?',
        id,
      )?.last_seen_at ?? null;
    const first = seen();
    t.clock.advance(30_000);
    await client.get('/api/me').expect(200);
    assert.equal(seen(), first);
    t.clock.advance(31_000);
    await client.get('/api/me').expect(200);
    assert.equal(seen(), t.clock.current);
  });
});

describe('GET/PATCH /api/me', () => {
  test('returns Me', async () => {
    const client = await teacherClient(t, 'Марія');
    const me = await whoAmI(client);
    assert.equal(me.name, 'Марія');
    assert.equal(me.role, 'teacher');
  });

  test('PATCH renames the user', async () => {
    const client = await teacherClient(t);
    const res = await client
      .patch('/api/me')
      .send({ name: '  Нове Ім’я ' })
      .expect(200);
    assert.equal(body(res).name, 'Нове Ім’я');
    assert.equal((await whoAmI(client)).name, 'Нове Ім’я');
  });

  test('PATCH changes the password: needs the old one and drops other sessions', async () => {
    const client = await teacherClient(t);
    const { login } = await whoAmI(client);
    const other = t.client();
    await other
      .post('/api/auth/login')
      .send({ login, password: 'password123' })
      .expect(200);

    await client
      .patch('/api/me')
      .send({ password: { old: 'not-the-old-one', new: 'brand-new-pass' } })
      .expect(400);
    await client
      .patch('/api/me')
      .send({ password: { old: 'password123', new: 'brand-new-pass' } })
      .expect(200);

    await client.get('/api/me').expect(200);
    await other.get('/api/me').expect(401);
    await t
      .client()
      .post('/api/auth/login')
      .send({ login, password: 'password123' })
      .expect(401);
    await t
      .client()
      .post('/api/auth/login')
      .send({ login, password: 'brand-new-pass' })
      .expect(200);
  });

  test('PATCH 400 for a malformed body', async () => {
    const client = await teacherClient(t);
    for (const payload of [
      { name: '' },
      { name: 5 },
      { role: 'teacher' },
      { password: { old: 'password123' } },
      { password: { old: 'password123', new: 'short' } },
      { password: 'password123' },
    ]) {
      await client.patch('/api/me').send(payload).expect(400);
    }
  });
});
