import type {
  Assignment,
  Attempt,
  Branch,
  CheckCommand,
  Hint,
  JournalHeader,
  Topology,
} from '@shared/api';
import { createItem, journalText, putJournal, SINGLE } from './fixtures';
import {
  Client,
  createClass,
  studentClient,
  teacherClient,
  TestApp,
  whoAmI,
} from './helpers';

export const HEADER: JournalHeader = {
  format: 'v86-replay/9',
  profile: 'buildroot',
  seed: 7,
};

/** Event number `i` of a journal: `c` grows with `i`, `data` carries a tag and the number. */
export function ev(i: number, tag = 'e'): Record<string, unknown> {
  return { t: 'serial', c: (i + 1) * 1000, w: 0, data: `${tag}${i}` };
}

/** Events with numbers [from, to). */
export const evs = (from: number, to: number, tag = 'e'): unknown[] =>
  Array.from({ length: to - from }, (_, k) => ev(from + k, tag));

/** What the tests read out of an event to tell events apart. */
export const tags = (events: unknown[]): string[] =>
  (events as { data: string }[]).map((event) => event.data);

export interface World {
  owner: Client;
  assistant: Client;
  /** A teacher of another class. */
  stranger: Client;
  student: Client;
  classmate: Client;
  /** A student of another class. */
  outsider: Client;
  classId: number;
  assignment: Assignment;
}

export interface WorldOptions {
  topology?: Topology;
  kind?: 'task' | 'lesson';
  hints?: Hint[];
  checks?: CheckCommand[];
}

/** A class with an owner, an assistant, two students and an assignment; plus people outside it. */
export async function world(
  t: TestApp,
  options: WorldOptions = {},
): Promise<World> {
  const owner = await teacherClient(t, 'Власник');
  const assistant = await teacherClient(t, 'Асистент');
  const stranger = await teacherClient(t, 'Сторонній');
  const { id: classId, code } = await createClass(owner);
  const student = await studentClient(t, code, 'Студент');
  const classmate = await studentClient(t, code, 'Однокласник');
  const other = await createClass(stranger, '11-Б');
  const outsider = await studentClient(t, other.code, 'Чужий');
  await owner
    .post(`/api/classes/${classId}/assistants`)
    .send({ login: (await whoAmI(assistant)).login })
    .expect(201);
  const topology = options.topology ?? SINGLE;
  const item = await createItem(owner, {
    kind: options.kind ?? 'task',
    topology,
  });
  for (const machine of topology.machines) {
    await putJournal(
      owner,
      item.id,
      journalText({
        profile: machine.profile,
        lesson: options.kind === 'lesson',
      }),
      machine.id,
    );
  }
  if (options.checks) {
    await owner
      .patch(`/api/library/${item.id}`)
      .send({ checks: options.checks })
      .expect(200);
  }
  if (options.hints) {
    await owner
      .patch(`/api/library/${item.id}`)
      .send({ hints: options.hints })
      .expect(200);
  }
  const assignment = (
    await owner
      .post(`/api/library/${item.id}/assign`)
      .send({
        class_id: classId,
        due_at: null,
        max_grade: 10,
        shared_lan: false,
      })
      .expect(201)
  ).body as Assignment;
  return {
    owner,
    assistant,
    stranger,
    student,
    classmate,
    outsider,
    classId,
    assignment,
  };
}

export async function openAttempt(
  client: Client,
  assignmentId: number,
): Promise<Attempt> {
  const res = await client.post(`/api/assignments/${assignmentId}/attempt`);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`attempt not opened: ${res.status}`);
  }
  return res.body as Attempt;
}

export async function startBranch(
  client: Client,
  attemptId: number,
  node = 'm1',
  profile = 'buildroot',
): Promise<Branch> {
  const res = await client
    .post(`/api/attempts/${attemptId}/branches`)
    .send({
      node,
      parent: null,
      kind: 'start',
      header: { ...HEADER, profile },
      make_head: true,
    })
    .expect(201);
  return res.body as Branch;
}

export async function forkBranch(
  client: Client,
  attemptId: number,
  parent: { branch_id: number; event: number },
  kind: 'rollback' | 'continue' | 'reply' = 'rollback',
  makeHead = kind !== 'reply',
  node = 'm1',
): Promise<Branch> {
  const res = await client
    .post(`/api/attempts/${attemptId}/branches`)
    .send({ node, parent, kind, header: HEADER, make_head: makeHead })
    .expect(201);
  return res.body as Branch;
}

export async function putEvents(
  client: Client,
  branchId: number,
  from: number,
  events: unknown[],
  meta?: { commands: number; last_command: string },
): Promise<number> {
  const res = await client
    .put(`/api/branches/${branchId}/events`)
    .send({ from, events, ...(meta ? { meta } : {}) })
    .expect(200);
  return (res.body as { event_count: number }).event_count;
}

export async function journalOf(
  client: Client,
  branchId: number,
  to?: number,
): Promise<{ header: JournalHeader; events: unknown[] }> {
  const query = to === undefined ? '' : `?to=${to}`;
  const res = await client
    .get(`/api/branches/${branchId}/journal${query}`)
    .expect(200);
  return res.body as { header: JournalHeader; events: unknown[] };
}
