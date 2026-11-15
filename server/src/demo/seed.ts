import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Journal } from '@core/core/journal.mjs';
import type {
  Assignment,
  CheckRun,
  ClassDetail,
  HelpRequest,
  LibraryItem,
  Me,
  Submission,
} from '@shared/api';
import { journalCore } from '../core';
import { repoRoot } from '../repo-root';
import { ApiClient } from './api-client';
import { END_OF_DAY_MINUTES, kyivInstant } from './kyiv-time';
import {
  ASSISTANT,
  CLASS_NAME,
  CLASS_SUBJECT,
  DEMO_JOURNALS_DIR,
  MARKS_FILE,
  OS_CLASS_NAME,
  OS_CLASS_SUBJECT,
  OS_STUDENT_NAMES,
  STUDENT_NAMES,
  STUDENT_PASSWORD,
  TEACHER,
  studentLogin,
  type DemoTask,
} from './demo-data';
import { KN_RUNS, OS_RUNS, type AssignmentRun, type Plan } from './demo-plans';

const POLL_MS = 500;
const WAIT_MS = 5 * 60_000;
const MAX_GRADE = 10;
const GOOD_STEPS_BEFORE_PROGRESS = 2;
const HELP_TEXT = 'Не працює, не розумію, що не так';
const LESSON_COMPLETED = 4;
const LESSON_OPENED = 6;
const CLIP_TITLE = 'Фрагмент: звіт про версію ядра';
/** The clip starts at this step of the "config" recording. */
const CLIP_FROM_STEP = 2;

export interface Account {
  id: number;
  login: string;
  name: string;
  cookie: string;
}

export interface SubmissionInfo {
  task: string;
  login: string;
  id: number;
  good: boolean;
}

export interface Seeded {
  teacher: Account;
  assistant: Account;
  /** Students of both classes: first КН-31, then ОС-21. */
  students: Account[];
  /** Ids of the assignments by `AssignmentRun.key`. */
  assignments: Record<string, number>;
  submissions: SubmissionInfo[];
  lines: string[];
}

interface Marks {
  [scenario: string]: Record<string, number>[] | undefined;
}

interface Head {
  node: string;
  branch_id: number;
  event_count: number;
}

interface Planned {
  info: SubmissionInfo;
  plan: Plan;
  heads: Head[];
}

