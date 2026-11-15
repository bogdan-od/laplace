// Every test that starts v86 machines lives in this one file: the machines are heavy, and the
// node:test runner starts files in parallel. RUNNER_WORKERS=1 keeps one worker thread at a time.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  Attempt,
  Branch,
  CheckRun,
  Journal,
  NotificationList,
  SubmissionSummary,
  VerifyStatus,
} from '@shared/api';
import { MachineFactory } from '../src/runner/machine-factory';
import { RunnerBus } from '../src/runner/runner-bus';
import { CheckRunner } from '../src/runner/check-runner';
import { VerifyRunner } from '../src/runner/verify-runner';
import { repoRoot } from '../src/repo-root';
import { openAttempt, world, World } from './attempt-fixtures';
import { Client, createTestApp, TestApp } from './helpers';

process.env.RUNNER_WORKERS = '1';

const REAL = JSON.parse(
  readFileSync(
    join(repoRoot(), 'server', 'test', 'journals-fixtures', 'buildroot-1.json'),
    'utf8',
  ),
) as Journal;
const POLL_MS = 100;
const WAIT_MS = 180_000;
const RSS_SAMPLE_MS = 500;
const MIB = 2 ** 20;

let peakRss = 0;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, RSS_SAMPLE_MS);
rssTimer.unref();

let t: TestApp;
before(async () => {
  t = await createTestApp({ runner: true });
});
after(async () => {
  await t.close();
  clearInterval(rssTimer);
  console.log(`peak rss of the test process: ${Math.round(peakRss / MIB)} MiB`);
});

