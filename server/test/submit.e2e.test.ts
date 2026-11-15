import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type {
  ApiError,
  Assignment,
  Attempt,
  Branch,
  ClassDetail,
  Journal,
  JournalEvent,
  NotificationList,
  SubmissionSummary,
} from '@shared/api';
import { AssignmentsService } from '../src/assignments/assignments.service';
import { VerifyQueue } from '../src/attempts/verify-queue';
import { journalCore } from '../src/core';
import { repoRoot } from '../src/repo-root';
import {
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
import { Item, PAIR } from './fixtures';
import { Client, createTestApp, TestApp } from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
  t.app.get(VerifyQueue).use({ enqueue: (id) => queued.push(id) });
});
after(async () => {
  await t.close();
});

const error = (res: { body: unknown }): ApiError => res.body as ApiError;
const queued: number[] = [];
afterEach(() => {
  queued.length = 0;
});

const tile = async (
  client: Client,
  assignmentId: number,
): Promise<Assignment> =>
  (await client.get(`/api/assignments/${assignmentId}`).expect(200))
    .body as Assignment;
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

async function scene(count = 6): Promise<Scene> {
  const w = await world(t);
  const attempt = await openAttempt(w.student, w.assignment.id);
  const start = await startBranch(w.student, attempt.id);
  await putEvents(w.student, start.id, 0, evs(0, count));
  return { w, attempt, start };
}

const heads = (start: Branch, eventCount = 6, node = 'm1') => ({
  heads: [{ node, branch_id: start.id, event_count: eventCount }],
});

