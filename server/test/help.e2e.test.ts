import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type {
  ApiError,
  Assignment,
  Attempt,
  Branch,
  ClassDetail,
  HelpRequest,
  HintSlot,
  NotificationList,
} from '@shared/api';
import {
  evs,
  forkBranch,
  openAttempt,
  putEvents,
  startBranch,
  world,
  World,
} from './attempt-fixtures';
import { Client, createTestApp, TestApp } from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

const error = (res: { body: unknown }): ApiError => res.body as ApiError;
const kinds = async (client: Client): Promise<string[]> =>
  (
    (await client.get('/api/notifications').expect(200))
      .body as NotificationList
  ).items.map((item) => item.kind);

interface Scene {
  w: World;
  attempt: Attempt;
  start: Branch;
}

async function scene(
  hints?: { text: string; penalty: number }[],
): Promise<Scene> {
  const w = await world(t, hints ? { hints } : {});
  const attempt = await openAttempt(w.student, w.assignment.id);
  const start = await startBranch(w.student, attempt.id);
  await putEvents(w.student, start.id, 0, evs(0, 6));
  return { w, attempt, start };
}

const helpBody = (start: Branch, extra: Record<string, unknown> = {}) => ({
  node: 'm1',
  branch_id: start.id,
  event_count: 6,
  text: 'Не працює ping',
  ...extra,
});

const tile = async (
  client: Client,
  assignmentId: number,
): Promise<Assignment> =>
  (await client.get(`/api/assignments/${assignmentId}`).expect(200))
    .body as Assignment;

describe('POST /api/attempts/:id/help', () => {
  test('401, 404, 403 and 400', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/help`;
    await t.client().post(url).send(helpBody(start)).expect(401);
    await w.stranger.post(url).send(helpBody(start)).expect(404);
    await w.classmate.post(url).send(helpBody(start)).expect(403);
    await w.owner.post(url).send(helpBody(start)).expect(403);
    await w.student
      .post('/api/attempts/999999/help')
      .send(helpBody(start))
      .expect(404);
    for (const change of [
      { node: undefined },
      { text: '' },
      { text: '   ' },
      { text: 'x'.repeat(4001) },
      { event_count: -1 },
      { branch_id: 0 },
      { extra: 1 },
    ]) {
      await w.student.post(url).send(helpBody(start, change)).expect(400);
    }
  });

  test('a moment past the branch end, another machine or another attempt is 400', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/help`;
    await w.student
      .post(url)
      .send(helpBody(start, { event_count: 7 }))
      .expect(400);
    await w.student
      .post(url)
      .send(helpBody(start, { node: 'm2' }))
      .expect(400);
    const other = await openAttempt(w.classmate, w.assignment.id);
    const foreign = await startBranch(w.classmate, other.id);
    await w.student
      .post(url)
      .send(helpBody(foreign, { event_count: 0 }))
      .expect(400);
  });

  test('it makes the tile stuck, notifies the teachers and shows in the attempt', async () => {
    const { w, attempt, start } = await scene();
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'work');
    const res = await w.student
      .post(`/api/attempts/${attempt.id}/help`)
      .send(helpBody(start))
      .expect(201);
    const help = res.body as HelpRequest;
    assert.equal(help.event_count, 6);
    assert.equal(help.resolved_at, null);
    assert.equal(help.reply_branch_id, null);
    assert.equal(help.student.name, 'Студент');
    assert.equal(help.assignment_id, w.assignment.id);
    assert.equal(help.class_id, w.classId);
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'stuck');
    assert.equal((await tile(w.owner, w.assignment.id)).counts.stuck, 1);
    assert.deepEqual((await tile(w.owner, w.assignment.id)).counts, {
      stuck: 1,
      work: 0,
      done: 0,
      idle: 1,
    });
    assert.ok((await kinds(w.owner)).includes('help_requested'));
    assert.ok((await kinds(w.assistant)).includes('help_requested'));
    assert.ok(!(await kinds(w.student)).includes('help_requested'));
    const view = (
      await w.student.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as Attempt;
    assert.equal(view.help[0]?.id, help.id);
    const classDetail = (
      await w.owner.get(`/api/classes/${w.classId}`).expect(200)
    ).body as ClassDetail;
    assert.equal(classDetail.open_help, 1);
  });

  test('a teacher trying the task as a student does not notify the other teachers', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.assistant, w.assignment.id);
    const start = await startBranch(w.assistant, attempt.id);
    await w.assistant
      .post(`/api/attempts/${attempt.id}/help`)
      .send(helpBody(start, { event_count: 0 }))
      .expect(201);
    assert.ok(!(await kinds(w.owner)).includes('help_requested'));
    const counts = (await tile(w.owner, w.assignment.id)).counts;
    assert.deepEqual(counts, { stuck: 0, work: 0, done: 0, idle: 2 });
    const classDetail = (
      await w.owner.get(`/api/classes/${w.classId}`).expect(200)
    ).body as ClassDetail;
    assert.equal(classDetail.open_help, 0);
  });
});

