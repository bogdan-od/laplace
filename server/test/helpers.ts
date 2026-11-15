import { Logger } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { VerifyQueue } from '../src/attempts/verify-queue';
import { Clock } from '../src/common/clock';
import { Db } from '../src/db/db';
import { configureApp } from '../src/setup';

Logger.overrideLogger(false);

/** A clock the test moves by hand. */
export class TestClock extends Clock {
  current = 1_700_000_000_000;

  override now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestApp {
  app: NestExpressApplication;
  clock: TestClock;
  db: Db;
  /** Where this app keeps journal files. */
  journalDir: string;
  /** A new client with its own cookie jar. */
  client: () => ReturnType<typeof request.agent>;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * Keep the real verification queue, which replays journals in worker threads (seconds and
   * hundreds of megabytes per journal). By default submissions are only recorded, as the tests
   * that are not about verification expect. Files that set this must not run in parallel with each other.
   */
  runner?: boolean;
  /** An SQLite file instead of the in-memory database, so a second app can open the same data. */
  dbFile?: string;
  /** An existing journals directory; the caller removes it. */
  journalDir?: string;
  /** The directory served as the front end; by default the real `web/dist`. */
  webDist?: string;
}

const NO_VERIFICATION = { enqueue: (): void => undefined };

/** The whole app on an in-memory database, configured like main.ts. */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  process.env.LAPLACE_DB = options.dbFile ?? ':memory:';
  const journalDir =
    options.journalDir ?? mkdtempSync(join(tmpdir(), 'laplace-journals-'));
  mkdirSync(journalDir, { recursive: true });
  process.env.LAPLACE_JOURNALS = journalDir;
  const clock = new TestClock();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = module.createNestApplication<NestExpressApplication>();
  configureApp(app, options.webDist);
  await app.init();
  if (!options.runner) app.get(VerifyQueue).use(NO_VERIFICATION);
  const server = app.getHttpServer() as Parameters<typeof request.agent>[0];
  return {
    app,
    clock,
    db: app.get(Db),
    journalDir,
    client: () => request.agent(server),
    close: async () => {
      await app.close();
      if (options.journalDir === undefined) {
        rmSync(journalDir, { recursive: true, force: true });
      }
    },
  };
}

export type Client = ReturnType<TestApp['client']>;

let counter = 0;

/** Registers a teacher and returns the logged-in client. */
export async function teacherClient(
  t: TestApp,
  name = 'Вчитель',
): Promise<Client> {
  const client = t.client();
  counter++;
  await client
    .post('/api/auth/register')
    .send({
      login: `teacher${counter}`,
      password: 'password123',
      name,
      role: 'teacher',
    })
    .expect(201);
  return client;
}

/** Registers a student with an invite code and returns the logged-in client. */
export async function studentClient(
  t: TestApp,
  inviteCode: string,
  name = 'Студент',
): Promise<Client> {
  const client = t.client();
  counter++;
  await client
    .post('/api/auth/register')
    .send({
      login: `student${counter}`,
      password: 'password123',
      name,
      role: 'student',
      invite_code: inviteCode,
    })
    .expect(201);
  return client;
}

/** Creates a class and returns its id and invite code. */
export async function createClass(
  teacher: Client,
  name = '10-А',
): Promise<{ id: number; code: string }> {
  const res = await teacher
    .post('/api/classes')
    .send({ name, subject: 'Інформатика' })
    .expect(201);
  const body = res.body as { id: number; invite_code: string };
  return { id: body.id, code: body.invite_code };
}

export interface Json {
  [key: string]: unknown;
}

/** Response body as an object; tests check the fields they use. */
export const body = (res: { body: unknown }): Json => res.body as Json;

export async function whoAmI(
  client: Client,
): Promise<{ id: number; login: string; name: string; role: string }> {
  const res = await client.get('/api/me').expect(200);
  return res.body as { id: number; login: string; name: string; role: string };
}

/** Inserts students straight into the database (a full class without 254 HTTP calls). */
export function fillStudents(t: TestApp, classId: number, count: number): void {
  t.db.tx(() => {
    const taken = new Set(
      t.db
        .all<{ number: number }>(
          "SELECT number FROM class_members WHERE class_id = ? AND role = 'student'",
          classId,
        )
        .map((row) => row.number),
    );
    let number = 0;
    for (let i = 0; i < count; i++) {
      do number++;
      while (taken.has(number));
      const { id } = t.db.run(
        "INSERT INTO users (login, password_hash, name, role, created_at) VALUES (?, 'x', ?, 'student', 0)",
        `filler${classId}_${number}`,
        `Filler ${number}`,
      );
      t.db.run(
        "INSERT INTO class_members (class_id, user_id, role, number, joined_at) VALUES (?, ?, 'student', ?, 0)",
        classId,
        id,
        number,
      );
    }
  });
}
