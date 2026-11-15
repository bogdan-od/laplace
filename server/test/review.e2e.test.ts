import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type {
  Analytics,
  Attempt,
  Branch,
  Comment,
  NotificationList,
  ReviewItem,
  SearchResult,
  StudentProgress,
  Submission,
  SubmissionSummary,
} from '@shared/api';
import { MAX_TEXT_CHARS } from '@shared/limits';
import { ActivityService } from '../src/activity/activity.service';
import { RunnerBus } from '../src/runner/runner-bus';
import type { SubmissionStatusEvent } from '../src/runner/runner-bus';
import { VerifyRunner } from '../src/runner/verify-runner';
import {
  evs,
  forkBranch,
  openAttempt,
  putEvents,
  startBranch,
  tags,
  world,
  World,
  WorldOptions,
} from './attempt-fixtures';
import { createItem, putJournal, journalText } from './fixtures';
import {
  Client,
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

interface Made {
  w: World;
  attempt: Attempt;
  start: Branch;
  submission: SubmissionSummary;
}

/** A world where the student has submitted `count` events of machine m1. */
async function made(options: WorldOptions = {}, count = 6): Promise<Made> {
  const w = await world(t, options);
  const attempt = await openAttempt(w.student, w.assignment.id);
  const start = await startBranch(w.student, attempt.id);
  await putEvents(w.student, start.id, 0, evs(0, count));
  const submission = await submit(w.student, attempt.id, start.id, count);
  return { w, attempt, start, submission };
}

async function submit(
  client: Client,
  attemptId: number,
  branchId: number,
  count: number,
): Promise<SubmissionSummary> {
  const res = await client
    .post(`/api/attempts/${attemptId}/submit`)
    .send({ heads: [{ node: 'm1', branch_id: branchId, event_count: count }] })
    .expect(201);
  return res.body as SubmissionSummary;
}

const notifications = async (client: Client): Promise<NotificationList> =>
  (await client.get('/api/notifications').expect(200)).body as NotificationList;

const fetchSubmission = async (
  client: Client,
  id: number,
): Promise<Submission> =>
  (await client.get(`/api/submissions/${id}`).expect(200)).body as Submission;

describe('GET /api/review', () => {
  test('401 without login', async () => {
    await t.client().get('/api/review').expect(401);
  });

  test('a student and a teacher of another class see nothing of this one', async () => {
    const { w } = await made();
    assert.deepEqual((await w.student.get('/api/review').expect(200)).body, []);
    const items = (await w.stranger.get('/api/review').expect(200))
      .body as ReviewItem[];
    assert.deepEqual(items, []);
  });

  test('lists ungraded submissions and open help, newest first; graded ones leave', async () => {
    const { w, attempt, start, submission } = await made();
    t.clock.advance(5000);
    const second = await world(t);
    const other = await openAttempt(second.student, second.assignment.id);
    const otherStart = await startBranch(second.student, other.id);
    await putEvents(second.student, otherStart.id, 0, evs(0, 3));
    await second.student
      .post(`/api/attempts/${other.id}/help`)
      .send({
        node: 'm1',
        branch_id: otherStart.id,
        event_count: 3,
        text: 'Не працює',
      })
      .expect(201);
    const mine = (await w.owner.get('/api/review').expect(200))
      .body as ReviewItem[];
    const submissions = mine.filter((item) => item.kind === 'submission');
    assert.equal(submissions.length, 1);
    assert.equal(
      submissions[0]?.kind === 'submission' && submissions[0].submission.id,
      submission.id,
    );
    assert.equal(
      submissions[0]?.kind === 'submission' && submissions[0].student.name,
      'Студент',
    );
    const theirs = (await second.owner.get('/api/review').expect(200))
      .body as ReviewItem[];
    assert.deepEqual(
      theirs.map((item) => item.kind),
      ['help'],
    );
    await w.owner
      .put(`/api/submissions/${submission.id}/grade`)
      .send({ grade: 7 })
      .expect(200);
    const after = (await w.owner.get('/api/review').expect(200))
      .body as ReviewItem[];
    assert.equal(
      after.some((item) => item.kind === 'submission'),
      false,
    );
    void attempt;
    void start;
  });

  test('a resubmitted attempt appears once, with its latest submission', async () => {
    const { w, attempt, start } = await made();
    t.clock.advance(1000);
    await putEvents(w.student, start.id, 6, evs(6, 8));
    const latest = await submit(w.student, attempt.id, start.id, 8);
    const items = (await w.owner.get('/api/review').expect(200))
      .body as ReviewItem[];
    const rows = items.filter((item) => item.kind === 'submission');
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.kind === 'submission' && rows[0].submission.id,
      latest.id,
    );
  });

  test('a teacher trial attempt is not in the inbox', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.owner, w.assignment.id);
    const start = await startBranch(w.owner, attempt.id);
    await putEvents(w.owner, start.id, 0, evs(0, 2));
    await submit(w.owner, attempt.id, start.id, 2);
    const items = (await w.owner.get('/api/review').expect(200))
      .body as ReviewItem[];
    assert.deepEqual(items, []);
  });
  test('checks: null without a finished check run, then the result of the latest finished one; hidden from the author', async () => {
    const { w, attempt, submission } = await made();
    const owner = (await w.owner.get('/api/me').expect(200)).body as {
      id: number;
    };
    const checksOf = async (client: Client): Promise<unknown> =>
      ((await client.get('/api/review').expect(200)).body as ReviewItem[])
        .map((item) =>
          item.kind === 'submission' ? item.submission.checks : 'help',
        )
        .at(0);
    const run = (status: string, rcs: (number | null)[]): void => {
      const results = rcs.map((rc) => ({
        node: 'm1',
        title: 't',
        command: 'c',
        rc,
        output: '',
      }));
      t.db.run(
        `INSERT INTO check_runs (submission_id, started_by, status, results, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        submission.id,
        owner.id,
        status,
        JSON.stringify(results),
        t.clock.now(),
      );
    };
    assert.equal(await checksOf(w.owner), null);
    run('running', [0]);
    assert.equal(await checksOf(w.owner), null);
    run('done', [0, 1, 1]);
    assert.deepEqual(await checksOf(w.owner), { passed: 1, total: 3 });
    run('failed', [0, 0, 0]);
    assert.deepEqual(await checksOf(w.owner), { passed: 1, total: 3 });
    run('done', [0, 0, null]);
    assert.deepEqual(await checksOf(w.owner), { passed: 2, total: 3 });
    const detail = await fetchSubmission(w.owner, submission.id);
    assert.deepEqual(detail.checks, { passed: 2, total: 3 });
    const attemptView = (
      await w.owner.get(`/api/attempts/${attempt.id}`).expect(200)
    ).body as { submissions: SubmissionSummary[] };
    assert.deepEqual(attemptView.submissions[0]?.checks, {
      passed: 2,
      total: 3,
    });
    assert.equal(
      (await fetchSubmission(w.student, submission.id)).checks,
      null,
    );
    const own = (await w.student.get(`/api/attempts/${attempt.id}`).expect(200))
      .body as { submissions: SubmissionSummary[] };
    assert.equal(own.submissions[0]?.checks, null);
  });
});

describe('GET /api/submissions/:id', () => {
  test('401, 404 for outsiders and unknown ids, 403 for a classmate', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.classmate.get(url).expect(403);
    await w.owner.get('/api/submissions/99999').expect(404);
    await w.owner.get('/api/submissions/abc').expect(404);
  });

  test('the teacher gets everything, the author gets no teacher_inputs and no check_runs', async () => {
    const { w, attempt, submission } = await made();
    const author = (await w.student.get('/api/me').expect(200)).body as {
      id: number;
    };
    const owner = (await w.owner.get('/api/me').expect(200)).body as {
      id: number;
    };
    t.db.run(
      `INSERT INTO teacher_inputs (assignment_id, student_id, node_id, port, data, author_id, received_at)
       VALUES (?, ?, 'm1', 0, 'ls\n', ?, ?)`,
      w.assignment.id,
      author.id,
      owner.id,
      t.clock.now(),
    );
    t.db.run(
      `INSERT INTO check_runs (submission_id, started_by, status, results, created_at)
       VALUES (?, ?, 'done', '[{"node":"m1","title":"t","command":"c","rc":0,"output":"ok"}]', ?)`,
      submission.id,
      owner.id,
      t.clock.now(),
    );
    const seen = await fetchSubmission(w.owner, submission.id);
    assert.equal(seen.attempt_id, attempt.id);
    assert.equal(seen.student.name, 'Студент');
    assert.equal(seen.assignment.max_grade, 10);
    assert.equal(seen.assignment.class_id, w.classId);
    assert.equal(seen.journals[0]?.event_count, 6);
    assert.equal(seen.teacher_inputs.length, 1);
    assert.equal(seen.teacher_inputs[0]?.author.name, 'Власник');
    assert.equal(seen.teacher_inputs[0]?.data, 'ls\n');
    assert.equal(seen.check_runs.length, 1);
    assert.equal(seen.check_runs[0]?.results[0]?.output, 'ok');
    const assistant = await fetchSubmission(w.assistant, submission.id);
    assert.equal(assistant.check_runs.length, 1);
    const own = await fetchSubmission(w.student, submission.id);
    assert.deepEqual(own.teacher_inputs, []);
    assert.deepEqual(own.check_runs, []);
    assert.equal(own.growth.length, 1);
  });

  test('suggested_grade is the maximum minus the penalties of the opened hints, at least 0', async () => {
    const hints = [
      { text: 'Перша', penalty: 2 },
      { text: 'Друга', penalty: 3 },
      { text: 'Третя', penalty: 9 },
    ];
    const { w, attempt, start, submission } = await made({ hints });
    const first = await fetchSubmission(w.owner, submission.id);
    assert.equal(first.suggested_grade, 10);
    assert.deepEqual(first.hints_used, []);
    t.clock.advance(1000);
    for (const index of [0, 1]) {
      await w.student
        .post(`/api/attempts/${attempt.id}/hints/${index}`)
        .expect(200);
    }
    t.clock.advance(1000);
    const second = await submit(w.student, attempt.id, start.id, 6);
    const seen = await fetchSubmission(w.owner, second.id);
    assert.equal(seen.suggested_grade, 5);
    assert.deepEqual(seen.hints_used, [
      { index: 0, penalty: 2 },
      { index: 1, penalty: 3 },
    ]);
    // The first submission was made before any hint was opened.
    assert.equal(
      (await fetchSubmission(w.owner, submission.id)).suggested_grade,
      10,
    );
    await w.student.post(`/api/attempts/${attempt.id}/hints/2`).expect(200);
    t.clock.advance(1000);
    const third = await submit(w.student, attempt.id, start.id, 6);
    assert.equal((await fetchSubmission(w.owner, third.id)).suggested_grade, 0);
  });

  test('growth holds the chunks up to the submitted event count, ancestors included', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 5));
    const firstAt = t.clock.now();
    t.clock.advance(60_000);
    await putEvents(w.student, start.id, 5, evs(5, 10));
    // Back to event 7 and on with three events of the new branch.
    const rollback = await forkBranch(w.student, attempt.id, {
      branch_id: start.id,
      event: 7,
    });
    t.clock.advance(60_000);
    await putEvents(w.student, rollback.id, 7, evs(7, 10, 'r'));
    const submitted = await submit(w.student, attempt.id, rollback.id, 9);
    const seen = await fetchSubmission(w.owner, submitted.id);
    const chunks = seen.growth[0]?.chunks ?? [];
    assert.deepEqual(
      chunks.map((c) => [c.first_event, c.event_count]),
      [
        [0, 5],
        [5, 2],
        [7, 2],
      ],
    );
    assert.equal(chunks[0]?.received_at, firstAt);
    assert.equal(chunks[1]?.received_at, firstAt + 60_000);
    assert.equal(chunks[2]?.received_at, firstAt + 120_000);
    const ends = chunks.map((c) => c.first_event + c.event_count);
    assert.ok(Math.max(...ends) <= 9);
    // The cut chunks keep their proportional share of bytes.
    const stored = (
      await w.student.get(`/api/branches/${start.id}/chunks`).expect(200)
    ).body as { bytes: number; event_count: number }[];
    assert.equal(
      chunks[1]?.bytes,
      Math.round(((stored[1]?.bytes ?? 0) * 2) / (stored[1]?.event_count ?? 1)),
    );
  });

  test('a deleted assignment hides its submissions', async () => {
    const { w, submission } = await made();
    await w.owner.delete(`/api/assignments/${w.assignment.id}`).expect(200);
    await w.owner.get(`/api/submissions/${submission.id}`).expect(404);
  });
});

describe('GET /api/submissions/:id/journals/:node', () => {
  test('the journal is cut to the submitted event count', async () => {
    const { w, attempt, start } = await made();
    const cut = await submit(w.student, attempt.id, start.id, 4);
    t.clock.advance(1);
    await putEvents(w.student, start.id, 6, evs(6, 9));
    const url = `/api/submissions/${cut.id}/journals/m1`;
    for (const client of [w.owner, w.assistant, w.student]) {
      const journal = (await client.get(url).expect(200)).body as {
        events: unknown[];
      };
      assert.deepEqual(tags(journal.events), ['e0', 'e1', 'e2', 'e3']);
    }
  });

  test('401, 404, 403 and an unknown machine', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/journals/m1`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.classmate.get(url).expect(403);
    await w.owner
      .get(`/api/submissions/${submission.id}/journals/zz`)
      .expect(404);
    await w.owner.get('/api/submissions/99999/journals/m1').expect(404);
  });
});