describe('GET /api/help', () => {
  test('401, 400 on a bad filter; teachers see their classes, a student their own', async () => {
    const { w, attempt, start } = await scene();
    const mine = (
      await w.student
        .post(`/api/attempts/${attempt.id}/help`)
        .send(helpBody(start))
        .expect(201)
    ).body as HelpRequest;
    await t.client().get('/api/help').expect(401);
    await w.owner.get('/api/help?open=2').expect(400);
    const list = async (client: Client, query = '') =>
      (
        (await client.get(`/api/help${query}`).expect(200))
          .body as HelpRequest[]
      ).map((h) => h.id);
    assert.deepEqual(await list(w.owner), [mine.id]);
    assert.deepEqual(await list(w.assistant, '?open=1'), [mine.id]);
    assert.deepEqual(await list(w.student), [mine.id]);
    assert.deepEqual(await list(w.classmate), []);
    assert.deepEqual(await list(w.stranger), []);
    await w.owner.post(`/api/help/${mine.id}/resolve`).expect(200);
    assert.deepEqual(await list(w.owner, '?open=1'), []);
    assert.deepEqual(await list(w.owner), [mine.id]);
  });
});

describe('POST /api/help/:id/resolve', () => {
  test('401, 404, 403; a teacher closes it once and the student is told', async () => {
    const { w, attempt, start } = await scene();
    const help = (
      await w.student
        .post(`/api/attempts/${attempt.id}/help`)
        .send(helpBody(start))
        .expect(201)
    ).body as HelpRequest;
    const url = `/api/help/${help.id}/resolve`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.outsider.post(url).expect(404);
    await w.student.post(url).expect(403);
    await w.classmate.post(url).expect(403);
    await w.owner.post('/api/help/999999/resolve').expect(404);
    t.clock.advance(1000);
    const closed = (await w.assistant.post(url).expect(200))
      .body as HelpRequest;
    assert.equal(closed.resolved_at, t.clock.current);
    t.clock.advance(1000);
    const again = (await w.owner.post(url).expect(200)).body as HelpRequest;
    assert.equal(again.resolved_at, closed.resolved_at);
    assert.equal(
      (await kinds(w.student)).filter((k) => k === 'help_resolved').length,
      1,
    );
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'work');
  });
});