describe('POST /api/attempts/:id/submit', () => {
  test('401, 404, 403', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/submit`;
    await t.client().post(url).send(heads(start)).expect(401);
    await w.stranger.post(url).send(heads(start)).expect(404);
    await w.classmate.post(url).send(heads(start)).expect(403);
    await w.owner.post(url).send(heads(start)).expect(403);
    await w.student
      .post('/api/attempts/999999/submit')
      .send(heads(start))
      .expect(404);
  });

  test('400 on a wrong body', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/submit`;
    for (const bad of [
      {},
      { heads: [] },
      { heads: 'm1' },
      { heads: [{ node: 'm1' }] },
      { heads: [{ node: 'm1', branch_id: start.id, event_count: -1 }] },
      { heads: [{ node: 'm1', branch_id: 0, event_count: 1 }] },
      { ...heads(start), extra: 1 },
    ]) {
      await w.student.post(url).send(bad).expect(400);
    }
  });

  test('a submission is queued, keeps the digest of the journal and calls the verify queue', async () => {
    const { w, attempt, start } = await scene();
    t.clock.advance(1000);
    const res = await w.student
      .post(`/api/attempts/${attempt.id}/submit`)
      .send(heads(start, 4))
      .expect(201);
    const submission = res.body as SubmissionSummary;
    assert.equal(submission.verify_status, 'queued');
    assert.equal(submission.grade, null);
    assert.equal(submission.attempt_id, attempt.id);
    assert.equal(submission.created_at, t.clock.current);
    assert.deepEqual(queued, [submission.id]);
    const saved = t.db.get<{
      branch_id: number;
      event_count: number;
      digest: string;
    }>(
      'SELECT branch_id, event_count, digest FROM submission_journals WHERE submission_id = ?',
      submission.id,
    );
    assert.equal(saved?.branch_id, start.id);
    assert.equal(saved?.event_count, 4);
    const cut = (await journalOf(w.student, start.id, 4))
      .events as JournalEvent[];
    assert.equal(saved?.digest, journalCore().journal_digest({ events: cut }));
    const view = (
      await w.student.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as Attempt;
    assert.deepEqual(
      view.submissions.map((s) => s.id),
      [submission.id],
    );
  });

  test('a journal that does not end with a check is accepted; more submissions are allowed', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/submit`;
    const first = (await w.student.post(url).send(heads(start)).expect(201))
      .body as SubmissionSummary;
    const second = (await w.student.post(url).send(heads(start, 3)).expect(201))
      .body as SubmissionSummary;
    assert.notEqual(first.id, second.id);
    assert.deepEqual(queued, [first.id, second.id]);
  });

  test('the teachers are told, the student is not', async () => {
    const { w, attempt, start } = await scene();
    await w.student
      .post(`/api/attempts/${attempt.id}/submit`)
      .send(heads(start))
      .expect(201);
    assert.ok((await kinds(w.owner)).includes('submitted'));
    assert.ok((await kinds(w.assistant)).includes('submitted'));
    assert.ok(!(await kinds(w.student)).includes('submitted'));
  });

  test('a count above the saved one, a foreign branch or a wrong machine is 400', async () => {
    const { w, attempt, start } = await scene();
    const url = `/api/attempts/${attempt.id}/submit`;
    const tooMany = await w.student.post(url).send(heads(start, 7)).expect(400);
    assert.match(error(tooMany).message, /лише 6 подій/);
    const other = await openAttempt(w.classmate, w.assignment.id);
    const foreign = await startBranch(w.classmate, other.id);
    await w.student.post(url).send(heads(foreign, 0)).expect(400);
    await w.student
      .post(url)
      .send({ heads: [{ node: 'zzz', branch_id: start.id, event_count: 1 }] })
      .expect(400);
    assert.equal(
      t.db.all('SELECT id FROM submissions WHERE attempt_id = ?', attempt.id)
        .length,
      0,
    );
    assert.deepEqual(queued, []);
  });

  test('every machine of the topology must be named, once', async () => {
    const w = await world(t, { topology: PAIR });
    const attempt = await openAttempt(w.student, w.assignment.id);
    const m1 = await startBranch(w.student, attempt.id, 'm1');
    const m2 = await startBranch(w.student, attempt.id, 'm2', 'alpine');
    const url = `/api/attempts/${attempt.id}/submit`;
    const one = await w.student.post(url).send(heads(m1, 0)).expect(400);
    assert.match(error(one).message, /"m2"/);
    const twice = await w.student
      .post(url)
      .send({ heads: [...heads(m1, 0).heads, ...heads(m1, 0).heads] })
      .expect(400);
    assert.match(error(twice).message, /двічі/);
    await w.student
      .post(url)
      .send({
        heads: [
          ...heads(m1, 0).heads,
          { node: 'm2', branch_id: m1.id, event_count: 0 },
        ],
      })
      .expect(400);
    await w.student
      .post(url)
      .send({ heads: [...heads(m1, 0).heads, ...heads(m2, 0, 'm2').heads] })
      .expect(201);
  });

  test('a teacher trying the task submits without notifying anyone and stays out of the counts', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.assistant, w.assignment.id);
    const start = await startBranch(w.assistant, attempt.id);
    await putEvents(w.assistant, start.id, 0, evs(0, 2));
    await w.assistant
      .post(`/api/attempts/${attempt.id}/submit`)
      .send(heads(start, 2))
      .expect(201);
    assert.ok(!(await kinds(w.owner)).includes('submitted'));
    const detail = await tile(w.owner, w.assignment.id);
    assert.deepEqual(detail.counts, { stuck: 0, work: 0, done: 0, idle: 2 });
    assert.equal(detail.my_status, null);
    const klass = (await w.owner.get(`/api/classes/${w.classId}`).expect(200))
      .body as ClassDetail;
    assert.equal(klass.to_review, 0);
    assert.equal(
      (await tile(w.assistant, w.assignment.id)).my_attempt_id,
      null,
    );
  });
});

describe('tile status and counters', () => {
  test('idle, work, stuck, done follow the status rule', async () => {
    const w = await world(t);
    const counts = async () => (await tile(w.owner, w.assignment.id)).counts;
    assert.deepEqual(await counts(), { stuck: 0, work: 0, done: 0, idle: 2 });
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'idle');
    assert.equal((await tile(w.student, w.assignment.id)).my_attempt_id, null);
    const attempt = await openAttempt(w.student, w.assignment.id);
    assert.deepEqual(await counts(), { stuck: 0, work: 1, done: 0, idle: 1 });
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    assert.equal(
      (await tile(w.student, w.assignment.id)).my_attempt_id,
      attempt.id,
    );
    const help = await w.student
      .post(`/api/attempts/${attempt.id}/help`)
      .send({
        node: 'm1',
        branch_id: start.id,
        event_count: 3,
        text: 'Допоможіть',
      })
      .expect(201);
    assert.deepEqual(await counts(), { stuck: 1, work: 0, done: 0, idle: 1 });
    const submission = (
      await w.student
        .post(`/api/attempts/${attempt.id}/submit`)
        .send(heads(start, 3))
        .expect(201)
    ).body as SubmissionSummary;
    // A submission outranks the open request.
    assert.deepEqual(await counts(), { stuck: 0, work: 0, done: 1, idle: 1 });
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'done');
    await w.owner
      .post(`/api/help/${(help.body as { id: number }).id}/resolve`)
      .expect(200);
    assert.deepEqual(await counts(), { stuck: 0, work: 0, done: 1, idle: 1 });
    const classDetail = () =>
      w.owner
        .get(`/api/classes/${w.classId}`)
        .then((r) => r.body as ClassDetail);
    assert.equal((await classDetail()).to_review, 1);
    assert.equal((await classDetail()).open_help, 0);
    assert.equal((await classDetail()).assignments[0]?.counts.done, 1);
    // The latest submission decides: grading it clears the review mark and shows to the student.
    t.db.run('UPDATE submissions SET grade = 8 WHERE id = ?', submission.id);
    assert.equal((await classDetail()).to_review, 0);
    assert.equal((await tile(w.student, w.assignment.id)).my_grade, 8);
    assert.equal((await tile(w.classmate, w.assignment.id)).my_grade, null);
    const again = (
      await w.student
        .post(`/api/attempts/${attempt.id}/submit`)
        .send(heads(start, 3))
        .expect(201)
    ).body as SubmissionSummary;
    assert.equal((await classDetail()).to_review, 1);
    assert.equal((await tile(w.student, w.assignment.id)).my_grade, null);
    assert.ok(again.id > submission.id);
  });
});

describe('POST /api/attempts/:id/complete', () => {
  test('a task cannot be completed; 401, 404, 403', async () => {
    const { w, attempt } = await scene();
    const url = `/api/attempts/${attempt.id}/complete`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.classmate.post(url).expect(403);
    await w.owner.post(url).expect(403);
    const res = await w.student.post(url).expect(400);
    assert.match(error(res).message, /урок/);
  });

  test('finishing a lesson makes the tile done and keeps the first time', async () => {
    const w = await world(t, { kind: 'lesson' });
    const attempt = await openAttempt(w.student, w.assignment.id);
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'work');
    const url = `/api/attempts/${attempt.id}/complete`;
    t.clock.advance(1000);
    const done = (await w.student.post(url).expect(200)).body as Attempt;
    assert.equal(done.completed_at, t.clock.current);
    assert.equal((await tile(w.student, w.assignment.id)).my_status, 'done');
    assert.equal((await tile(w.owner, w.assignment.id)).counts.done, 1);
    t.clock.advance(1000);
    const again = (await w.student.post(url).expect(200)).body as Attempt;
    assert.equal(again.completed_at, done.completed_at);
  });
});

describe('lesson-from-submission and clip with the real assembler', () => {
  async function submitted(): Promise<{
    s: Scene;
    submission: SubmissionSummary;
  }> {
    const s = await scene(10);
    const rollback = await forkBranch(s.w.student, s.attempt.id, {
      branch_id: s.start.id,
      event: 4,
    });
    await putEvents(s.w.student, rollback.id, 4, evs(4, 7, 'r'));
    const submission = (
      await s.w.student
        .post(`/api/attempts/${s.attempt.id}/submit`)
        .send({
          heads: [{ node: 'm1', branch_id: rollback.id, event_count: 7 }],
        })
        .expect(201)
    ).body as SubmissionSummary;
    return { s: { ...s, start: rollback }, submission };
  }

  test('a lesson is made from the submitted branch and carries no lesson marks', async () => {
    const { s, submission } = await submitted();
    const res = await s.w.owner
      .post('/api/library/lesson-from-submission')
      .send({ submission_id: submission.id, node: 'm1' })
      .expect(201);
    const lesson = res.body as Item;
    assert.equal(lesson.kind, 'lesson');
    const journal = (
      await s.w.owner
        .get(`/api/library/${lesson.id}/journals/m1?role=start`)
        .expect(200)
    ).body as Journal;
    assert.deepEqual(tags(journal.events), [
      'e0',
      'e1',
      'e2',
      'e3',
      'r4',
      'r5',
      'r6',
    ]);
    assert.equal('lesson' in journal.header, false);
    assert.deepEqual(journal.header, HEADER);
  });

  test('a clip is cut from a branch at the given event', async () => {
    const { s } = await submitted();
    const res = await s.w.assistant
      .post('/api/library/clip')
      .send({
        branch_id: s.start.id,
        to_event: 5,
        from_ms: 100,
        title: 'Відкат',
      })
      .expect(201);
    const clip = res.body as Item;
    assert.equal(clip.kind, 'clip');
    assert.equal(clip.clip_from_ms, 100);
    const journal = (
      await s.w.assistant
        .get(`/api/library/${clip.id}/journals/m1?role=start`)
        .expect(200)
    ).body as Journal;
    assert.deepEqual(tags(journal.events), ['e0', 'e1', 'e2', 'e3', 'r4']);
  });
});

describe('a real journal survives the chunks', () => {
  for (const [file, profile] of [
    ['buildroot-1.json', 'buildroot'],
    ['alpine-1.json', 'alpine'],
  ] as const) {
    test(`${file} in chunks of 7 events assembles to the same events`, async () => {
      const original = JSON.parse(
        readFileSync(
          join(repoRoot(), 'server', 'test', 'journals-fixtures', file),
          'utf8',
        ),
      ) as Journal;
      const w = await world(t, {
        topology: {
          format: 'v86-topology/1',
          machines: [{ id: 'm1', profile }],
          switches: [],
          links: [],
        },
      });
      const attempt = await openAttempt(w.student, w.assignment.id);
      const branch = (
        await w.student
          .post(`/api/attempts/${attempt.id}/branches`)
          .send({
            node: 'm1',
            parent: null,
            kind: 'start',
            header: original.header,
            make_head: true,
          })
          .expect(201)
      ).body as Branch;
      const step = 7;
      for (let from = 0; from < original.events.length; from += step) {
        const count = await putEvents(
          w.student,
          branch.id,
          from,
          original.events.slice(from, from + step),
        );
        assert.equal(count, Math.min(from + step, original.events.length));
      }
      const back = await journalOf(w.owner, branch.id);
      assert.deepEqual(back.events, original.events);
      assert.deepEqual(back.header, original.header);
      const cut = await journalOf(w.owner, branch.id, 100);
      assert.deepEqual(cut.events, original.events.slice(0, 100));
      const submission = (
        await w.student
          .post(`/api/attempts/${attempt.id}/submit`)
          .send(heads(branch, original.events.length))
          .expect(201)
      ).body as SubmissionSummary;
      const digest = t.db.get<{ digest: string }>(
        'SELECT digest FROM submission_journals WHERE submission_id = ?',
        submission.id,
      );
      assert.equal(digest?.digest, journalCore().journal_digest(original));
      journalCore().check_journal_strict(back);
    });
  }
});

describe('a frozen assignment', () => {
  const FROZEN_TEXT = 'Викладач заморозив завдання';
  const setFrozen = (id: number, frozen: boolean): void =>
    t.app.get(AssignmentsService).setFrozen(id, frozen);

  test('rejects a submission and a new student branch with 409, still takes chunks, submits after unfreezing', async () => {
    const { w, attempt, start } = await scene();
    const id = w.assignment.id;
    const submitUrl = `/api/attempts/${attempt.id}/submit`;
    const branchUrl = `/api/attempts/${attempt.id}/branches`;
    setFrozen(id, true);

    const refused = await w.student
      .post(submitUrl)
      .send(heads(start))
      .expect(409);
    assert.equal(error(refused).message, FROZEN_TEXT);
    const noBranch = await w.student
      .post(branchUrl)
      .send({
        node: 'm1',
        parent: { branch_id: start.id, event: 3 },
        kind: 'rollback',
        header: HEADER,
        make_head: true,
      })
      .expect(409);
    assert.equal(error(noBranch).message, FROZEN_TEXT);
    assert.deepEqual(queued, []);

    await putEvents(w.student, start.id, 6, evs(6, 8));
    // A teacher is not stopped: a reply branch is created.
    await forkBranch(
      w.owner,
      attempt.id,
      { branch_id: start.id, event: 3 },
      'reply',
    );

    setFrozen(id, false);
    await w.student.post(submitUrl).send(heads(start, 8)).expect(201);
    assert.equal(queued.length, 1);
  });
});
