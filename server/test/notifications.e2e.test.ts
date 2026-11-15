import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Activity, ActivityKind, NotificationList } from '@shared/api';
import { ActivityService } from '../src/activity/activity.service';
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
let activity: ActivityService;
before(async () => {
  t = await createTestApp();
  activity = t.app.get(ActivityService);
});
after(async () => {
  await t.close();
});

const list = async (client: Client): Promise<NotificationList> =>
  (await client.get('/api/notifications').expect(200)).body as NotificationList;

type Person = 'owner' | 'assistant' | 'student' | 'other' | 'stranger';
const PEOPLE: Person[] = ['owner', 'assistant', 'student', 'other', 'stranger'];

async function scene(): Promise<{
  clients: Record<Person, Client>;
  ids: Record<Person, number>;
  classId: number;
  code: string;
}> {
  const owner = await teacherClient(t);
  const assistant = await teacherClient(t);
  const stranger = await teacherClient(t);
  const { id: classId, code } = await createClass(owner);
  await owner
    .post(`/api/classes/${classId}/assistants`)
    .send({ login: (await whoAmI(assistant)).login })
    .expect(201);
  const student = await studentClient(t, code);
  const other = await studentClient(t, code);
  const clients = { owner, assistant, student, other, stranger };
  const ids = {} as Record<Person, number>;
  for (const person of PEOPLE) ids[person] = (await whoAmI(clients[person])).id;
  return { clients, ids, classId, code };
}

describe('GET /api/notifications and POST /api/notifications/read', () => {
  test('401 without a login', async () => {
    await t.client().get('/api/notifications').expect(401);
    await t
      .client()
      .post('/api/notifications/read')
      .send({ up_to: 1 })
      .expect(401);
  });

  test('400 for a bad body', async () => {
    const owner = await teacherClient(t);
    for (const payload of [
      {},
      { up_to: -1 },
      { up_to: 'x' },
      { up_to: 1.5 },
      { up_to: 1, more: 1 },
    ]) {
      await owner.post('/api/notifications/read').send(payload).expect(400);
    }
  });

  test('member_joined is seen by the owner and by nobody else', async () => {
    const s = await scene();
    const mine = await list(s.clients.owner);
    assert.equal(mine.unread, 2);
    assert.deepEqual(
      mine.items.map((a) => [a.kind, a.class_id]),
      [
        ['member_joined', s.classId],
        ['member_joined', s.classId],
      ],
    );
    const first = mine.items[1];
    assert.ok(first);
    assert.equal(first.actor.id, s.ids.student);
    assert.equal(first.student?.id, s.ids.student);
    for (const person of [
      'student',
      'other',
      'assistant',
      'stranger',
    ] as const) {
      assert.deepEqual(
        await list(s.clients[person]),
        { items: [], unread: 0 },
        person,
      );
    }
  });

  test('read marks up to an id; ids from the future are clamped; it never moves back', async () => {
    const s = await scene();
    const newest = (await list(s.clients.owner)).items[0];
    assert.ok(newest);
    await s.clients.owner
      .post('/api/notifications/read')
      .send({ up_to: newest.id - 1 })
      .expect(200);
    assert.equal((await list(s.clients.owner)).unread, 1);
    await s.clients.owner
      .post('/api/notifications/read')
      .send({ up_to: 1_000_000 })
      .expect(200);
    assert.equal((await list(s.clients.owner)).unread, 0);
    await studentClient(t, s.code);
    assert.equal((await list(s.clients.owner)).unread, 1);
    await s.clients.owner
      .post('/api/notifications/read')
      .send({ up_to: 0 })
      .expect(200);
    assert.equal((await list(s.clients.owner)).unread, 1);
  });

  test('recipients by kind match the table, and the list agrees with ActivityService.recipients', async () => {
    const s = await scene();
    const expected: Record<ActivityKind, Person[]> = {
      member_joined: ['owner'],
      help_requested: ['owner', 'assistant'],
      submitted: ['owner', 'assistant'],
      verify_failed: ['owner', 'assistant'],
      graded: ['student'],
      commented: ['student'],
      help_replied: ['student'],
      help_resolved: ['student'],
      assignment_created: [],
      attempt_opened: [],
      hint_used: [],
    };
    for (const [kind, who] of Object.entries(expected) as [
      ActivityKind,
      Person[],
    ][]) {
      const recorded = activity.record({
        class_id: s.classId,
        actor_id: s.ids.stranger,
        student_id: s.ids.student,
        kind,
      });
      const seeing: Person[] = [];
      for (const person of PEOPLE) {
        if (
          (await list(s.clients[person])).items.some(
            (a) => a.id === recorded.id,
          )
        )
          seeing.push(person);
      }
      assert.deepEqual(seeing.sort(), [...who].sort(), kind);
      assert.deepEqual(
        activity.recipients(recorded).sort((a, b) => a - b),
        seeing.map((person) => s.ids[person]).sort((a, b) => a - b),
        `${kind}: recipients()`,
      );
    }
  });

  test('the actor does not get their own notification', async () => {
    const s = await scene();
    const recorded = activity.record({
      class_id: s.classId,
      actor_id: s.ids.owner,
      student_id: s.ids.student,
      kind: 'help_requested',
    });
    assert.ok(
      !(await list(s.clients.owner)).items.some((a) => a.id === recorded.id),
    );
    assert.ok(
      (await list(s.clients.assistant)).items.some((a) => a.id === recorded.id),
    );
  });

  test('returns the last 50, newest first, while unread counts all', async () => {
    const s = await scene();
    for (let i = 0; i < 60; i++) {
      activity.record({
        class_id: s.classId,
        actor_id: s.ids.student,
        student_id: s.ids.student,
        kind: 'help_requested',
        text: `n${i}`,
      });
    }
    const result = await list(s.clients.owner);
    assert.equal(result.items.length, 50);
    assert.equal(result.unread, 62);
    assert.equal(result.items[0]?.text, 'n59');
    assert.equal(result.items[49]?.text, 'n10');
  });

  test('a deleted class sends no notifications', async () => {
    const s = await scene();
    await s.clients.owner.delete(`/api/classes/${s.classId}`).expect(200);
    assert.deepEqual(await list(s.clients.owner), { items: [], unread: 0 });
  });
});