describe('POST /api/help/:id/reply', () => {
  async function asked(): Promise<Scene & { help: HelpRequest }> {
    const s = await scene();
    const help = (
      await s.w.student
        .post(`/api/attempts/${s.attempt.id}/help`)
        .send(helpBody(s.start))
        .expect(201)
    ).body as HelpRequest;
    return { ...s, help };
  }

  test('401, 404, 403 and 400', async () => {
    const { w, attempt, start, help } = await asked();
    const reply = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: start.id, event: 6 },
      'reply',
    );
    const url = `/api/help/${help.id}/reply`;
    await t.client().post(url).send({ branch_id: reply.id }).expect(401);
    await w.stranger.post(url).send({ branch_id: reply.id }).expect(404);
    await w.student.post(url).send({ branch_id: reply.id }).expect(403);
    await w.owner
      .post('/api/help/999999/reply')
      .send({ branch_id: reply.id })
      .expect(404);
    await w.owner.post(url).send({}).expect(400);
    await w.owner.post(url).send({ branch_id: 0 }).expect(400);
    await w.owner.post(url).send({ branch_id: reply.id, x: 1 }).expect(400);
  });

  test("the branch must be the caller's reply starting exactly at the moment of the request", async () => {
    const { w, attempt, start, help } = await asked();
    const url = `/api/help/${help.id}/reply`;
    const notReply = await forkBranch(
      w.student,
      attempt.id,
      { branch_id: start.id, event: 6 },
      'continue',
      false,
    );
    const wrongMoment = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: start.id, event: 5 },
      'reply',
    );
    const foreignAuthor = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: start.id, event: 6 },
      'reply',
    );
    const unknown = await w.owner
      .post(url)
      .send({ branch_id: 999_999 })
      .expect(400);
    assert.match(error(unknown).message, /відповіддю/);
    for (const branch of [notReply, wrongMoment, foreignAuthor]) {
      await w.owner.post(url).send({ branch_id: branch.id }).expect(400);
    }
    const other = await openAttempt(w.classmate, w.assignment.id);
    const otherStart = await startBranch(w.classmate, other.id);
    const elsewhere = await forkBranch(
      w.owner,
      other.id,
      { branch_id: otherStart.id, event: 0 },
      'reply',
    );
    await w.owner.post(url).send({ branch_id: elsewhere.id }).expect(400);
  });

  test('a reply closes the request, links the branch and tells the student; a second one is 409', async () => {
    const { w, attempt, start, help } = await asked();
    const reply = await forkBranch(
      w.assistant,
      attempt.id,
      { branch_id: start.id, event: 6 },
      'reply',
    );
    await putEvents(w.assistant, reply.id, 6, evs(6, 8, 'p'));
    const url = `/api/help/${help.id}/reply`;
    const done = (
      await w.assistant.post(url).send({ branch_id: reply.id }).expect(200)
    ).body as HelpRequest;
    assert.equal(done.reply_branch_id, reply.id);
    assert.equal(done.resolved_at, t.clock.current);
    assert.ok((await kinds(w.student)).includes('help_replied'));
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'work');
    await w.assistant.post(url).send({ branch_id: reply.id }).expect(409);
  });
});

describe('POST /api/attempts/:id/hints/:index', () => {
  const hints = [
    { text: 'Перевірте адресу', penalty: 1 },
    { text: 'Подивіться маску', penalty: 2 },
  ];

  test('401, 404, 403 and an index outside the hints', async () => {
    const { w, attempt } = await scene(hints);
    const url = (index: string | number) =>
      `/api/attempts/${attempt.id}/hints/${index}`;
    await t.client().post(url(0)).expect(401);
    await w.stranger.post(url(0)).expect(404);
    await w.classmate.post(url(0)).expect(403);
    await w.owner.post(url(0)).expect(403);
    await w.student.post('/api/attempts/999999/hints/0').expect(404);
    for (const index of [2, 99, 'x', -1, '1.5']) {
      await w.student.post(url(index)).expect(404);
    }
  });

  test('it opens a hint once: text for the student, one log entry, no penalty twice', async () => {
    const { w, attempt } = await scene(hints);
    const before = (await tile(w.student, w.assignment.id)).hints;
    assert.deepEqual(
      before.map((h) => h.text),
      [null, null],
    );
    const first = (
      await w.student.post(`/api/attempts/${attempt.id}/hints/1`).expect(200)
    ).body as HintSlot;
    assert.deepEqual(first, { index: 1, penalty: 2, text: 'Подивіться маску' });
    await w.student.post(`/api/attempts/${attempt.id}/hints/1`).expect(200);
    assert.deepEqual(
      (await tile(w.student, w.assignment.id)).hints.map((h) => h.text),
      [null, 'Подивіться маску'],
    );
    const logged = t.db.all<{ id: number }>(
      "SELECT id FROM activity WHERE kind = 'hint_used' AND assignment_id = ?",
      w.assignment.id,
    );
    assert.equal(logged.length, 1);
    const view = (
      await w.student.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as Attempt;
    assert.deepEqual(view.hints_used, [1]);
    assert.ok(!(await kinds(w.owner)).includes('hint_used'));
    // A classmate has opened nothing.
    assert.deepEqual(
      (await tile(w.classmate, w.assignment.id)).hints.map((h) => h.text),
      [null, null],
    );
  });
});