describe('PUT /api/submissions/:id/grade', () => {
  test('401, 404, 403', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/grade`;
    await t.client().put(url).send({ grade: 5 }).expect(401);
    await w.outsider.put(url).send({ grade: 5 }).expect(404);
    await w.stranger.put(url).send({ grade: 5 }).expect(404);
    await w.owner
      .put('/api/submissions/99999/grade')
      .send({ grade: 5 })
      .expect(404);
    await w.student.put(url).send({ grade: 5 }).expect(403);
    await w.classmate.put(url).send({ grade: 5 }).expect(403);
    assert.equal((await fetchSubmission(w.owner, submission.id)).grade, null);
  });

  test('400 for a grade above the maximum, a fractional one and a wrong body', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/grade`;
    const bad: unknown[] = [
      { grade: 11 },
      { grade: 5.5 },
      { grade: -1 },
      { grade: '5' },
      { grade: null },
      {},
      { grade: 5, note: 7 },
      { grade: 5, note: 'я'.repeat(MAX_TEXT_CHARS + 1) },
      { grade: 5, extra: 1 },
    ];
    for (const payload of bad) {
      await w.owner
        .put(url)
        .send(payload as object)
        .expect(400);
    }
    assert.equal((await fetchSubmission(w.owner, submission.id)).grade, null);
  });

  test('a teacher grades; the maximum and 0 are valid; the note stays when omitted', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/grade`;
    t.clock.advance(1000);
    const graded = (
      await w.assistant
        .put(url)
        .send({ grade: 10, note: 'Молодець' })
        .expect(200)
    ).body as Submission;
    assert.equal(graded.grade, 10);
    assert.equal(graded.note, 'Молодець');
    assert.equal(graded.graded_by?.name, 'Асистент');
    assert.equal(graded.graded_at, t.clock.now());
    const again = (await w.owner.put(url).send({ grade: 0 }).expect(200))
      .body as Submission;
    assert.equal(again.grade, 0);
    assert.equal(again.note, 'Молодець');
    assert.equal(again.graded_by?.name, 'Власник');
    const own = await fetchSubmission(w.student, submission.id);
    assert.equal(own.grade, 0);
    assert.equal(own.note, 'Молодець');
  });

  test('the student is notified about a change, once per change', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/grade`;
    await w.owner.put(url).send({ grade: 8 }).expect(200);
    await w.owner.put(url).send({ grade: 8 }).expect(200);
    const kinds = (await notifications(w.student)).items.map((i) => i.kind);
    assert.equal(kinds.filter((kind) => kind === 'graded').length, 1);
    await w.owner.put(url).send({ grade: 9 }).expect(200);
    const after = (await notifications(w.student)).items;
    assert.equal(after.filter((item) => item.kind === 'graded').length, 2);
    const graded = after.find((item) => item.kind === 'graded');
    assert.equal(graded?.ref_id, submission.id);
    assert.equal(graded?.student?.name, 'Студент');
    assert.equal(
      (await notifications(w.classmate)).items.some((i) => i.kind === 'graded'),
      false,
    );
    assert.equal(
      (await notifications(w.assistant)).items.some((i) => i.kind === 'graded'),
      false,
    );
  });
});

