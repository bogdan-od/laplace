import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { HelpRequest, StudentProgress } from '@shared/api';
import { MAX_WS_MESSAGE_BYTES } from '@shared/limits';
import type { ServerMessage } from '@shared/ws';
import WebSocket from 'ws';
import { RunnerBus } from '../src/runner/runner-bus';
import {
  evs,
  openAttempt,
  putEvents,
  startBranch,
  world,
  World,
} from './attempt-fixtures';
import { Client, createTestApp, TestApp, whoAmI } from './helpers';

const STALE_MS = 400;
const WAIT_MS = 3_000;

let t: TestApp;
let port: number;
const wires: Wire[] = [];

before(async () => {
  process.env.WS_STALE_MS = String(STALE_MS);
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  port = (t.app.getHttpServer().address() as AddressInfo).port;
});
after(async () => {
  for (const wire of wires) wire.ws.terminate();
  await t.close();
  delete process.env.WS_STALE_MS;
});

type Incoming = ServerMessage & Record<string, unknown>;

/** A test WebSocket client that keeps every message and lets the test wait for one by type. */
class Wire {
  readonly inbox: Incoming[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(new Uint8Array(data)).toString();
      this.inbox.push(JSON.parse(text) as Incoming);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => ws.on('close', resolve));
  }

  static async open(sid: string | null): Promise<Wire> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      sid === null ? {} : { headers: { cookie: `sid=${sid}` } },
    );
    const wire = new Wire(ws);
    wires.push(wire);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return wire;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Removes and returns the first message of the type that satisfies the filter. */
  async take<T extends ServerMessage['type']>(
    type: T,
    match: (message: Incoming) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const index = this.inbox.findIndex(
        (message) => message.type === type && match(message),
      );
      if (index >= 0) {
        return this.inbox.splice(index, 1)[0] as Extract<
          ServerMessage,
          { type: T }
        >;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no "${type}" message arrived`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** After this the server has handled everything sent before and delivered its replies. */
  async sync(): Promise<void> {
    this.send({ type: 'ping' });
    await this.take('pong');
  }

  has(type: ServerMessage['type']): boolean {
    return this.inbox.some((message) => message.type === type);
  }

  async join(assignmentId: number, machines?: string[]) {
    this.send({
      type: 'join',
      assignment_id: assignmentId,
      ...(machines ? { machines } : {}),
    });
    return this.take('joined');
  }
}

async function sidOf(client: Client): Promise<string> {
  const { login } = await whoAmI(client);
  const res = await t
    .client()
    .post('/api/auth/login')
    .send({ login, password: 'password123' })
    .expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const sid = cookies.map((c) => /^sid=([^;]+)/.exec(c)?.[1]).find(Boolean);
  assert.ok(sid, 'no sid cookie');
  return sid;
}

const open = async (client: Client): Promise<Wire> =>
  Wire.open(await sidOf(client));

/** A world with the owner and both students connected and joined to the assignment. */
async function room(
  w: World,
): Promise<{ owner: Wire; student: Wire; mate: Wire }> {
  const owner = await open(w.owner);
  const student = await open(w.student);
  const mate = await open(w.classmate);
  await owner.join(w.assignment.id);
  await student.join(w.assignment.id);
  await mate.join(w.assignment.id);
  for (const wire of [owner, student, mate]) {
    await wire.sync();
    wire.inbox.length = 0;
  }
  return { owner, student, mate };
}

const frozenOf = (id: number): number =>
  t.db.get<{ frozen: number }>(
    'SELECT frozen FROM assignments WHERE id = ?',
    id,
  )?.frozen ?? -1;

describe('connection and join', () => {
  test('no session closes with 4401', async () => {
    const wire = await Wire.open(null);
    assert.equal(await wire.closed, 4401);
    const forged = await Wire.open('not-a-session');
    assert.equal(await forged.closed, 4401);
  });

  test('join to a foreign room is an error and the connection lives', async () => {
    const w = await world(t);
    const outsider = await open(w.outsider);
    outsider.send({ type: 'join', assignment_id: w.assignment.id });
    const error = await outsider.take('error');
    assert.match(error.message, /не знайдено/);
    const stranger = await open(w.stranger);
    stranger.send({ type: 'join', assignment_id: w.assignment.id });
    await stranger.take('error');
    outsider.send({ type: 'join', assignment_id: 999_999 });
    await outsider.take('error');
    await outsider.sync();
    assert.equal(outsider.ws.readyState, WebSocket.OPEN);
  });

  test('roles, ids and peers of a joined room', async () => {
    const w = await world(t);
    const owner = await open(w.owner);
    const ownerId = (await whoAmI(w.owner)).id;
    const first = await owner.join(w.assignment.id);
    assert.deepEqual(
      {
        id: first.id,
        role: first.role,
        peers: first.peers,
        resumed: first.resumed,
      },
      { id: `t${ownerId}`, role: 'teacher', peers: [], resumed: false },
    );
    const student = await open(w.student);
    const joined = await student.join(w.assignment.id, ['m1']);
    assert.equal(joined.id, 'p1');
    assert.equal(joined.role, 'student');
    assert.equal(joined.frozen, false);
    assert.equal(joined.peers.length, 1);
    assert.equal(joined.peers[0]?.id, `t${ownerId}`);
    const peer = await owner.take('peer-joined');
    assert.equal(peer.id, 'p1');
    assert.equal(peer.name, 'Студент');
    assert.deepEqual(peer.machines, ['m1']);
    const assistant = await open(w.assistant);
    const assistantId = (await whoAmI(w.assistant)).id;
    assert.equal((await assistant.join(w.assignment.id)).id, `t${assistantId}`);
    student.ws.close();
    assert.equal(
      (await owner.take('peer-left', (m) => m.id === 'p1')).id,
      'p1',
    );
  });

  test('a machine outside the topology is an error', async () => {
    const w = await world(t);
    const student = await open(w.student);
    student.send({
      type: 'join',
      assignment_id: w.assignment.id,
      machines: ['zz'],
    });
    await student.take('error');
  });

  test('a second connection replaces the first; resumed follows the 6 hours rule', async () => {
    const w = await world(t);
    const first = await open(w.student);
    assert.equal((await first.join(w.assignment.id)).resumed, false);
    const owner = await open(w.owner);
    await owner.join(w.assignment.id);
    const second = await open(w.student);
    const joined = await second.join(w.assignment.id);
    assert.equal(joined.resumed, true);
    await first.take('replaced');
    assert.equal(await first.closed, 1000);
    await owner.take('peer-left', (m) => m.id === 'p1');
    await owner.take('peer-joined', (m) => m.id === 'p1');
    second.ws.close();
    await owner.take('peer-left', (m) => m.id === 'p1');
    const back = await open(w.student);
    assert.equal((await back.join(w.assignment.id)).resumed, true);
    back.ws.close();
    await owner.take('peer-left', (m) => m.id === 'p1');
    t.clock.advance(6 * 3600_000 + 1);
    const late = await open(w.student);
    assert.equal((await late.join(w.assignment.id)).resumed, false);
  });
});

describe('forwarding', () => {
  test('serial goes from a student to teachers only', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    const assistant = await open(w.assistant);
    await assistant.join(w.assignment.id);
    student.send({ type: 'serial', data: 'hello', port: 0, machine: 'm1' });
    const got = await owner.take('serial');
    assert.deepEqual(
      { from: got.from, data: got.data, port: got.port, machine: got.machine },
      { from: 'p1', data: 'hello', port: 0, machine: 'm1' },
    );
    await assistant.take('serial');
    await student.sync();
    await mate.sync();
    assert.equal(mate.has('serial'), false);
    assert.equal(student.has('serial'), false);
    mate.send({ type: 'serial', data: 'x', machine: 'nope' });
    owner.send({ type: 'serial', data: 'from teacher' });
    await mate.sync();
    await owner.sync();
    assert.equal(
      owner.has('serial'),
      false,
      'unknown machine and teacher serial are dropped',
    );
  });

  test('teacher input is recorded before it is delivered', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    const teacherId = (await whoAmI(w.owner)).id;
    const studentId = (await whoAmI(w.student)).id;
    owner.send({ type: 'input', to: 'p1', data: 'ls\n', port: 0 });
    const got = await student.take('input');
    const rows = t.db.all<Record<string, unknown>>(
      'SELECT assignment_id, student_id, node_id, port, data, author_id FROM teacher_inputs WHERE assignment_id = ?',
      w.assignment.id,
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          assignment_id: w.assignment.id,
          student_id: studentId,
          node_id: 'm1',
          port: 0,
          data: 'ls\n',
          author_id: teacherId,
        },
      ],
    );
    assert.deepEqual(
      { from: got.from, data: got.data, port: got.port },
      { from: `t${teacherId}`, data: 'ls\n', port: 0 },
    );
    await mate.sync();
    assert.equal(mate.has('input'), false);
    student.send({ type: 'input', to: 'p2', data: 'x', port: 0 });
    mate.send({ type: 'input', to: `t${teacherId}`, data: 'x', port: 0 });
    owner.send({
      type: 'input',
      to: 'p1',
      data: 'x',
      port: 0,
      machine: 'nope',
    });
    owner.send({ type: 'input', to: `t${teacherId}`, data: 'x', port: 0 });
    owner.send({ type: 'input', to: 'p9', data: 'x', port: 0 });
    for (const wire of [student, mate, owner]) await wire.sync();
    assert.equal(
      student.has('input') || mate.has('input') || owner.has('input'),
      false,
    );
    assert.equal(
      t.db.all(
        'SELECT id FROM teacher_inputs WHERE assignment_id = ?',
        w.assignment.id,
      ).length,
      1,
    );
  });

  test('signal reaches any participant of the room', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    const ownerId = (await whoAmI(w.owner)).id;
    student.send({ type: 'signal', to: 'p2', data: { offer: 1 } });
    assert.deepEqual((await mate.take('signal')).data, { offer: 1 });
    student.send({ type: 'signal', to: `t${ownerId}`, data: 'hi' });
    assert.equal((await owner.take('signal')).from, 'p1');
    student.send({ type: 'signal', to: 'p1', data: 'self' });
    student.send({ type: 'signal', to: 'p77', data: 'nobody' });
    await student.sync();
    assert.equal(student.has('signal'), false);
  });

  test('frame passes between students only with shared_lan', async () => {
    const w = await world(t);
    let wires = await room(w);
    const frame = 'AAECAw==';
    wires.student.send({ type: 'frame', to: 'p2', data: frame });
    await wires.student.sync();
    await wires.mate.sync();
    assert.equal(wires.mate.has('frame'), false, 'no shared_lan');

    t.db.run(
      'UPDATE assignments SET shared_lan = 1 WHERE id = ?',
      w.assignment.id,
    );
    wires = await room(w);
    wires.student.send({ type: 'frame', to: 'p2', data: frame });
    const got = await wires.mate.take('frame');
    assert.deepEqual(
      { from: got.from, data: got.data },
      { from: 'p1', data: frame },
    );

    wires.student.send({ type: 'frame', to: 'p2', data: 'A'.repeat(2101) });
    wires.student.send({ type: 'frame', to: 'p2', data: 'A'.repeat(2100) });
    const ok = await wires.mate.take('frame');
    assert.equal(ok.data.length, 2100);
    await wires.student.sync();
    await wires.mate.sync();
    assert.equal(
      wires.mate.has('frame'),
      false,
      'the 2101-character frame is dropped',
    );

    wires.student.send({
      type: 'frame',
      to: `t${(await whoAmI(w.owner)).id}`,
      data: frame,
    });
    wires.owner.send({ type: 'frame', to: 'p1', data: frame });
    await wires.student.sync();
    await wires.owner.sync();
    assert.equal(wires.owner.has('frame') || wires.student.has('frame'), false);
  });

  test('freeze: only a teacher, written to the database, sent to everyone', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    student.send({ type: 'freeze', frozen: true });
    await student.sync();
    await owner.sync();
    assert.equal(frozenOf(w.assignment.id), 0);
    assert.equal(owner.has('frozen') || mate.has('frozen'), false);

    owner.send({ type: 'freeze', frozen: true });
    const ownerRef = { id: (await whoAmI(w.owner)).id, name: 'Власник' };
    for (const wire of [owner, student, mate]) {
      const msg = await wire.take('frozen');
      assert.deepEqual(
        { frozen: msg.frozen, by: msg.by },
        { frozen: true, by: ownerRef },
      );
    }
    assert.equal(frozenOf(w.assignment.id), 1);
    const late = await open(w.assistant);
    assert.equal((await late.join(w.assignment.id)).frozen, true);
    owner.send({ type: 'freeze', frozen: false });
    assert.equal((await student.take('frozen')).frozen, false);
    assert.equal(frozenOf(w.assignment.id), 0);
  });
});

describe('limits', () => {
  test('bad and oversized messages are dropped silently, the connection lives', async () => {
    const w = await world(t);
    const { owner, student } = await room(w);
    const big = JSON.stringify({
      type: 'serial',
      data: 'x'.repeat(MAX_WS_MESSAGE_BYTES + 10),
    });
    assert.ok(Buffer.byteLength(big) > MAX_WS_MESSAGE_BYTES);
    student.ws.send(big);
    student.ws.send('not json');
    student.ws.send(Buffer.from([1, 2, 3]));
    student.send({ type: 'serial', data: 'y'.repeat(64 * 1024 + 1) });
    student.send({ type: 'serial', data: 5 });
    student.send({ type: 'weird' });
    student.send([1]);
    student.send({ type: 'serial', data: 'fine' });
    assert.equal((await owner.take('serial')).data, 'fine');
    await student.sync();
    assert.equal(owner.has('serial'), false);
    assert.equal(student.ws.readyState, WebSocket.OPEN);
  });

  test('messages before join do nothing; ping works without join', async () => {
    const w = await world(t);
    const student = await open(w.student);
    student.send({ type: 'serial', data: 'x' });
    student.send({ type: 'freeze', frozen: true });
    await student.sync();
    assert.equal(frozenOf(w.assignment.id), 0);
  });

  test('a client that pinged and went silent is dropped; the others stay', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    const alive = setInterval(() => {
      owner.send({ type: 'ping' });
      student.send({ type: 'ping' });
    }, STALE_MS / 4);
    try {
      assert.equal(await mate.closed, 1006);
      assert.equal(
        (await owner.take('peer-left', (m) => m.id === 'p2')).id,
        'p2',
      );
    } finally {
      clearInterval(alive);
    }
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
    assert.equal(student.ws.readyState, WebSocket.OPEN);
  });

  test('a client that never pinged is not dropped for silence', async () => {
    const w = await world(t);
    const student = await open(w.student);
    await new Promise((resolve) => setTimeout(resolve, STALE_MS * 3));
    assert.equal(student.ws.readyState, WebSocket.OPEN);
  });
});

async function helpAndTiles(w: World) {
  const attempt = await openAttempt(w.student, w.assignment.id);
  const start = await startBranch(w.student, attempt.id);
  return { attempt, start };
}

const tileOf = async (wire: Wire, status: string): Promise<StudentProgress> =>
  (
    await wire.take(
      'tile',
      (m) => (m.progress as StudentProgress).status === status,
    )
  ).progress;

describe('tiles', () => {
  test('work, stuck and done reach the teachers of the room', async () => {
    const w = await world(t);
    const { owner, student, mate } = await room(w);
    const assistant = await open(w.assistant);
    await assistant.join(w.assignment.id);
    const studentId = (await whoAmI(w.student)).id;
    const { attempt, start } = await helpAndTiles(w);
    const opened = await tileOf(owner, 'work');
    assert.equal(opened.attempt_id, attempt.id);
    assert.equal(opened.user_id, studentId);
    assert.equal(opened.number, 1);

    await putEvents(w.student, start.id, 0, evs(0, 5), {
      commands: 4,
      last_command: 'ls -la',
    });
    const working = await owner.take(
      'tile',
      (m) => (m.progress as StudentProgress).commands === 4,
    );
    assert.equal(working.assignment_id, w.assignment.id);
    assert.equal(working.progress.status, 'work');
    assert.equal(working.progress.last_command, 'ls -la');
    assert.equal(working.progress.name, 'Студент');
    assert.ok(working.progress.last_activity_at);
    await assistant.take(
      'tile',
      (m) => (m.progress as StudentProgress).commands === 4,
    );

    const helpRes = await w.student
      .post(`/api/attempts/${attempt.id}/help`)
      .send({
        node: 'm1',
        branch_id: start.id,
        event_count: 5,
        text: 'Допоможіть',
      })
      .expect(201);
    const help = helpRes.body as HelpRequest;
    const stuck = await tileOf(owner, 'stuck');
    assert.equal(stuck.open_help?.id, help.id);

    const done = w.student
      .post(`/api/attempts/${attempt.id}/submit`)
      .send({ heads: [{ node: 'm1', branch_id: start.id, event_count: 5 }] })
      .expect(201);
    await done;
    const finished = await tileOf(owner, 'done');
    assert.equal(finished.latest_submission?.verify_status, 'queued');

    await student.sync();
    await mate.sync();
    assert.equal(
      student.has('tile') || mate.has('tile'),
      false,
      'students get no tiles',
    );
  });

  test('a status change of a submission updates the tile', async () => {
    const w = await world(t);
    const { owner } = await room(w);
    const { attempt, start } = await helpAndTiles(w);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    await w.student
      .post(`/api/attempts/${attempt.id}/submit`)
      .send({ heads: [{ node: 'm1', branch_id: start.id, event_count: 3 }] })
      .expect(201);
    await tileOf(owner, 'done');
    owner.inbox.length = 0;
    const row = t.db.get<{ id: number }>(
      'SELECT id FROM submissions WHERE attempt_id = ?',
      attempt.id,
    );
    assert.ok(row);
    t.db.run(
      "UPDATE submissions SET verify_status = 'ok' WHERE id = ?",
      row.id,
    );
    t.app.get(RunnerBus).emitSubmission({
      assignment_id: w.assignment.id,
      student_id: (await whoAmI(w.student)).id,
      submission: {
        id: row.id,
        attempt_id: attempt.id,
        created_at: 0,
        verify_status: 'ok',
        grade: null,
        checks: null,
      },
    });
    const tile = await tileOf(owner, 'done');
    assert.equal(tile.latest_submission?.verify_status, 'ok');
  });

  test('a teacher outside the room gets no tile', async () => {
    const w = await world(t);
    const stranger = await open(w.stranger);
    const { owner } = await room(w);
    await helpAndTiles(w);
    await tileOf(owner, 'work');
    await stranger.sync();
    assert.equal(stranger.has('tile'), false);
  });
});

describe('personal messages', () => {
  test('help_requested notifies the teachers of the class, not the student', async () => {
    const w = await world(t);
    const owner = await open(w.owner);
    const assistant = await open(w.assistant);
    const stranger = await open(w.stranger);
    const student = await open(w.student);
    const mate = await open(w.classmate);
    const { attempt, start } = await helpAndTiles(w);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    await w.student
      .post(`/api/attempts/${attempt.id}/help`)
      .send({
        node: 'm1',
        branch_id: start.id,
        event_count: 3,
        text: 'Не працює',
      })
      .expect(201);
    for (const teacher of [owner, assistant]) {
      const { activity } = await teacher.take('notify');
      assert.equal(activity.kind, 'help_requested');
      assert.equal(activity.assignment_id, w.assignment.id);
      assert.equal(activity.student?.name, 'Студент');
    }
    for (const wire of [student, mate, stranger]) {
      await wire.sync();
      assert.equal(wire.has('notify'), false);
    }
  });

  test('graded-like activity goes to the student of the attempt', async () => {
    const w = await world(t);
    const student = await open(w.student);
    const mate = await open(w.classmate);
    const owner = await open(w.owner);
    const { attempt, start } = await helpAndTiles(w);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    const help = (
      await w.student
        .post(`/api/attempts/${attempt.id}/help`)
        .send({ node: 'm1', branch_id: start.id, event_count: 3, text: 'x' })
        .expect(201)
    ).body as HelpRequest;
    await owner.take('notify');
    await w.owner.post(`/api/help/${help.id}/resolve`).expect(200);
    assert.equal((await student.take('notify')).activity.kind, 'help_resolved');
    await mate.sync();
    assert.equal(mate.has('notify'), false);
    await owner.sync();
    assert.equal(owner.has('notify'), false, 'the actor is not notified');
  });

  test('submission status goes to the author and the teachers, not to others', async () => {
    const w = await world(t);
    const student = await open(w.student);
    const mate = await open(w.classmate);
    const owner = await open(w.owner);
    const assistant = await open(w.assistant);
    const stranger = await open(w.stranger);
    const { attempt, start } = await helpAndTiles(w);
    await putEvents(w.student, start.id, 0, evs(0, 3));
    const submission = (
      await w.student
        .post(`/api/attempts/${attempt.id}/submit`)
        .send({ heads: [{ node: 'm1', branch_id: start.id, event_count: 3 }] })
        .expect(201)
    ).body as {
      id: number;
      attempt_id: number;
      created_at: number;
      verify_status: 'queued';
      grade: null;
      checks: null;
    };
    await owner.take('notify');
    t.app.get(RunnerBus).emitSubmission({
      assignment_id: w.assignment.id,
      student_id: (await whoAmI(w.student)).id,
      submission: { ...submission, verify_status: 'failed' },
    });
    for (const wire of [student, owner, assistant]) {
      const msg = await wire.take('submission');
      assert.equal(msg.assignment_id, w.assignment.id);
      assert.equal(msg.submission.verify_status, 'failed');
      assert.equal(msg.submission.id, submission.id);
    }
    for (const wire of [mate, stranger]) {
      await wire.sync();
      assert.equal(wire.has('submission'), false);
    }
  });

  test('check-run goes to the teacher who started it, on every connection', async () => {
    const w = await world(t);
    const owner = await open(w.owner);
    const ownerSecondTab = await open(w.owner);
    const assistant = await open(w.assistant);
    const run = {
      id: 1,
      submission_id: 5,
      status: 'running' as const,
      results: [],
      message: null,
      created_at: 1,
      finished_at: null,
    };
    t.app.get(RunnerBus).emitCheckRun({
      started_by: (await whoAmI(w.owner)).id,
      run,
    });
    assert.deepEqual((await owner.take('check-run')).run, run);
    assert.deepEqual((await ownerSecondTab.take('check-run')).run, run);
    await assistant.sync();
    assert.equal(assistant.has('check-run'), false);
  });
});
