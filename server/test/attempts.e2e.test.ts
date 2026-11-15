import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ApiError, Attempt, Branch, ChunkInfo } from '@shared/api';
import { MAX_CHUNK_BYTES, MAX_JOURNAL_BYTES } from '@shared/limits';
import { ProgressBus, type ProgressEvent } from '../src/attempts/progress-bus';
import {
  ev,
  evs,
  forkBranch,
  HEADER,
  journalOf,
  openAttempt,
  putEvents,
  startBranch,
  tags,
  world,
  World,
} from './attempt-fixtures';
import { PAIR } from './fixtures';
import { createTestApp, TestApp, whoAmI } from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

const error = (res: { body: unknown }): ApiError => res.body as ApiError;

describe('POST and GET /api/assignments/:id/attempt', () => {
  test('401 without login, 404 for an unknown assignment and for people outside the class', async () => {
    const w = await world(t);
    const url = `/api/assignments/${w.assignment.id}/attempt`;
    await t.client().post(url).expect(401);
    await t.client().get(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.outsider.post(url).expect(404);
    await w.outsider.get(url).expect(404);
    await w.student.post('/api/assignments/999999/attempt').expect(404);
    await w.student.get('/api/assignments/abc/attempt').expect(404);
  });

  test('GET is 404 until the attempt exists', async () => {
    const w = await world(t);
    const res = await w.student
      .get(`/api/assignments/${w.assignment.id}/attempt`)
      .expect(404);
    assert.equal(error(res).message, 'Спробу не знайдено');
  });

  test('a student gets a new attempt with their number, the second call returns it', async () => {
    const w = await world(t);
    const url = `/api/assignments/${w.assignment.id}/attempt`;
    const created = (await w.student.post(url).expect(201)).body as Attempt;
    assert.equal(created.assignment_id, w.assignment.id);
    assert.equal(created.variant, 1);
    assert.equal(created.is_preview, false);
    assert.deepEqual(created.heads, {});
    assert.deepEqual(created.branches, []);
    const again = (await w.student.post(url).expect(200)).body as Attempt;
    assert.equal(again.id, created.id);
    const second = (await w.classmate.post(url).expect(201)).body as Attempt;
    assert.equal(second.variant, 2);
    const fetched = (await w.student.get(url).expect(200)).body as Attempt;
    assert.equal(fetched.id, created.id);
  });

  test('a teacher of the class gets a preview attempt with variant 1', async () => {
    const w = await world(t);
    const mine = await openAttempt(w.assistant, w.assignment.id);
    assert.equal(mine.is_preview, true);
    assert.equal(mine.variant, 1);
    assert.equal(
      (await openAttempt(w.owner, w.assignment.id)).is_preview,
      true,
    );
  });

  test('a deleted assignment has no attempts', async () => {
    const w = await world(t);
    await w.owner.delete(`/api/assignments/${w.assignment.id}`).expect(200);
    await w.student
      .post(`/api/assignments/${w.assignment.id}/attempt`)
      .expect(404);
  });

  test('opening is logged but notifies nobody', async () => {
    const w = await world(t);
    await openAttempt(w.student, w.assignment.id);
    const list = (await w.owner.get('/api/notifications').expect(200)).body as {
      items: { kind: string }[];
    };
    assert.equal(
      list.items.filter((i) => i.kind === 'attempt_opened').length,
      0,
    );
    const rows = t.db.all<{ kind: string }>(
      "SELECT kind FROM activity WHERE kind = 'attempt_opened' AND class_id = ?",
      w.classId,
    );
    assert.equal(rows.length, 1);
  });
});

describe('GET /api/attempts/:id', () => {
  test('401, 404 outside the class, 403 for a classmate, ok for the owner and the teachers', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const url = `/api/attempts/${attempt.id}`;
    await t.client().get(url).expect(401);
    await w.stranger.get(url).expect(404);
    await w.outsider.get(url).expect(404);
    await w.classmate.get(url).expect(403);
    await w.student.get(url).expect(200);
    await w.owner.get(url).expect(200);
    await w.assistant.get(url).expect(200);
    await w.owner.get('/api/attempts/999999').expect(404);
    await w.owner.get('/api/attempts/x').expect(404);
  });

  test('lists branches, heads, help, submissions and hints', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    const view = (await w.owner.get(`/api/attempts/${attempt.id}`).expect(200))
      .body as Attempt;
    assert.deepEqual(view.heads, { m1: start.id });
    assert.equal(view.branches.length, 1);
    assert.equal(view.branches[0]?.author.name, 'Студент');
    assert.deepEqual(
      [view.help, view.submissions, view.hints_used],
      [[], [], []],
    );
  });
});