async function until<T>(
  what: string,
  job: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await job();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timeout waiting for ${what}`);
}

class Seeder {
  private readonly dir = join(repoRoot(), DEMO_JOURNALS_DIR);
  private readonly marks = JSON.parse(
    readFileSync(join(this.dir, MARKS_FILE), 'utf8'),
  ) as Marks;
  private readonly planned: Planned[] = [];
  private readonly assignmentIds: Record<string, number> = {};
  private readonly itemIds: Record<string, number> = {};
  private teacher!: Account;
  private knStudents: Account[] = [];
  private osStudents: Account[] = [];
  private settled = 0;

  constructor(private readonly api: ApiClient) {}

  async run(): Promise<Seeded> {
    this.teacher = await this.register(TEACHER, 'teacher');
    const assistant = await this.register(ASSISTANT, 'teacher');
    const kn = await this.createClass(CLASS_NAME, CLASS_SUBJECT);
    const os = await this.createClass(OS_CLASS_NAME, OS_CLASS_SUBJECT);
    await this.post(
      `/api/classes/${kn.id}/assistants`,
      { login: ASSISTANT.login },
      this.teacher,
    );
    this.knStudents = await this.enroll(STUDENT_NAMES, 0, kn);
    this.osStudents = await this.enroll(
      OS_STUDENT_NAMES,
      STUDENT_NAMES.length,
      os,
    );
    for (const run of KN_RUNS) await this.assignRun(run, kn.id);
    for (const run of OS_RUNS) await this.assignRun(run, os.id);

    await this.runLesson(this.assignmentIds.lesson ?? 0);
    const early = ['config', 'link'];
    for (const key of early) await this.runKey(key, KN_RUNS, this.knStudents);
    await this.settle(this.idsOf(early));
    // The six machines go alone, so the time and memory of their replay on the server can be read off.
    await this.runKey('net', KN_RUNS, this.knStudents);
    await this.settle(this.idsOf(['net']));
    const late = ['vlan', 'fw', 'ospf', 'ssh'];
    for (const key of late) await this.runKey(key, KN_RUNS, this.knStudents);
    const osKeys = OS_RUNS.map((run) => run.key);
    for (const key of osKeys) await this.runKey(key, OS_RUNS, this.osStudents);
    await this.settle(this.idsOf([...late, ...osKeys]));
    await this.grade();
    await this.publishLibrary();

    const lines = await this.summary();
    return {
      teacher: this.teacher,
      assistant,
      students: [...this.knStudents, ...this.osStudents],
      assignments: this.assignmentIds,
      submissions: this.planned.map((item) => item.info),
      lines,
    };
  }

  private post<T>(path: string, body: unknown, who: Account): Promise<T> {
    return this.api
      .call<T>('POST', path, body, who.cookie)
      .then((reply) => reply.json);
  }

  private async register(
    person: { login: string; password: string; name: string },
    role: 'teacher' | 'student',
    inviteCode?: string,
  ): Promise<Account> {
    const reply = await this.api.call<Me>('POST', '/api/auth/register', {
      ...person,
      role,
      ...(inviteCode ? { invite_code: inviteCode } : {}),
    });
    if (!reply.cookie) throw new Error(`no session cookie for ${person.login}`);
    return {
      id: reply.json.id,
      login: person.login,
      name: person.name,
      cookie: reply.cookie,
    };
  }

  private createClass(name: string, subject: string): Promise<ClassDetail> {
    return this.post<ClassDetail>(
      '/api/classes',
      { name, subject },
      this.teacher,
    );
  }

  /** Registers the students with logins numbered from `firstIndex` through the class's invite code. */
  private async enroll(
    names: readonly string[],
    firstIndex: number,
    klass: ClassDetail,
  ): Promise<Account[]> {
    const accounts: Account[] = [];
    for (const [offset, name] of names.entries()) {
      accounts.push(
        await this.register(
          {
            login: studentLogin(firstIndex + offset),
            password: STUDENT_PASSWORD,
            name,
          },
          'student',
          klass.invite_code ?? undefined,
        ),
      );
    }
    return accounts;
  }

  /** The recorder names every machine "demo"; a live machine writes its node id, and the pcap button relies on it. */
  private journal(name: string, node: string): Journal {
    const journal = JSON.parse(
      readFileSync(join(this.dir, `${name}.${node}.json`), 'utf8'),
    ) as Journal;
    journal.header.machine = node;
    return journal;
  }

  private idsOf(keys: string[]): number[] {
    return keys.map((key) => this.assignmentIds[key] ?? 0);
  }

  private async assignRun(run: AssignmentRun, classId: number): Promise<void> {
    const due = kyivInstant(Date.now(), run.dueDays, END_OF_DAY_MINUTES);
    const startJournal =
      run.task.kind === 'lesson' ? this.journal('lesson', 'm1') : undefined;
    const assignment = await this.assign(run.task, classId, due, startJournal);
    this.assignmentIds[run.key] = assignment.id;
    this.itemIds[run.key] = assignment.item_id;
  }

  private async assign(
    task: DemoTask,
    classId: number,
    dueAt: number,
    startJournal?: Journal,
  ): Promise<Assignment> {
    const t = this.teacher;
    const item = await this.post<LibraryItem>(
      '/api/library',
      {
        kind: task.kind,
        title: task.title,
        brief: task.brief,
        topology: task.topology,
      },
      t,
    );
    if (task.checks.length > 0 || task.hints.length > 0) {
      await this.api.call(
        'PATCH',
        `/api/library/${item.id}`,
        { checks: task.checks, hints: task.hints },
        t.cookie,
      );
    }
    if (startJournal) {
      await this.api.call(
        'PUT',
        `/api/library/${item.id}/journals/m1?role=start`,
        startJournal,
        t.cookie,
      );
    }
    return this.post<Assignment>(
      `/api/library/${item.id}/assign`,
      {
        class_id: classId,
        due_at: dueAt,
        max_grade: MAX_GRADE,
        shared_lan: false,
      },
      t,
    );
  }

  private runKey(
    key: string,
    runs: AssignmentRun[],
    students: Account[],
  ): Promise<void> {
    const run = runs.find((item) => item.key === key);
    if (!run?.scenario || !run.plan)
      throw new Error(`assignment ${key} has no plan`);
    return this.runPlan(key, run, students);
  }

  private async runPlan(
    key: string,
    run: AssignmentRun,
    students: Account[],
  ): Promise<void> {
    const scenario = run.scenario ?? key;
    const nodes = run.task.topology.machines.map((machine) => machine.id);
    for (const [index, plan] of (run.plan ?? []).entries()) {
      const student = students[index];
      if (!student || plan.outcome === 'none') continue;
      await this.work(
        scenario,
        this.assignmentIds[key] ?? 0,
        nodes,
        plan,
        student,
      );
    }
  }

  /** One student's attempt: branches with the recorded events, then the help request or the submission. */
  private async work(
    scenario: string,
    assignmentId: number,
    nodes: string[],
    plan: Plan,
    student: Account,
  ): Promise<void> {
    const name = `${scenario}-${plan.good ? 'good' : 'bad'}`;
    const marks = this.marks[name];
    if (!marks) throw new Error(`no marks for ${name}: run demo:record`);
    const partial = plan.outcome === 'progress' || plan.outcome === 'answered';
    const upTo = (node: string): number =>
      marks[partial ? GOOD_STEPS_BEFORE_PROGRESS : marks.length - 1]?.[node] ??
      0;
    const attempt = await this.post<{ id: number }>(
      `/api/assignments/${assignmentId}/attempt`,
      undefined,
      student,
    );
    const heads: Head[] = [];
    for (const node of nodes) {
      const journal = this.journal(name, node);
      const count = partial ? upTo(node) : journal.events.length;
      heads.push(
        plan.rollback?.node === node
          ? await this.rolledBack(
              attempt.id,
              node,
              journal,
              marks,
              plan,
              student,
            )
          : await this.startBranch(attempt.id, node, journal, count, student),
      );
    }
    if (plan.hint !== undefined)
      await this.post(
        `/api/attempts/${attempt.id}/hints/${plan.hint}`,
        undefined,
        student,
      );
    const head = heads[0];
    if (plan.outcome === 'help' || plan.outcome === 'answered') {
      if (!head) throw new Error('no head for the help request');
      const help = await this.post<HelpRequest>(
        `/api/attempts/${attempt.id}/help`,
        { ...head, text: HELP_TEXT },
        student,
      );
      if (plan.outcome === 'answered')
        await this.reply(attempt.id, help, head, this.journal(name, head.node));
    }
    if (plan.outcome === 'waiting' || plan.outcome === 'graded') {
      const submission = await this.post<{ id: number }>(
        `/api/attempts/${attempt.id}/submit`,
        { heads },
        student,
      );
      this.planned.push({
        info: {
          task: scenario,
          login: student.login,
          id: submission.id,
          good: plan.good,
        },
        plan,
        heads,
      });
    }
  }

  private async startBranch(
    attemptId: number,
    node: string,
    journal: Journal,
    count: number,
    student: Account,
  ): Promise<Head> {
    const branch = await this.post<{ id: number }>(
      `/api/attempts/${attemptId}/branches`,
      {
        node,
        parent: null,
        kind: 'start',
        header: journal.header,
        make_head: true,
      },
      student,
    );
    const events = journal.events.slice(0, count);
    await this.api.call(
      'PUT',
      `/api/branches/${branch.id}/events`,
      { from: 0, events, meta: commandsMeta(events) },
      student.cookie,
    );
    return { node, branch_id: branch.id, event_count: count };
  }

  /**
   * The first branch stops at the moment before `abandonAt`, the second one starts at the moment before `forkAt`
   * and takes the recorded events from there to the end, so the full journal of the second one is the recorded one.
   */
  private async rolledBack(
    attemptId: number,
    node: string,
    journal: Journal,
    marks: Record<string, number>[],
    plan: Plan,
    student: Account,
  ): Promise<Head> {
    const rollback = plan.rollback;
    if (!rollback) throw new Error('no rollback in the plan');
    const abandoned = await this.startBranch(
      attemptId,
      node,
      journal,
      marks[rollback.abandonAt]?.[node] ?? 0,
      student,
    );
    const fork = marks[rollback.forkAt]?.[node] ?? 0;
    const branch = await this.post<{ id: number }>(
      `/api/attempts/${attemptId}/branches`,
      {
        node,
        parent: { branch_id: abandoned.branch_id, event: fork },
        kind: 'rollback',
        header: journal.header,
        make_head: true,
      },
      student,
    );
    await this.api.call(
      'PUT',
      `/api/branches/${branch.id}/events`,
      {
        from: fork,
        events: journal.events.slice(fork),
        meta: commandsMeta(journal.events),
      },
      student.cookie,
    );
    return { node, branch_id: branch.id, event_count: journal.events.length };
  }

  /** The teacher's answer: a branch from the moment of the request that carries on with the recorded commands. */
  private async reply(
    attemptId: number,
    help: HelpRequest,
    head: Head,
    journal: Journal,
  ): Promise<void> {
    const t = this.teacher;
    const branch = await this.post<{ id: number }>(
      `/api/attempts/${attemptId}/branches`,
      {
        node: head.node,
        parent: { branch_id: head.branch_id, event: head.event_count },
        kind: 'reply',
        header: journal.header,
        make_head: false,
      },
      t,
    );
    await this.api.call(
      'PUT',
      `/api/branches/${branch.id}/events`,
      {
        from: head.event_count,
        events: journal.events.slice(head.event_count),
      },
      t.cookie,
    );
    await this.post(`/api/help/${help.id}/reply`, { branch_id: branch.id }, t);
  }

  private async runLesson(assignmentId: number): Promise<void> {
    for (const [index, student] of this.knStudents
      .slice(0, LESSON_OPENED)
      .entries()) {
      const attempt = await this.post<{ id: number }>(
        `/api/assignments/${assignmentId}/attempt`,
        undefined,
        student,
      );
      if (index < LESSON_COMPLETED)
        await this.post(
          `/api/attempts/${attempt.id}/complete`,
          undefined,
          student,
        );
    }
  }

  /** Waits for the server's replay and the teacher's checks of the submissions made since the last call. */
  private async settle(checkedAssignments: number[]): Promise<void> {
    const t = this.teacher;
    const fresh = this.planned.slice(this.settled).map((item) => item.info);
    this.settled = this.planned.length;
    for (const info of fresh) {
      await until(`verification of submission ${info.id}`, async () => {
        const status = (await this.detail(info.id)).verify_status;
        return status === 'queued' || status === 'running' ? null : status;
      });
    }
    for (const id of checkedAssignments)
      await this.post(`/api/assignments/${id}/check-all`, undefined, t);
    const finished = (run: CheckRun): boolean =>
      run.status === 'done' || run.status === 'failed';
    for (const info of fresh) {
      await until(`check run of submission ${info.id}`, async () => {
        const runs = (await this.detail(info.id)).check_runs;
        return runs.length > 0 && runs.every(finished) ? runs : null;
      });
    }
  }

  private async detail(id: number): Promise<Submission> {
    const reply = await this.api.call<Submission>(
      'GET',
      `/api/submissions/${id}`,
      undefined,
      this.teacher.cookie,
    );
    return reply.json;
  }

  private async summary(): Promise<string[]> {
    const lines: string[] = [];
    for (const { info } of this.planned) {
      const sub = await this.detail(info.id);
      const run = sub.check_runs.at(-1);
      const passed =
        run?.results.filter((result) => result.rc === 0).length ?? 0;
      lines.push(
        `${info.task} ${info.login}: replay ${sub.verify_status}, checks ${passed}/${run?.results.length ?? 0}, grade ${sub.grade ?? '-'}`,
      );
    }
    lines.push(tally(lines));
    return lines;
  }

  private async grade(): Promise<void> {
    const t = this.teacher;
    for (const { info, plan } of this.planned) {
      if (plan.outcome !== 'graded') continue;
      await this.api.call(
        'PUT',
        `/api/submissions/${info.id}/grade`,
        { grade: plan.grade, note: plan.note },
        t.cookie,
      );
      for (const comment of plan.comments ?? []) {
        const name = `${info.task}-${info.good ? 'good' : 'bad'}`;
        const marks = this.marks[name] ?? [];
        const step =
          comment.step < 0 ? marks.length + comment.step : comment.step;
        const eventIndex = marks[step]?.[comment.node] ?? 0;
        const times = journalCore().event_times(
          this.journal(name, comment.node),
        );
        await this.api.call(
          'POST',
          `/api/submissions/${info.id}/comments`,
          {
            node: comment.node,
            event_index: eventIndex,
            vtime_ms: Math.round(times[eventIndex] ?? 0),
            text: comment.text,
          },
          t.cookie,
        );
      }
    }
  }

  /** The lesson goes public, and a clip of the first graded "config" submission becomes a public item. */
  private async publishLibrary(): Promise<void> {
    const t = this.teacher;
    await this.post(`/api/library/${this.itemIds.lesson}/embed`, undefined, t);
    const source = this.planned.find((item) => item.info.task === 'config');
    const head = source?.heads[0];
    if (!source || !head) throw new Error('no config submission for the clip');
    const name = `config-${source.info.good ? 'good' : 'bad'}`;
    const from = this.marks[name]?.[CLIP_FROM_STEP]?.m1 ?? 0;
    const times = journalCore().event_times(this.journal(name, 'm1'));
    const clip = await this.post<LibraryItem>(
      '/api/library/clip',
      {
        branch_id: head.branch_id,
        to_event: head.event_count,
        from_ms: Math.round(times[from] ?? 0),
        title: CLIP_TITLE,
      },
      t,
    );
    await this.post(`/api/library/${clip.id}/embed`, undefined, t);
  }
}

/** One line: how many submissions ended in which replay status and with which check outcome. */
/** What the web client sends with a chunk for the teacher's tile (web/src/machine/journal-sync.ts, commandsMeta). */
function commandsMeta(events: Journal['events']): {
  commands: number;
  last_command: string;
} {
  const own = journalCore()
    .commands(events)
    .filter((command) => command.by === 'student' && command.port === 0);
  return { commands: own.length, last_command: own.at(-1)?.text ?? '' };
}

function tally(lines: string[]): string {
  const count = (pattern: RegExp): number =>
    lines.filter((line) => pattern.test(line)).length;
  const full = lines.filter((line) => {
    const match = /checks (\d+)\/(\d+)/.exec(line);
    return match !== null && match[1] === match[2];
  }).length;
  const none = count(/checks 0\//);
  return `Total ${lines.length} submissions: replay ok ${count(/replay ok/)}, other ${count(/replay (?!ok)/)}; checks passed fully ${full}, partly ${lines.length - full - none}, not passed ${none}`;
}

export function seedDemo(api: ApiClient): Promise<Seeded> {
  return new Seeder(api).run();
}
