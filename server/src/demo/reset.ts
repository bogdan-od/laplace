import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../db/db';
import { journalsDir } from '../journals/journal-store';
import { parsePort } from '../port';
import { repoRoot } from '../repo-root';
import { ApiClient } from './api-client';
import { ASSISTANT, STUDENT_PASSWORD, TEACHER } from './demo-data';
import { writeDirectRows } from './direct-rows';
import { seedDemo, type Seeded } from './seed';
import { shiftTimes, type WorkSlot } from './shift-time';

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 1000;
const LOG_TAIL_CHARS = 4000;
const SAMPLE_MS = 500;
const KB = 1024;

/** When each student worked (Kyiv time): which day back and the minute of the day, 08:30..21:30 in all cases. */
const WORK_TIMES: [daysBack: number, time: string][] = [
  [2, '10:05'],
  [2, '13:40'],
  [2, '17:25'],
  [1, '11:10'],
  [1, '15:55'],
  [1, '09:20'],
  [1, '18:30'],
  [1, '12:45'],
  [2, '09:35'],
  [2, '19:05'],
  [1, '20:00'],
  [2, '15:15'],
  [2, '11:50'],
  [1, '14:35'],
  [2, '10:40'],
  [1, '10:25'],
  [2, '14:10'],
  [1, '16:20'],
  [2, '12:30'],
  [1, '19:10'],
  [2, '16:45'],
  [1, '13:05'],
  [2, '18:15'],
  [1, '17:40'],
];
const WORK_SLOTS: WorkSlot[] = WORK_TIMES.map(([daysBack, time]) => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return { daysBack, minutes: hours * 60 + minutes };
});
const FALLBACK_SLOT: WorkSlot = { daysBack: 2, minutes: 12 * 60 };

interface Sample {
  at: number;
  rssKb: number;
}

/** A field of `/proc/<pid>/status` in kB (Linux). */
function procKb(pid: number, field: string): number {
  const text = readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text);
  return match ? Number(match[1]) : 0;
}

/** Reads the server's resident memory twice a second until `stop()` is called. */
function sampleMemory(pid: number): { samples: Sample[]; stop: () => void } {
  const samples: Sample[] = [];
  const timer = setInterval(() => {
    try {
      samples.push({ at: Date.now(), rssKb: procKb(pid, 'VmRSS') });
    } catch {
      // the process is gone
    }
  }, SAMPLE_MS);
  return { samples, stop: () => clearInterval(timer) };
}

/** How long the server took over the six-machine submission and how much memory it held meanwhile. */
function netReport(
  dbFile: string,
  submissionId: number,
  samples: Sample[],
  peakKb: number,
): string {
  const db = new DatabaseSync(dbFile);
  try {
    const sub = db
      .prepare('SELECT created_at, verified_at FROM submissions WHERE id = ?')
      .get(submissionId) as { created_at: number; verified_at: number };
    const run = db
      .prepare(
        'SELECT created_at, finished_at FROM check_runs WHERE submission_id = ? ORDER BY id DESC',
      )
      .get(submissionId) as { created_at: number; finished_at: number };
    const mb = (kb: number): number => Math.round(kb / KB);
    const during = samples
      .filter((s) => s.at >= sub.created_at && s.at <= run.finished_at)
      .map((s) => s.rssKb);
    const seconds = (ms: number): string => (ms / 1000).toFixed(1);
    return (
      `Six computers on the server: journal replay ${seconds(sub.verified_at - sub.created_at)} s, ` +
      `check commands ${seconds(run.finished_at - run.created_at)} s; ` +
      `server memory (RSS) during them up to ${mb(Math.max(0, ...during))} MB, ` +
      `peak over the whole run (VmHWM) ${mb(peakKb)} MB`
    );
  } finally {
    db.close();
  }
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: HOST });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`the server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/images`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the server did not start in time');
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  if (await isListening(port)) {
    throw new Error(
      `A server already answers on port ${port} : stop it and try again`,
    );
  }
  const dbFile = process.env.LAPLACE_DB ?? join(repoRoot(), DB_FILE);
  if (dbFile === ':memory:')
    throw new Error('LAPLACE_DB=:memory: cannot be reset');
  const journals = journalsDir();
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(dbFile + suffix, { force: true });
  rmSync(journals, { recursive: true, force: true });

  const tempPort = await freePort();
  const base = `http://${HOST}:${tempPort}`;
  let log = '';
  const child = spawn(process.execPath, [join(__dirname, '..', 'main.js')], {
    env: {
      ...process.env,
      PORT: String(tempPort),
      LAPLACE_DB: dbFile,
      LAPLACE_JOURNALS: journals,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => {
    log = (log + chunk.toString()).slice(-LOG_TAIL_CHARS);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let seeded: Seeded;
  let memory: ReturnType<typeof sampleMemory> | undefined;
  let peakKb = 0;
  try {
    await waitReady(base, child);
    memory = sampleMemory(child.pid ?? 0);
    seeded = await seedDemo(new ApiClient(base));
    peakKb = procKb(child.pid ?? 0, 'VmHWM');
  } catch (error) {
    process.stderr.write(`${log}\n`);
    throw error;
  } finally {
    memory?.stop();
    await stop(child);
  }
  const net = seeded.submissions.find((info) => info.task === 'net');
  const netLine = net
    ? netReport(dbFile, net.id, memory?.samples ?? [], peakKb)
    : null;
  writeDirectRows(dbFile, seeded);
  shiftTimes(
    dbFile,
    new Map(
      seeded.students.map(
        (student, index) =>
          [student.id, WORK_SLOTS[index] ?? FALLBACK_SLOT] as const,
      ),
    ),
  );

  console.log(seeded.lines.join('\n'));
  if (netLine) console.log(netLine);
  console.log(`\nTeacher: ${TEACHER.login} / ${TEACHER.password}`);
  console.log(`Assistant: ${ASSISTANT.login} / ${ASSISTANT.password}`);
  console.log(
    `Students: ${seeded.students[0]?.login} ... ${seeded.students.at(-1)?.login} / ${STUDENT_PASSWORD}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