describe('POST /api/attempts/:id/branches', () => {
  const url = (id: number) => `/api/attempts/${id}/branches`;
  const body = (extra: Record<string, unknown> = {}) => ({
    node: 'm1',
    parent: null,
    kind: 'start',
    header: HEADER,
    make_head: true,
    ...extra,
  });

  test('401, 404 outside the class, 403 for a classmate', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    await t.client().post(url(attempt.id)).send(body()).expect(401);
    await w.stranger.post(url(attempt.id)).send(body()).expect(404);
    await w.outsider.post(url(attempt.id)).send(body()).expect(404);
    await w.classmate.post(url(attempt.id)).send(body()).expect(403);
    await w.student.post(url(999_999)).send(body()).expect(404);
  });

  test('400 on a wrong body', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const bad: Record<string, unknown>[] = [
      { node: undefined },
      { node: '' },
      { kind: 'fork' },
      { header: 'x' },
      { make_head: 'yes' },
      { parent: 5 },
      { parent: { branch_id: 0, event: 0 } },
      { parent: { branch_id: 1, event: -1 } },
      { extra: 1 },
    ];
    for (const change of bad) {
      await w.student.post(url(attempt.id)).send(body(change)).expect(400);
    }
  });

  test('a teacher cannot start or roll back a student machine; a student cannot reply', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    await w.owner.post(url(attempt.id)).send(body()).expect(403);
    const start = await startBranch(w.student, attempt.id);
    const fork = { branch_id: start.id, event: 0 };
    await w.owner
      .post(url(attempt.id))
      .send(body({ parent: fork, kind: 'rollback', make_head: false }))
      .expect(403);
    await w.student
      .post(url(attempt.id))
      .send(body({ parent: fork, kind: 'reply', make_head: false }))
      .expect(403);
  });

  test('only a teacher makes a reply, and only the owner of the attempt makes a head', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 4));
    const parent = { branch_id: start.id, event: 2 };
    const denied = await w.assistant
      .post(url(attempt.id))
      .send(body({ parent, kind: 'reply', make_head: true }))
      .expect(403);
    assert.match(error(denied).message, /автор спроби/);
    const reply = (
      await w.assistant
        .post(url(attempt.id))
        .send(body({ parent, kind: 'reply', make_head: false }))
        .expect(201)
    ).body as Branch;
    assert.equal(reply.kind, 'reply');
    assert.equal(reply.author.name, 'Асистент');
    assert.equal(reply.fork_event, 2);
    assert.equal(reply.event_count, 2);
    const view = (
      await w.student.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as Attempt;
    assert.deepEqual(view.heads, { m1: start.id });
  });

  test('start: made once per machine, becomes the head, must name a machine of the task', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const first = (
      await w.student.post(url(attempt.id)).send(body()).expect(201)
    ).body as Branch;
    assert.equal(first.kind, 'start');
    assert.equal(first.parent_id, null);
    assert.equal(first.event_count, 0);
    assert.equal(first.fork_event, 0);
    const again = await w.student
      .post(url(attempt.id))
      .send(body())
      .expect(400);
    assert.match(error(again).message, /початкова гілка вже є/);
    const unknown = await w.student
      .post(url(attempt.id))
      .send(body({ node: 'zzz' }))
      .expect(400);
    assert.match(error(unknown).message, /zzz/);
    const view = (
      await w.student.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as Attempt;
    assert.deepEqual(view.heads, { m1: first.id });
  });

  test('the header is checked: the profile of the machine, the core rules', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const wrongProfile = await w.student
      .post(url(attempt.id))
      .send(body({ header: { ...HEADER, profile: 'alpine' } }))
      .expect(400);
    assert.equal(error(wrongProfile).code, 'journal_invalid');
    const wrongFormat = await w.student
      .post(url(attempt.id))
      .send(body({ header: { ...HEADER, format: 'v86-replay/1' } }))
      .expect(400);
    assert.equal(error(wrongFormat).code, 'journal_invalid');
    const badRate = await w.student
      .post(url(attempt.id))
      .send(body({ header: { ...HEADER, rate0: { at: 0, ms: 0, per_ms: 1 } } }))
      .expect(400);
    assert.equal(error(badRate).code, 'journal_invalid');
  });

  test('a fork needs a parent of the same attempt and machine, not past its end', async () => {
    const w = await world(t, { topology: PAIR });
    const attempt = await openAttempt(w.student, w.assignment.id);
    const otherAttempt = await openAttempt(w.classmate, w.assignment.id);
    const m1 = await startBranch(w.student, attempt.id, 'm1');
    const m2 = await startBranch(w.student, attempt.id, 'm2', 'alpine');
    const foreign = await startBranch(w.classmate, otherAttempt.id, 'm1');
    await putEvents(w.student, m1.id, 0, evs(0, 3));
    const rollback = (parent: unknown) =>
      w.student.post(url(attempt.id)).send(body({ parent, kind: 'rollback' }));
    await rollback(null).expect(400);
    await rollback({ branch_id: foreign.id, event: 0 }).expect(400);
    await rollback({ branch_id: m2.id, event: 0 }).expect(400);
    await rollback({ branch_id: 999_999, event: 0 }).expect(400);
    const past = await rollback({ branch_id: m1.id, event: 4 }).expect(400);
    assert.match(error(past).message, /за межами/);
    const withParent = await w.student
      .post(url(attempt.id))
      .send(body({ parent: { branch_id: m1.id, event: 0 } }))
      .expect(400);
    assert.match(error(withParent).message, /Початкова гілка/);
    const ok = (await rollback({ branch_id: m1.id, event: 3 }).expect(201))
      .body as Branch;
    assert.equal(ok.parent_id, m1.id);
    assert.equal(ok.fork_event, 3);
    assert.equal(ok.event_count, 3);
  });

  test('make_head false leaves the head alone, true moves it', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    const parent = { branch_id: start.id, event: 0 };
    const quiet = await forkBranch(
      w.student,
      attempt.id,
      parent,
      'continue',
      false,
    );
    let view = (await w.student.get(`/api/attempts/${attempt.id}`).expect(200))
      .body as Attempt;
    assert.deepEqual(view.heads, { m1: start.id });
    const moved = await forkBranch(
      w.student,
      attempt.id,
      parent,
      'rollback',
      true,
    );
    view = (await w.student.get(`/api/attempts/${attempt.id}`).expect(200))
      .body as Attempt;
    assert.deepEqual(view.heads, { m1: moved.id });
    assert.notEqual(quiet.id, moved.id);
  });
});