describe('comments', () => {
  const comment = {
    node: 'm1',
    event_index: 3,
    vtime_ms: 1234.5,
    text: 'Тут помилка',
  };

  test('POST: 401, 404, 403', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/comments`;
    await t.client().post(url).send(comment).expect(401);
    await w.outsider.post(url).send(comment).expect(404);
    await w.stranger.post(url).send(comment).expect(404);
    await w.owner
      .post('/api/submissions/99999/comments')
      .send(comment)
      .expect(404);
    await w.student.post(url).send(comment).expect(403);
    await w.classmate.post(url).send(comment).expect(403);
  });

  test('POST: 400 for a wrong body, an unknown machine and an event beyond the journal', async () => {
    const { w, submission } = await made(); // 6 events submitted
    const url = `/api/submissions/${submission.id}/comments`;
    const bad: object[] = [
      { ...comment, event_index: 7 },
      { ...comment, node: 'zz' },
      { ...comment, event_index: -1 },
      { ...comment, event_index: 1.5 },
      { ...comment, vtime_ms: -1 },
      { ...comment, text: '' },
      { ...comment, text: '   ' },
      { ...comment, text: 'я'.repeat(MAX_TEXT_CHARS + 1) },
      { node: 'm1', event_index: 1, text: 'без часу' },
      {},
    ];
    for (const payload of bad)
      await w.owner.post(url).send(payload).expect(400);
    assert.deepEqual(
      (await fetchSubmission(w.owner, submission.id)).comments,
      [],
    );
  });

  test('POST: the comment may sit on the last event; the student sees it and is notified', async () => {
    const { w, submission } = await made();
    const url = `/api/submissions/${submission.id}/comments`;
    const edge = (
      await w.owner
        .post(url)
        .send({ ...comment, event_index: 6 })
        .expect(201)
    ).body as Comment;
    assert.equal(edge.event_index, 6);
    const created = (
      await w.assistant
        .post(url)
        .send({ ...comment, text: '  Ще раз  ' })
        .expect(201)
    ).body as Comment;
    assert.equal(created.text, 'Ще раз');
    assert.equal(created.author.name, 'Асистент');
    assert.equal(created.vtime_ms, 1234.5);
    assert.equal(created.submission_id, submission.id);
    const own = await fetchSubmission(w.student, submission.id);
    assert.deepEqual(
      own.comments.map((c) => c.id),
      [edge.id, created.id],
    );
    const note = (await notifications(w.student)).items.find(
      (item) => item.kind === 'commented',
    );
    assert.ok(note);
    assert.equal(note.student?.name, 'Студент');
    assert.equal(
      (await notifications(w.classmate)).items.some(
        (i) => i.kind === 'commented',
      ),
      false,
    );
  });

  test('DELETE: 401, 404, 403 and the author or the owner may delete', async () => {
    const { w, submission } = await made();
    const post = async (client: Client): Promise<Comment> =>
      (
        await client
          .post(`/api/submissions/${submission.id}/comments`)
          .send(comment)
          .expect(201)
      ).body as Comment;
    const byAssistant = await post(w.assistant);
    const byOwner = await post(w.owner);
    const url = (c: Comment): string => `/api/comments/${c.id}`;
    await t.client().delete(url(byAssistant)).expect(401);
    await w.outsider.delete(url(byAssistant)).expect(404);
    await w.stranger.delete(url(byAssistant)).expect(404);
    await w.owner.delete('/api/comments/99999').expect(404);
    await w.owner.delete('/api/comments/abc').expect(404);
    await w.student.delete(url(byAssistant)).expect(403);
    await w.classmate.delete(url(byAssistant)).expect(403);
    await w.assistant.delete(url(byOwner)).expect(403);
    await w.assistant.delete(url(byAssistant)).expect(200);
    await w.assistant.delete(url(byAssistant)).expect(404);
    await w.owner.delete(url(byOwner)).expect(200);
    assert.deepEqual(
      (await fetchSubmission(w.owner, submission.id)).comments,
      [],
    );
  });

  test('DELETE: the owner of the class deletes a comment of an assistant', async () => {
    const { w, submission } = await made();
    const created = (
      await w.assistant
        .post(`/api/submissions/${submission.id}/comments`)
        .send(comment)
        .expect(201)
    ).body as Comment;
    await w.owner.delete(`/api/comments/${created.id}`).expect(200);
    assert.deepEqual(
      (await fetchSubmission(w.student, submission.id)).comments,
      [],
    );
  });
});

/** Moves the dates of an attempt and its first submission, to get exact minutes. */
function setTimes(
  attemptId: number,
  openedAt: number,
  submittedAfterMinutes: number,
): void {
  t.db.run(
    'UPDATE attempts SET created_at = ? WHERE id = ?',
    openedAt,
    attemptId,
  );
  t.db.run(
    'UPDATE submissions SET created_at = ? WHERE attempt_id = ?',
    openedAt + submittedAfterMinutes * 60_000,
    attemptId,
  );
}

describe('assignment reports', () => {
  /** A class with `minutes.length` students who submitted after the given numbers of minutes. */
  async function classWith(
    minutes: number[],
  ): Promise<{ w: World; clients: Client[] }> {
    const w = await world(t);
    const code = (await w.owner.get(`/api/classes/${w.classId}`).expect(200))
      .body as { invite_code: string };
    const clients: Client[] = [w.student, w.classmate];
    while (clients.length < minutes.length) {
      clients.push(
        await studentClient(t, code.invite_code, `Учень ${clients.length + 1}`),
      );
    }
    for (const [i, client] of clients.slice(0, minutes.length).entries()) {
      const attempt = await openAttempt(client, w.assignment.id);
      const start = await startBranch(client, attempt.id);
      await putEvents(client, start.id, 0, evs(0, 2));
      await submit(client, attempt.id, start.id, 2);
      setTimes(attempt.id, 1_000_000, minutes[i] ?? 0);
    }
    return { w, clients };
  }

  test('students: 401, 404, 403; the tiles go by student number and skip trial attempts', async () => {
    const { w } = await classWith([4]);
    const trial = await openAttempt(w.owner, w.assignment.id);
    void trial;
    const url = `/api/assignments/${w.assignment.id}/students`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.owner.get('/api/assignments/99999/students').expect(404);
    await w.student.get(url).expect(403);
    const tiles = (await w.assistant.get(url).expect(200))
      .body as StudentProgress[];
    assert.deepEqual(
      tiles.map((tile) => [tile.name, tile.status, tile.number]),
      [
        ['Студент', 'done', 1],
        ['Однокласник', 'idle', 2],
      ],
    );
  });

  test('analytics: 401, 404, 403', async () => {
    const { w } = await classWith([4]);
    const url = `/api/assignments/${w.assignment.id}/analytics`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.owner.get('/api/assignments/99999/analytics').expect(404);
    await w.student.get(url).expect(403);
    await w.classmate.get(url).expect(403);
  });

  test('analytics: the median of an odd number of students', async () => {
    const { w, clients } = await classWith([30, 10, 20]);
    assert.equal(clients.length, 3);
    const report = await analytics(w);
    assert.equal(report.students, 3);
    assert.equal(report.opened, 3);
    assert.equal(report.submitted, 3);
    assert.deepEqual(report.minutes_to_submit, {
      median: 20,
      min: 10,
      max: 30,
    });
  });

  test('analytics: the median of an even number of students is the mean of the middle two', async () => {
    const { w } = await classWith([10, 40, 20, 30]);
    const report = await analytics(w);
    assert.deepEqual(report.minutes_to_submit, {
      median: 25,
      min: 10,
      max: 40,
    });
    assert.deepEqual(
      report.per_student.map((row) => row.minutes_to_submit),
      [10, 40, 20, 30],
    );
  });

  test('analytics: an empty class has no median, students without work count in students only', async () => {
    const w = await world(t);
    const report = await analytics(w);
    assert.equal(report.students, 2);
    assert.equal(report.opened, 0);
    assert.equal(report.submitted, 0);
    assert.deepEqual(report.minutes_to_submit, {
      median: null,
      min: null,
      max: null,
    });
    assert.deepEqual(report.grades, []);
    assert.equal(report.per_student[0]?.grade, null);
  });

  test('analytics ignores trial attempts of teachers', async () => {
    const { w } = await classWith([10]);
    const trial = await openAttempt(w.owner, w.assignment.id);
    const start = await startBranch(w.owner, trial.id);
    await putEvents(w.owner, start.id, 0, evs(0, 2));
    await submit(w.owner, trial.id, start.id, 2);
    setTimes(trial.id, 1_000_000, 1);
    const report = await analytics(w);
    assert.equal(report.students, 2);
    assert.equal(report.opened, 1);
    assert.equal(report.submitted, 1);
    assert.deepEqual(report.minutes_to_submit, {
      median: 10,
      min: 10,
      max: 10,
    });
    assert.equal(
      report.per_student.some((row) => row.name === 'Власник'),
      false,
    );
  });

  test('analytics: commands, rollbacks, help, hints and the grade distribution', async () => {
    const { w } = await classWith([5, 15]);
    const attemptOf = (name: string): number =>
      t.db.get<{ id: number }>(
        `SELECT t.id FROM attempts t JOIN users u ON u.id = t.user_id
         WHERE t.assignment_id = ? AND u.name = ?`,
        w.assignment.id,
        name,
      )?.id ?? 0;
    const first = attemptOf('Студент');
    const start = t.db.get<{ id: number }>(
      'SELECT id FROM branches WHERE attempt_id = ?',
      first,
    );
    await forkBranch(w.student, first, { branch_id: start?.id ?? 0, event: 1 });
    await w.student
      .post(`/api/attempts/${first}/help`)
      .send({
        node: 'm1',
        branch_id: start?.id ?? 0,
        event_count: 2,
        text: 'Допоможіть',
      })
      .expect(201);
    t.db.run(
      'UPDATE submissions SET commands_count = 12 WHERE attempt_id = ?',
      first,
    );
    const submissionIds = t.db
      .all<{ id: number }>(
        'SELECT id FROM submissions ORDER BY id DESC LIMIT 2',
      )
      .map((row) => row.id);
    for (const [i, id] of submissionIds.entries()) {
      await w.owner
        .put(`/api/submissions/${id}/grade`)
        .send({ grade: i === 0 ? 9 : 7 })
        .expect(200);
    }
    const report = await analytics(w);
    const mine = report.per_student.find((row) => row.name === 'Студент');
    assert.equal(mine?.commands, 12);
    assert.equal(mine?.rollbacks, 1);
    assert.equal(mine?.help_requests, 1);
    assert.equal(mine?.hints_used, 0);
    assert.deepEqual(report.grades, [
      { grade: 7, count: 1 },
      { grade: 9, count: 1 },
    ]);
    const other = report.per_student.find((row) => row.name === 'Однокласник');
    assert.equal(other?.commands, null);
  });

  async function analytics(w: World): Promise<Analytics> {
    return (
      await w.owner
        .get(`/api/assignments/${w.assignment.id}/analytics`)
        .expect(200)
    ).body as Analytics;
  }
});

describe('GET /api/classes/:id/activity', () => {
  test('401, 404, 403', async () => {
    const { w } = await made();
    const url = `/api/classes/${w.classId}/activity`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.owner.get('/api/classes/99999/activity').expect(404);
    await w.student.get(url).expect(403);
  });

  test('400 for a wrong before', async () => {
    const { w } = await made();
    for (const before of ['abc', '0', '-3', '1.5']) {
      await w.owner
        .get(`/api/classes/${w.classId}/activity?before=${before}`)
        .expect(400);
    }
  });

  test('lists every kind of event, newest first, a page at a time', async () => {
    const { w, submission } = await made();
    await w.owner
      .put(`/api/submissions/${submission.id}/grade`)
      .send({ grade: 5 })
      .expect(200);
    const list = async (query = ''): Promise<{ id: number; kind: string }[]> =>
      (
        await w.assistant
          .get(`/api/classes/${w.classId}/activity${query}`)
          .expect(200)
      ).body as { id: number; kind: string }[];
    const all = await list();
    const kinds = all.map((item) => item.kind);
    assert.ok(kinds.includes('attempt_opened'));
    assert.ok(kinds.includes('submitted'));
    assert.equal(kinds[0], 'graded');
    assert.deepEqual(
      all.map((item) => item.id),
      [...all.map((item) => item.id)].sort((a, b) => b - a),
    );
    const older = await list(`?before=${all[1]?.id}`);
    assert.deepEqual(
      older.map((item) => item.id),
      all.slice(2).map((item) => item.id),
    );
  });

  test('a page holds 50 entries', async () => {
    const w = await world(t);
    t.db.tx(() => {
      for (let i = 0; i < 60; i++) {
        t.db.run(
          `INSERT INTO activity (class_id, actor_id, kind, at) VALUES (?, ?, 'attempt_opened', ?)`,
          w.classId,
          1,
          i,
        );
      }
    });
    const page = (
      await w.owner.get(`/api/classes/${w.classId}/activity`).expect(200)
    ).body as unknown[];
    assert.equal(page.length, 50);
  });
});

describe('GET /api/classes/:id/grades.csv', () => {
  test('401, 404, 403', async () => {
    const { w } = await made();
    const url = `/api/classes/${w.classId}/grades.csv`;
    await t.client().get(url).expect(401);
    await w.outsider.get(url).expect(404);
    await w.stranger.get(url).expect(404);
    await w.owner.get('/api/classes/99999/grades.csv').expect(404);
    await w.student.get(url).expect(403);
  });

  test('BOM, semicolons, one row per student, an empty cell without a grade, escaped names', async () => {
    const owner = await teacherClient(t, 'Вчитель CSV');
    const { id: classId, code } = await createClass(owner, '8-В');
    await studentClient(t, code, 'Щербак Олена');
    await studentClient(t, code, 'Іваненко; "Іван"');
    const item = await createItem(owner, { title: 'Мережа; "VLAN"' });
    await putJournal(owner, item.id, journalText());
    const second = await createItem(owner, { title: 'Друге' });
    await putJournal(owner, second.id, journalText());
    const assign = async (id: number): Promise<number> =>
      (
        await owner
          .post(`/api/library/${id}/assign`)
          .send({
            class_id: classId,
            due_at: null,
            max_grade: 10,
            shared_lan: false,
          })
          .expect(201)
      ).body.id as number;
    const a1 = await assign(item.id);
    await assign(second.id);
    const students = t.db.all<{ user_id: number; name: string }>(
      `SELECT m.user_id, u.name FROM class_members m JOIN users u ON u.id = m.user_id
       WHERE m.class_id = ? AND m.role = 'student' ORDER BY m.number`,
      classId,
    );
    const attempts: number[] = [];
    for (const student of students) {
      const { id } = t.db.run(
        `INSERT INTO attempts (assignment_id, user_id, variant, created_at) VALUES (?, ?, 1, 1)`,
        a1,
        student.user_id,
      );
      attempts.push(id);
    }
    t.db.run(
      'INSERT INTO submissions (attempt_id, created_at, grade) VALUES (?, 2, 9)',
      attempts[1] ?? 0,
    );
    // A teacher's trial grade and an earlier grade of a regraded student do not show.
    t.db.run(
      'INSERT INTO submissions (attempt_id, created_at, grade) VALUES (?, 2, 4)',
      attempts[0] ?? 0,
    );
    t.db.run(
      'INSERT INTO submissions (attempt_id, created_at) VALUES (?, 3)',
      attempts[0] ?? 0,
    );
    const res = await owner
      .get(`/api/classes/${classId}/grades.csv`)
      .buffer(true)
      .parse((response, done) => {
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('end', () => done(null, Buffer.concat(parts)));
      })
      .expect(200);
    assert.match(
      String(res.headers['content-type']),
      /^text\/csv; charset=utf-8/,
    );
    const bytes = res.body as Buffer;
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    assert.deepEqual(text.split('\r\n'), [
      '№;ПІБ;"Мережа; ""VLAN""";Друге',
      '1;Щербак Олена;;',
      '2;"Іваненко; ""Іван""";9;',
      '',
    ]);
  });

  test('a class without students or tasks still has a header', async () => {
    const owner = await teacherClient(t);
    const { id } = await createClass(owner);
    const text = (await owner.get(`/api/classes/${id}/grades.csv`).expect(200))
      .text;
    assert.equal(text, '\uFEFF№;ПІБ\r\n');
  });
});

describe('GET /api/search', () => {
  test('401 and 400 without q', async () => {
    const w = await world(t);
    await t.client().get('/api/search?q=ab').expect(401);
    await w.owner.get('/api/search').expect(400);
    await w.owner.get(`/api/search?q=${'a'.repeat(101)}`).expect(400);
  });

  test('finds a student by a lower-case Cyrillic fragment in my classes only', async () => {
    const owner = await teacherClient(t, 'Пошук');
    const stranger = await teacherClient(t, 'Інший');
    const mine = await createClass(owner, 'Мій клас');
    const theirs = await createClass(stranger, 'Чужий клас');
    await studentClient(t, mine.code, 'Щербак Олена');
    await studentClient(t, theirs.code, 'Щербань Петро');
    for (const q of ['щерб', 'ЩЕРБ', ' щерб ']) {
      const result = (await owner.get('/api/search').query({ q }).expect(200))
        .body as SearchResult;
      assert.deepEqual(
        result.students.map((s) => [s.name, s.class_name, s.class_id]),
        [['Щербак Олена', 'Мій клас', mine.id]],
      );
    }
    const foreign = (
      await stranger.get('/api/search').query({ q: 'щерб' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(
      foreign.students.map((s) => s.name),
      ['Щербань Петро'],
    );
  });

  test('a single character gives an empty result in every group', async () => {
    const w = await world(t);
    const result = (
      await w.owner.get('/api/search').query({ q: 'С' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(result, {
      classes: [],
      students: [],
      assignments: [],
      library: [],
    });
    const blank = (
      await w.owner.get('/api/search').query({ q: '   ' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(blank.students, []);
  });

  test('searches classes, assignments and my library; a student does not find classmates', async () => {
    const w = await world(t);
    const found = (
      await w.owner.get('/api/search').query({ q: 'налашт' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(
      found.assignments.map((a) => [a.title, a.class_id]),
      [['Налаштування мережі', w.classId]],
    );
    assert.deepEqual(
      found.library.map((item) => item.title),
      ['Налаштування мережі'],
    );
    const classes = (
      await w.owner.get('/api/search').query({ q: '10-' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(classes.classes, [{ id: w.classId, name: '10-А' }]);
    const asStudent = (
      await w.student.get('/api/search').query({ q: 'однокл' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(asStudent.students, []);
    const theirTask = (
      await w.student.get('/api/search').query({ q: 'налашт' }).expect(200)
    ).body as SearchResult;
    assert.equal(theirTask.assignments.length, 1);
    assert.deepEqual(theirTask.library, []);
    const outsider = (
      await w.outsider.get('/api/search').query({ q: 'налашт' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(outsider.assignments, []);
  });

  test('a deleted class and a deleted library item are not found', async () => {
    const owner = await teacherClient(t, 'Видалення');
    const { id } = await createClass(owner, 'Зникомий клас');
    const item = await createItem(owner, { title: 'Зникомий предмет' });
    await owner.delete(`/api/classes/${id}`).expect(200);
    await owner.delete(`/api/library/${item.id}`).expect(200);
    const result = (
      await owner.get('/api/search').query({ q: 'зникомий' }).expect(200)
    ).body as SearchResult;
    assert.deepEqual(result.classes, []);
    assert.deepEqual(result.library, []);
  });

  test('at most 8 results per group', async () => {
    const owner = await teacherClient(t, 'Багато');
    for (let i = 0; i < 10; i++) {
      await createItem(owner, { title: `Серія ${i}` });
    }
    const result = (
      await owner.get('/api/search').query({ q: 'серія' }).expect(200)
    ).body as SearchResult;
    assert.equal(result.library.length, 8);
  });
});

describe('Swagger', () => {
  test('GET /api/docs is open without login', async () => {
    const res = await t.client().get('/api/docs').redirects(1).expect(200);
    assert.match(String(res.headers['content-type']), /html/);
  });

  test('the document lists the review and grading routes and every schema has properties', async () => {
    const doc = (await t.client().get('/api/docs/json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { properties?: object }> };
    };
    assert.ok(doc.paths['/api/review']?.get);
    assert.ok(doc.paths['/api/submissions/{id}/grade']?.put);
    assert.ok(doc.paths['/api/classes/{id}/grades.csv']?.get);
    const empty = Object.entries(doc.components.schemas)
      .filter(([, schema]) => Object.keys(schema.properties ?? {}).length === 0)
      .map(([name]) => name);
    assert.deepEqual(empty, [], 'DTOs without @ApiProperty');
    assert.ok(doc.components.schemas['GradeDto']?.properties);
  });
});

describe('notifications of a deleted class', () => {
  test('nobody is notified and the list is empty; a restored class notifies again', async () => {
    const { w, submission } = await made();
    const activity = t.app.get(ActivityService);
    const row = t.db.get<{ id: number }>(
      "SELECT id FROM activity WHERE kind = 'submitted' AND ref_id = ?",
      submission.id,
    );
    const entries = (
      await w.owner.get(`/api/classes/${w.classId}/activity`).expect(200)
    ).body as Parameters<ActivityService['recipients']>[0][];
    const submitted = entries.find((entry) => entry.id === row?.id);
    assert.ok(submitted);
    assert.equal(activity.recipients(submitted).length, 2);
    assert.equal((await notifications(w.owner)).items.length > 0, true);
    await w.owner.delete(`/api/classes/${w.classId}`).expect(200);
    assert.deepEqual(activity.recipients(submitted), []);
    assert.deepEqual((await notifications(w.owner)).items, []);
    assert.equal((await notifications(w.owner)).unread, 0);
    await w.owner.post(`/api/classes/${w.classId}/restore`).expect(200);
    assert.equal(activity.recipients(submitted).length, 2);
  });
});

describe('queued submissions reach the bus', () => {
  test('enqueueing announces `queued` before verification starts', async () => {
    const runner = t.app.get(VerifyRunner);
    const events: SubmissionStatusEvent[] = [];
    const subscription = t.app
      .get(RunnerBus)
      .submissionStatus$.subscribe((event) => events.push(event));
    try {
      const w = await world(t);
      const attempt = await openAttempt(w.student, w.assignment.id);
      const start = await startBranch(w.student, attempt.id);
      await putEvents(w.student, start.id, 0, evs(0, 3));
      const sent = await submit(w.student, attempt.id, start.id, 3);
      // Garbage events fail the strict check in the main thread: no worker (no machine) starts.
      t.db.run(
        'UPDATE chunks SET events = ? WHERE branch_id = ?',
        JSON.stringify(Array.from({ length: 3 }, () => ({ t: 'nope' }))),
        start.id,
      );
      runner.enqueue(sent.id);
      await runner.idle();
      const mine = events.filter((event) => event.submission.id === sent.id);
      assert.equal(mine[0]?.submission.verify_status, 'queued');
      assert.equal(mine[0]?.assignment_id, w.assignment.id);
      assert.equal(mine[0]?.student_id > 0, true);
      assert.ok(mine.length >= 2, 'the final status follows');
      assert.equal(mine.at(-1)?.submission.verify_status, 'failed');
    } finally {
      subscription.unsubscribe();
    }
  });
});