async function waitFor(
  what: string,
  done: () => boolean,
  timeoutMs = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const FINAL: VerifyStatus[] = ['ok', 'failed', 'tail_unchecked', 'timeout'];

interface Row {
  verify_status: VerifyStatus;
  verify_message: string | null;
  commands_count: number | null;
  verified_at: number | null;
}

const rowOf = (app: TestApp, id: number): Row => {
  const row = app.db.get<Row>(
    'SELECT verify_status, verify_message, commands_count, verified_at FROM submissions WHERE id = ?',
    id,
  );
  if (!row) throw new Error(`no submission ${id}`);
  return row;
};

async function finalRow(app: TestApp, id: number): Promise<Row> {
  await waitFor(`submission ${id} to finish`, () =>
    FINAL.includes(rowOf(app, id).verify_status),
  );
  return rowOf(app, id);
}

/** The student plays the journal into a fresh attempt and submits it. */
async function submitJournal(
  student: Client,
  assignmentId: number,
  journal: Journal,
): Promise<{ attempt: Attempt; submission: SubmissionSummary }> {
  const attempt = await openAttempt(student, assignmentId);
  const branch = (
    await student
      .post(`/api/attempts/${attempt.id}/branches`)
      .send({
        node: 'm1',
        parent: null,
        kind: 'start',
        header: journal.header,
        make_head: true,
      })
      .expect(201)
  ).body as Branch;
  await student
    .put(`/api/branches/${branch.id}/events`)
    .send({ from: 0, events: journal.events })
    .expect(200);
  const submission = (
    await student
      .post(`/api/attempts/${attempt.id}/submit`)
      .send({
        heads: [
          {
            node: 'm1',
            branch_id: branch.id,
            event_count: journal.events.length,
          },
        ],
      })
      .expect(201)
  ).body as SubmissionSummary;
  return { attempt, submission };
}

const withEvents = (events: Journal['events']): Journal => ({
  header: REAL.header,
  events,
});

/** The statuses a submission goes through, as the bus publishes them. */
function recordStatuses(app: TestApp, id: number): VerifyStatus[] {
  const seen: VerifyStatus[] = [];
  app.app.get(RunnerBus).submissionStatus$.subscribe(({ submission }) => {
    if (submission.id === id) seen.push(submission.verify_status);
  });
  return seen;
}

const notifications = async (client: Client): Promise<string[]> =>
  (
    (await client.get('/api/notifications').expect(200))
      .body as NotificationList
  ).items.map((item) => item.kind);

describe('verification of a real journal', () => {
  test('buildroot-1.json goes queued, running, ok and counts commands', async () => {
    const w = await world(t);
    const { submission } = await submitJournal(
      w.student,
      w.assignment.id,
      REAL,
    );
    const seen = recordStatuses(t, submission.id);
    const row = await finalRow(t, submission.id);
    assert.equal(row.verify_status, 'ok');
    assert.equal(row.verify_message, null);
    assert.ok(row.commands_count !== null && row.commands_count > 0);
    assert.ok(row.verified_at !== null);
    assert.equal(seen.at(-1), 'ok');
    assert.equal(t.app.get(MachineFactory).aliveCount, 0);
  });

  test('one changed byte before the last check gives failed with the event number', async () => {
    const w = await world(t);
    const events = structuredClone(REAL.events);
    const typed = events[2];
    assert.ok(typed && typed.t === 'serial' && typed.data === 'i');
    typed.data = 'x';
    const { submission } = await submitJournal(
      w.student,
      w.assignment.id,
      withEvents(events),
    );
    const row = await finalRow(t, submission.id);
    assert.equal(row.verify_status, 'failed');
    assert.match(row.verify_message ?? '', /^m1: .*подія \d+/);
    assert.ok(row.commands_count !== null);
    for (const teacher of [w.owner, w.assistant]) {
      assert.ok((await notifications(teacher)).includes('verify_failed'));
    }
    assert.ok(!(await notifications(w.student)).includes('verify_failed'));
    assert.equal(t.app.get(MachineFactory).aliveCount, 0);
  });

  test('a journal cut after the last check plus input is tail_unchecked', async () => {
    const w = await world(t);
    const events = REAL.events.slice(0, 212);
    assert.equal(events.at(-1)?.t, 'serial');
    const { submission } = await submitJournal(
      w.student,
      w.assignment.id,
      withEvents(events),
    );
    const row = await finalRow(t, submission.id);
    assert.equal(row.verify_status, 'tail_unchecked');
    assert.equal(row.verify_message, null);
  });

  test('a submission that breaks the strict rules fails before any worker starts', async () => {
    const w = await world(t);
    const { submission } = await submitJournal(
      w.student,
      w.assignment.id,
      withEvents(REAL.events.slice(0, 5)),
    );
    await finalRow(t, submission.id);
    // The chunk upload accepted it; damage the stored chunk behind the server's back, then verify again.
    t.db.run(
      `UPDATE chunks SET events = replace(events, '"t":"serial"', '"t":"bogus"')
       WHERE branch_id = (SELECT branch_id FROM submission_journals WHERE submission_id = ?)`,
      submission.id,
    );
    await w.owner.post(`/api/submissions/${submission.id}/verify`).expect(200);
    const row = await finalRow(t, submission.id);
    assert.equal(row.verify_status, 'failed');
    assert.match(row.verify_message ?? '', /^m1: /);
  });
});

describe('POST /api/submissions/:id/verify', () => {
  let w: World;
  let id: number;
  before(async () => {
    w = await world(t);
    id = (await submitJournal(w.student, w.assignment.id, REAL)).submission.id;
    await finalRow(t, id);
  });

  test('401, 404, 403', async () => {
    const url = `/api/submissions/${id}/verify`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.outsider.post(url).expect(404);
    await w.student.post(url).expect(403);
    await w.classmate.post(url).expect(403);
    await w.owner.post('/api/submissions/999999/verify').expect(404);
    await w.owner.post('/api/submissions/abc/verify').expect(404);
  });

  test('a teacher verifies again: queued first, ok in the end', async () => {
    const seen = recordStatuses(t, id);
    const res = await w.assistant
      .post(`/api/submissions/${id}/verify`)
      .expect(200);
    const summary = res.body as SubmissionSummary;
    assert.equal(summary.id, id);
    assert.equal(summary.verify_status, 'queued');
    assert.equal(rowOf(t, id).commands_count, null);
    const row = await finalRow(t, id);
    assert.equal(row.verify_status, 'ok');
    assert.deepEqual(seen, ['queued', 'running', 'ok']);
  });

  test('a submission that is already waiting is not queued twice', async () => {
    const first = await w.owner
      .post(`/api/submissions/${id}/verify`)
      .expect(200);
    const second = await w.owner
      .post(`/api/submissions/${id}/verify`)
      .expect(200);
    assert.equal((first.body as SubmissionSummary).verify_status, 'queued');
    assert.ok(
      ['queued', 'running'].includes(
        (second.body as SubmissionSummary).verify_status,
      ),
    );
    await finalRow(t, id);
  });
});

describe('POST /api/assignments/:id/verify-all', () => {
  test('401, 404, 403', async () => {
    const w = await world(t);
    const url = `/api/assignments/${w.assignment.id}/verify-all`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.outsider.post(url).expect(404);
    await w.student.post(url).expect(403);
    await w.owner.post('/api/assignments/999999/verify-all').expect(404);
  });

  test('the newest submission of each student is queued; teacher trials are left out', async () => {
    const w = await world(t);
    const first = await submitJournal(w.student, w.assignment.id, REAL);
    const second = await submitJournal(
      w.classmate,
      w.assignment.id,
      withEvents(REAL.events.slice(0, 212)),
    );
    await submitJournal(w.owner, w.assignment.id, REAL);
    await finalRow(t, first.submission.id);
    await finalRow(t, second.submission.id);
    const trial = t.db.get<{ id: number }>(
      `SELECT s.id FROM submissions s JOIN attempts a ON a.id = s.attempt_id
       WHERE a.assignment_id = ? AND a.is_preview = 1`,
      w.assignment.id,
    );
    assert.ok(trial);
    await finalRow(t, trial.id);
    const res = await w.assistant
      .post(`/api/assignments/${w.assignment.id}/verify-all`)
      .expect(200);
    assert.deepEqual(res.body, { queued: 2 });
    assert.equal((await finalRow(t, first.submission.id)).verify_status, 'ok');
    assert.equal(
      (await finalRow(t, second.submission.id)).verify_status,
      'tail_unchecked',
    );
    const again = await w.owner
      .post(`/api/assignments/${w.assignment.id}/verify-all`)
      .expect(200);
    assert.deepEqual(again.body, { queued: 2 });
    await t.app.get(VerifyRunner).idle();
  });
});

const CHECKS = [
  { node: 'm1', title: 'Привіт', command: 'echo hi' },
  { node: 'm1', title: 'Хибна команда', command: 'false' },
  { node: 'm1', title: 'Варіант', command: 'echo v{n}' },
];

async function runOf(app: TestApp, id: number): Promise<CheckRun> {
  const row = (): { status: string } | undefined =>
    app.db.get<{ status: string }>(
      'SELECT status FROM check_runs WHERE id = ?',
      id,
    );
  await waitFor(
    `check run ${id}`,
    () => row()?.status === 'done' || row()?.status === 'failed',
  );
  const done = app.db.get<{
    id: number;
    submission_id: number;
    status: CheckRun['status'];
    results: string;
    message: string | null;
    created_at: number;
    finished_at: number | null;
  }>('SELECT * FROM check_runs WHERE id = ?', id);
  if (!done) throw new Error('run vanished');
  return { ...done, results: JSON.parse(done.results) as CheckRun['results'] };
}

describe('POST /api/submissions/:id/check-runs', () => {
  let w: World;
  let id: number;
  let variant: number;
  before(async () => {
    w = await world(t, { checks: CHECKS });
    const sent = await submitJournal(w.student, w.assignment.id, REAL);
    id = sent.submission.id;
    variant = sent.attempt.variant;
    await finalRow(t, id);
  });

  test('401, 404, 403', async () => {
    const url = `/api/submissions/${id}/check-runs`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.student.post(url).expect(403);
    await w.owner.post('/api/submissions/999999/check-runs').expect(404);
  });

  test('echo hi and false: queued at once, then running, two results, done', async () => {
    const events: { status: string; results: number }[] = [];
    t.app.get(RunnerBus).checkRun$.subscribe(({ started_by, run }) => {
      events.push({ status: run.status, results: run.results.length });
      assert.equal(typeof started_by, 'number');
    });
    const res = await w.assistant
      .post(`/api/submissions/${id}/check-runs`)
      .expect(201);
    const first = res.body as CheckRun;
    assert.equal(first.status, 'queued');
    assert.equal(first.submission_id, id);
    assert.deepEqual(first.results, []);
    assert.equal(first.finished_at, null);
    const run = await runOf(t, first.id);
    assert.equal(run.status, 'done', run.message ?? '');
    assert.equal(run.results.length, 3);
    const [hi, no] = run.results;
    assert.equal(hi?.rc, 0);
    assert.match(hi?.output ?? '', /hi/);
    assert.equal(hi?.node, 'm1');
    assert.equal(hi?.title, 'Привіт');
    assert.equal(hi?.command, 'echo hi');
    assert.equal(no?.rc, 1);
    const [, , numbered] = run.results;
    assert.equal(numbered?.command, 'echo v{n}');
    assert.match(numbered?.output ?? '', new RegExp(`v${variant}\\b`));
    assert.ok(run.finished_at !== null);
    assert.deepEqual(events, [
      { status: 'running', results: 0 },
      { status: 'running', results: 1 },
      { status: 'running', results: 2 },
      { status: 'running', results: 3 },
      { status: 'done', results: 3 },
    ]);
    await waitFor(
      'the machine worker to exit',
      () => t.app.get(MachineFactory).aliveCount === 0,
      10_000,
    );
  });

  test('a journal that diverges makes the run failed with a text for people', async () => {
    const w2 = await world(t, { checks: CHECKS });
    const events = structuredClone(REAL.events);
    const typed = events[2];
    assert.ok(typed && typed.t === 'serial');
    typed.data = 'x';
    const bad = await submitJournal(
      w2.student,
      w2.assignment.id,
      withEvents(events),
    );
    await finalRow(t, bad.submission.id);
    const res = await w2.owner
      .post(`/api/submissions/${bad.submission.id}/check-runs`)
      .expect(201);
    const run = await runOf(t, (res.body as CheckRun).id);
    assert.equal(run.status, 'failed');
    assert.match(run.message ?? '', /m1/);
    assert.deepEqual(run.results, []);
    await waitFor(
      'the machine worker to exit',
      () => t.app.get(MachineFactory).aliveCount === 0,
      10_000,
    );
  });

  test('400 when the assignment has no check commands', async () => {
    const plain = await world(t);
    const sub = await submitJournal(plain.student, plain.assignment.id, REAL);
    await finalRow(t, sub.submission.id);
    await plain.owner
      .post(`/api/submissions/${sub.submission.id}/check-runs`)
      .expect(400);
    await plain.owner
      .post(`/api/assignments/${plain.assignment.id}/check-all`)
      .expect(400);
  });
});

describe('POST /api/assignments/:id/check-all', () => {
  test('401, 404, 403', async () => {
    const w = await world(t, { checks: CHECKS });
    const url = `/api/assignments/${w.assignment.id}/check-all`;
    await t.client().post(url).expect(401);
    await w.stranger.post(url).expect(404);
    await w.student.post(url).expect(403);
    await w.owner.post('/api/assignments/999999/check-all').expect(404);
  });

  test('starts a run for the newest submission of each student', async () => {
    const w = await world(t, { checks: CHECKS });
    const a = await submitJournal(w.student, w.assignment.id, REAL);
    const b = await submitJournal(w.classmate, w.assignment.id, REAL);
    await finalRow(t, a.submission.id);
    await finalRow(t, b.submission.id);
    const res = await w.owner
      .post(`/api/assignments/${w.assignment.id}/check-all`)
      .expect(200);
    assert.deepEqual(res.body, { queued: 2 });
    await t.app.get(CheckRunner).idle();
    const runs = t.db.all<{ status: string }>(
      `SELECT status FROM check_runs WHERE submission_id IN (?, ?)`,
      a.submission.id,
      b.submission.id,
    );
    assert.deepEqual(
      runs.map((run) => run.status),
      ['done', 'done'],
    );
  });
});

describe('the timeout', () => {
  test('RUNNER_TIMEOUT_MS=1000 gives timeout and ends the worker', async () => {
    process.env.RUNNER_TIMEOUT_MS = '1000';
    const quick = await createTestApp({ runner: true });
    delete process.env.RUNNER_TIMEOUT_MS;
    try {
      const w = await world(quick);
      const { submission } = await submitJournal(
        w.student,
        w.assignment.id,
        REAL,
      );
      const row = await finalRow(quick, submission.id);
      assert.equal(row.verify_status, 'timeout');
      assert.match(row.verify_message ?? '', /^m1: /);
      await waitFor(
        'the worker to exit',
        () => quick.app.get(MachineFactory).aliveCount === 0,
        10_000,
      );
      assert.ok((await notifications(w.owner)).includes('verify_failed'));
    } finally {
      await quick.close();
    }
  });
});

describe('a restart', () => {
  test('a submission left in running is verified again by the next app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'laplace-restart-'));
    const dbFile = join(dir, 'test.sqlite');
    const journalDir = join(dir, 'journals');
    let id = 0;
    const first = await createTestApp({ dbFile, journalDir });
    try {
      const w = await world(first);
      id = (await submitJournal(w.student, w.assignment.id, REAL)).submission
        .id;
      assert.equal(rowOf(first, id).verify_status, 'queued');
      first.db.run(
        "UPDATE submissions SET verify_status = 'running' WHERE id = ?",
        id,
      );
    } finally {
      await first.close();
    }
    const second = await createTestApp({ runner: true, dbFile, journalDir });
    try {
      const row = await finalRow(second, id);
      assert.equal(row.verify_status, 'ok');
      assert.ok(row.commands_count !== null && row.commands_count > 0);
    } finally {
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a check run cut short by a restart is marked failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'laplace-restart-'));
    const dbFile = join(dir, 'test.sqlite');
    const journalDir = join(dir, 'journals');
    const first = await createTestApp({ dbFile, journalDir });
    let runId = 0;
    try {
      const w = await world(first, { checks: CHECKS });
      const { submission } = await submitJournal(
        w.student,
        w.assignment.id,
        REAL,
      );
      const owner = first.db.get<{ id: number }>(
        'SELECT id FROM users ORDER BY id LIMIT 1',
      );
      assert.ok(owner);
      runId = first.db.run(
        `INSERT INTO check_runs (submission_id, started_by, status, created_at)
         VALUES (?, ?, 'running', 1)`,
        submission.id,
        owner.id,
      ).id;
    } finally {
      await first.close();
    }
    const second = await createTestApp({ dbFile, journalDir });
    try {
      const run = await runOf(second, runId);
      assert.equal(run.status, 'failed');
      assert.match(run.message ?? '', /перезапущено/);
    } finally {
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