describe('POST /api/attempts/:id/heads', () => {
  test('401, 404, 403, 400 on a wrong body or a foreign branch, and success', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    const other = await forkBranch(
      w.student,
      attempt.id,
      { branch_id: start.id, event: 0 },
      'continue',
      false,
    );
    const url = `/api/attempts/${attempt.id}/heads`;
    const good = { node: 'm1', branch_id: other.id };
    await t.client().post(url).send(good).expect(401);
    await w.stranger.post(url).send(good).expect(404);
    await w.classmate.post(url).send(good).expect(403);
    await w.owner.post(url).send(good).expect(403);
    await w.student.post(url).send({ node: 'm1' }).expect(400);
    await w.student
      .post(url)
      .send({ ...good, branch_id: 0 })
      .expect(400);
    await w.student
      .post(url)
      .send({ ...good, node: 'm2' })
      .expect(400);
    await w.student
      .post(url)
      .send({ ...good, branch_id: 999_999 })
      .expect(400);
    const view = (await w.student.post(url).send(good).expect(200))
      .body as Attempt;
    assert.deepEqual(view.heads, { m1: other.id });
  });
});

describe('PUT /api/branches/:id/events', () => {
  async function started(): Promise<{
    w: World;
    attempt: Attempt;
    start: Branch;
  }> {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    return { w, attempt, start: await startBranch(w.student, attempt.id) };
  }

  test('401, 404, 403 and 400', async () => {
    const { w, start } = await started();
    const url = `/api/branches/${start.id}/events`;
    const good = { from: 0, events: evs(0, 2) };
    await t.client().put(url).send(good).expect(401);
    await w.stranger.put(url).send(good).expect(404);
    await w.outsider.put(url).send(good).expect(404);
    await w.classmate.put(url).send(good).expect(403);
    await w.owner.put(url).send(good).expect(403);
    await w.student.put('/api/branches/999999/events').send(good).expect(404);
    for (const bad of [
      {},
      { from: 0 },
      { from: 0, events: [] },
      { from: 0, events: 'x' },
      { from: -1, events: evs(0, 1) },
      { from: 'a', events: evs(0, 1) },
      { ...good, extra: 1 },
      { ...good, meta: { commands: -1, last_command: 'x' } },
      { ...good, meta: { commands: 1 } },
    ]) {
      await w.student.put(url).send(bad).expect(400);
    }
    await w.student.put(url).send(good).expect(200);
  });

  test('chunks add up; the count is the full journal count', async () => {
    const { w, start } = await started();
    assert.equal(await putEvents(w.student, start.id, 0, evs(0, 3)), 3);
    assert.equal(await putEvents(w.student, start.id, 3, evs(3, 4)), 4);
    assert.equal(await putEvents(w.student, start.id, 4, evs(4, 10)), 10);
    const chunks = (
      await w.owner.get(`/api/branches/${start.id}/chunks`).expect(200)
    ).body as ChunkInfo[];
    assert.deepEqual(
      chunks.map((c) => [c.first_event, c.event_count]),
      [
        [0, 3],
        [3, 1],
        [4, 6],
      ],
    );
    assert.equal(chunks[0]?.received_at, t.clock.current);
    assert.ok((chunks[0]?.bytes ?? 0) > 0);
  });

  test('a gap is 409 chunk_gap with the saved count, and resending from it works', async () => {
    const { w, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 3));
    const url = `/api/branches/${start.id}/events`;
    for (const from of [5, 0, 2]) {
      const res = await w.student
        .put(url)
        .send({ from, events: evs(from, from + 2) })
        .expect(409);
      const body = error(res) as ApiError & { event_count: number };
      assert.equal(body.code, 'chunk_gap');
      assert.equal(body.event_count, 3);
    }
    assert.equal(await putEvents(w.student, start.id, 3, evs(3, 5)), 5);
  });

  test('an event earlier than the end of the branch is 400 journal_invalid', async () => {
    const { w, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 3));
    const url = `/api/branches/${start.id}/events`;
    const early = await w.student
      .put(url)
      .send({ from: 3, events: [ev(1)] })
      .expect(400);
    assert.equal(error(early).code, 'journal_invalid');
    assert.match(error(early).message, /порядок порушено/);
    // Equal c with a smaller w is also earlier.
    await putEvents(w.student, start.id, 3, [
      { t: 'serial', c: 5000, w: 2, data: 'a' },
    ]);
    await w.student
      .put(url)
      .send({ from: 4, events: [{ t: 'serial', c: 5000, w: 1, data: 'b' }] })
      .expect(400);
    await w.student
      .put(url)
      .send({ from: 4, events: [{ t: 'serial', c: 5000, w: 2, data: 'b' }] })
      .expect(200);
  });

  test('a fork carries the bound of the event before it', async () => {
    const { w, attempt, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 10));
    const rollback = await forkBranch(w.student, attempt.id, {
      branch_id: start.id,
      event: 5,
    });
    const url = `/api/branches/${rollback.id}/events`;
    // Event 4 has c = 5000: an event with c = 4000 is earlier although the branch has no chunks yet.
    await w.student
      .put(url)
      .send({ from: 5, events: [ev(3)] })
      .expect(400);
    assert.equal(await putEvents(w.student, rollback.id, 5, evs(5, 8, 'r')), 8);
    const journal = await journalOf(w.student, rollback.id);
    assert.deepEqual(tags(journal.events), [
      'e0',
      'e1',
      'e2',
      'e3',
      'e4',
      'r5',
      'r6',
      'r7',
    ]);
  });

  test('a core violation inside the chunk is 400 journal_invalid with the position', async () => {
    const { w, start } = await started();
    const url = `/api/branches/${start.id}/events`;
    const bad = await w.student
      .put(url)
      .send({
        from: 0,
        events: [ev(0), { t: 'serial', c: 2000, w: 0, data: 5 }],
      })
      .expect(400);
    assert.equal(error(bad).code, 'journal_invalid');
    assert.match(error(bad).message, /Фрагмент з події 0/);
    const unknown = await w.student
      .put(url)
      .send({ from: 0, events: [{ t: 'warp', c: 1, w: 0 }] })
      .expect(400);
    assert.equal(error(unknown).code, 'journal_invalid');
    const state = t.db.get<{ event_count: number }>(
      'SELECT event_count FROM branches WHERE id = ?',
      start.id,
    );
    assert.equal(state?.event_count, 0);
  });

  test('a chunk bigger than 1 MiB passes here and is 413 on an ordinary route', async () => {
    const { w, start } = await started();
    const events = Array.from({ length: 12_000 }, (_, i) => ({
      t: 'serial',
      c: (i + 1) * 10,
      w: 0,
      data: 'x'.repeat(120),
    }));
    const size = Buffer.byteLength(JSON.stringify({ from: 0, events }));
    assert.ok(size > 1024 * 1024, `body is ${size} bytes`);
    assert.equal(await putEvents(w.student, start.id, 0, events), 12_000);
    const res = await w.student
      .post('/api/auth/login')
      .send({ pad: 'x'.repeat(size) })
      .expect(413);
    assert.equal(error(res).statusCode, 413);
    assert.equal(typeof error(res).message, 'string');
  });

  test('a chunk past MAX_CHUNK_BYTES is 413 journal_too_large', async () => {
    const { w, start } = await started();
    const res = await w.student
      .put(`/api/branches/${start.id}/events`)
      .set('Content-Type', 'application/json')
      .send(`{"from":0,"events":[],"pad":"${'x'.repeat(MAX_CHUNK_BYTES)}"}`)
      .expect(413);
    assert.equal(error(res).code, 'journal_too_large');
  });

  test('the size of the whole path counts, ancestors included, and refuses with 413', async () => {
    const { w, attempt, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 10));
    const rollback = await forkBranch(w.student, attempt.id, {
      branch_id: start.id,
      event: 2,
    });
    // The ancestor's chunk after the fork still counts: the limit is a plain sum over the path.
    t.db.run(
      'UPDATE branches SET bytes = ? WHERE id = ?',
      MAX_JOURNAL_BYTES - 10,
      start.id,
    );
    const url = `/api/branches/${rollback.id}/events`;
    const res = await w.student
      .put(url)
      .send({ from: 2, events: evs(2, 5) })
      .expect(413);
    assert.equal(error(res).code, 'journal_too_large');
    t.db.run('UPDATE branches SET bytes = 0 WHERE id = ?', start.id);
    await w.student
      .put(url)
      .send({ from: 2, events: evs(2, 5) })
      .expect(200);
  });

  test('meta feeds the tile and is cut to 200 characters', async () => {
    const { w, attempt, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 2), {
      commands: 3,
      last_command: 'x'.repeat(500),
    });
    const row = t.db.get<{
      commands: number;
      last_command: string;
      last_activity_at: number;
    }>(
      'SELECT commands, last_command, last_activity_at FROM attempts WHERE id = ?',
      attempt.id,
    );
    assert.equal(row?.commands, 3);
    assert.equal(row?.last_command.length, 200);
    assert.equal(row?.last_activity_at, t.clock.current);
    t.clock.advance(5000);
    await putEvents(w.student, start.id, 2, evs(2, 3));
    const kept = t.db.get<{ commands: number; last_activity_at: number }>(
      'SELECT commands, last_activity_at FROM attempts WHERE id = ?',
      attempt.id,
    );
    assert.equal(kept?.commands, 3);
    assert.equal(kept?.last_activity_at, t.clock.current);
  });

  test('every chunk is announced on progress$ after it is saved', async () => {
    const { w, attempt, start } = await started();
    const seen: ProgressEvent[] = [];
    const subscription = t.app
      .get(ProgressBus)
      .progress$.subscribe((e) => seen.push(e));
    await putEvents(w.student, start.id, 0, evs(0, 2));
    subscription.unsubscribe();
    const me = await whoAmI(w.student);
    assert.deepEqual(seen, [
      { assignment_id: attempt.assignment_id, user_id: me.id },
    ]);
  });

  test('only the teacher who wrote a reply appends to it; their chunks do not touch the tile', async () => {
    const { w, attempt, start } = await started();
    await putEvents(w.student, start.id, 0, evs(0, 6), {
      commands: 2,
      last_command: 'ls',
    });
    const reply = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: start.id, event: 4 },
      'reply',
    );
    const url = `/api/branches/${reply.id}/events`;
    const events = evs(4, 6, 'r');
    await w.student.put(url).send({ from: 4, events }).expect(403);
    await w.owner.put(url).send({ from: 4, events }).expect(403);
    t.clock.advance(9000);
    await w.assistant
      .put(url)
      .send({ from: 4, events, meta: { commands: 99, last_command: 'rm' } })
      .expect(200);
    await w.assistant
      .put(`/api/branches/${start.id}/events`)
      .send({ from: 6, events: [ev(6)] })
      .expect(403);
    const row = t.db.get<{ commands: number; last_command: string }>(
      'SELECT commands, last_command FROM attempts WHERE id = ?',
      attempt.id,
    );
    assert.equal(row?.commands, 2);
    assert.equal(row?.last_command, 'ls');
    const journal = await journalOf(w.student, reply.id);
    assert.deepEqual(tags(journal.events), [
      'e0',
      'e1',
      'e2',
      'e3',
      'r4',
      'r5',
    ]);
  });
});