describe('ActivityService', () => {
  test('record publishes on activity$ only after the transaction commits', async () => {
    const s = await scene();
    const seen: Activity[] = [];
    const subscription = activity.activity$.subscribe((a) => seen.push(a));
    t.db.tx(() => {
      activity.record({
        class_id: s.classId,
        actor_id: s.ids.student,
        kind: 'hint_used',
        ref_id: 7,
        text: 'x',
      });
      assert.equal(seen.length, 0, 'not published inside the transaction');
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(
      [
        seen[0]?.kind,
        seen[0]?.ref_id,
        seen[0]?.text,
        seen[0]?.assignment_id,
        seen[0]?.at,
        seen[0]?.actor.id,
      ],
      ['hint_used', 7, 'x', null, t.clock.current, s.ids.student],
    );
    assert.throws(() =>
      t.db.tx(() => {
        activity.record({
          class_id: s.classId,
          actor_id: s.ids.student,
          kind: 'hint_used',
        });
        throw new Error('rollback');
      }),
    );
    assert.equal(seen.length, 1, 'a rolled back activity is not published');
    subscription.unsubscribe();
  });

  test('registering with an invite code publishes member_joined', async () => {
    const owner = await teacherClient(t);
    const { code } = await createClass(owner);
    const seen: Activity[] = [];
    const subscription = activity.activity$.subscribe((a) => seen.push(a));
    await studentClient(t, code, 'Нова Студентка');
    subscription.unsubscribe();
    assert.deepEqual(
      seen.map((a) => [a.kind, a.actor.name]),
      [['member_joined', 'Нова Студентка']],
    );
  });
});