describe('GET /api/branches/:id/journal and /chunks', () => {
  test('401, 404, 403; the owner and the teachers read', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    for (const suffix of ['journal', 'chunks']) {
      const url = `/api/branches/${start.id}/${suffix}`;
      await t.client().get(url).expect(401);
      await w.stranger.get(url).expect(404);
      await w.outsider.get(url).expect(404);
      await w.classmate.get(url).expect(403);
      await w.student.get(url).expect(200);
      await w.owner.get(url).expect(200);
      await w.assistant.get(url).expect(200);
      await w.student.get(`/api/branches/999999/${suffix}`).expect(404);
    }
  });

  test('the journal comes as header then events; ?to cuts it; a bad ?to is 400', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    await putEvents(w.student, start.id, 3, evs(3, 6));
    const res = await w.owner
      .get(`/api/branches/${start.id}/journal`)
      .expect(200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.deepEqual((res.body as { header: unknown }).header, HEADER);
    assert.equal(Object.keys(res.body as object)[0], 'header');
    assert.deepEqual(tags((res.body as { events: unknown[] }).events), [
      'e0',
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
    ]);
    assert.deepEqual(tags((await journalOf(w.owner, start.id, 4)).events), [
      'e0',
      'e1',
      'e2',
      'e3',
    ]);
    assert.deepEqual((await journalOf(w.owner, start.id, 0)).events, []);
    for (const to of ['7', '-1', 'x', '1.5']) {
      await w.owner
        .get(`/api/branches/${start.id}/journal?to=${to}`)
        .expect(400);
    }
  });

  test('rollback, reply and continuation read the right events of each ancestor', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 10));
    const rollback = await forkBranch(w.student, attempt.id, {
      branch_id: start.id,
      event: 7,
    });
    await putEvents(w.student, rollback.id, 7, evs(7, 10, 'r'));
    // Event 4 lies in the part the rollback inherited from the start.
    const reply = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: rollback.id, event: 4 },
      'reply',
    );
    await putEvents(w.assistant, reply.id, 4, evs(4, 6, 'p'));
    const next = await forkBranch(
      w.student,
      attempt.id,
      { branch_id: reply.id, event: 6 },
      'continue',
    );
    await putEvents(w.student, next.id, 6, evs(6, 8, 'n'));
    const read = async (id: number, to?: number) =>
      tags((await journalOf(w.owner, id, to)).events);
    assert.deepEqual(await read(rollback.id), [
      'e0',
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'r7',
      'r8',
      'r9',
    ]);
    assert.deepEqual(await read(reply.id), [
      'e0',
      'e1',
      'e2',
      'e3',
      'p4',
      'p5',
    ]);
    assert.deepEqual(await read(next.id), [
      'e0',
      'e1',
      'e2',
      'e3',
      'p4',
      'p5',
      'n6',
      'n7',
    ]);
    assert.deepEqual(await read(next.id, 3), ['e0', 'e1', 'e2']);
    assert.deepEqual(await read(next.id, 5), ['e0', 'e1', 'e2', 'e3', 'p4']);
    assert.deepEqual(await read(start.id), tags(evs(0, 10)));
  });
});
