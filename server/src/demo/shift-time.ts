import { DatabaseSync } from 'node:sqlite';
import { isDaytime, kyivInstant, kyivText } from './kyiv-time';

/** The shared rows (users, classes, assignments) are moved this many days back, so the class "existed" before the students worked. */
const INFRA_DAYS = 4;
const INFRA_MINUTES = 9 * 60 + 15;
/** Deadlines and session expiry are not moments of work, so the daytime rule does not apply to them. */
const NOT_WORK_TIME = new Set(['due_at', 'expires_at']);

/** When a student worked: `daysBack` Kyiv days before today, from `minutes` since the Kyiv midnight. */
export interface WorkSlot {
  daysBack: number;
  minutes: number;
}

interface Scope {
  table: string;
  /** SQL condition with one `?` for the student's user id. */
  where: string;
}

const OF_STUDENT = 'SELECT id FROM attempts WHERE user_id = ?';
const SUBMISSIONS_OF_STUDENT = `SELECT id FROM submissions WHERE attempt_id IN (${OF_STUDENT})`;
const SCOPES: Scope[] = [
  { table: 'attempts', where: 'user_id = ?' },
  { table: 'branches', where: `attempt_id IN (${OF_STUDENT})` },
  {
    table: 'chunks',
    where: `branch_id IN (SELECT id FROM branches WHERE attempt_id IN (${OF_STUDENT}))`,
  },
  { table: 'help_requests', where: `attempt_id IN (${OF_STUDENT})` },
  { table: 'hint_uses', where: `attempt_id IN (${OF_STUDENT})` },
  { table: 'submissions', where: `attempt_id IN (${OF_STUDENT})` },
  { table: 'comments', where: `submission_id IN (${SUBMISSIONS_OF_STUDENT})` },
  {
    table: 'check_runs',
    where: `submission_id IN (${SUBMISSIONS_OF_STUDENT})`,
  },
  { table: 'activity', where: 'COALESCE(student_id, actor_id) = ?' },
  { table: 'teacher_inputs', where: 'student_id = ?' },
  { table: 'lti_grade_links', where: 'user_id = ?' },
];

/** Timestamp columns; `due_at` is a deadline set relative to the reset moment and stays where it is. */
function timeColumns(db: DatabaseSync): Map<string, string[]> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const result = new Map<string, string[]>();
  for (const { name } of tables) {
    const columns = (
      db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
    )
      .map((column) => column.name)
      .filter(
        (column) =>
          (column === 'at' || column.endsWith('_at')) && column !== 'due_at',
      );
    if (columns.length > 0) result.set(name, columns);
  }
  return result;
}

/** The earliest time in the database: the moment seeding began. */
function firstMoment(db: DatabaseSync, columns: Map<string, string[]>): number {
  let first = Infinity;
  for (const [table, names] of columns) {
    for (const name of names) {
      const row = db
        .prepare(`SELECT MIN(${name}) AS first FROM ${table}`)
        .get() as { first: number | null };
      if (row.first !== null) first = Math.min(first, row.first);
    }
  }
  if (!Number.isFinite(first)) throw new Error('the database has no times');
  return first;
}

/** Fails when a row of work falls outside the daytime (08:30..21:30 Kyiv). */
function requireDaytime(
  db: DatabaseSync,
  columns: Map<string, string[]>,
): void {
  for (const [table, names] of columns) {
    for (const name of names) {
      if (NOT_WORK_TIME.has(name)) continue;
      const rows = db
        .prepare(
          `SELECT ${name} AS value FROM ${table} WHERE ${name} IS NOT NULL`,
        )
        .all() as { value: number }[];
      const night = rows.find((row) => !isDaytime(row.value));
      if (night)
        throw new Error(
          `${table}.${name} = ${kyivText(night.value)} Kyiv is outside 08:30..21:30`,
        );
    }
  }
}

const MS_PER_MINUTE = 60_000;
/**
 * How long a demo student "worked" before the first submission, in minutes, taken in turn by attempt.
 * Seeding submits within seconds of opening; the analytics table would show the same time for everybody.
 * The longest one stays under the margin between the earliest work slot and 08:30.
 */
export const WORK_MINUTES = [
  0.7, 4, 7.5, 9, 12, 15.5, 18, 21, 26, 31, 38, 11, 6, 24,
];

/** Opening moment of an attempt that has a submission: `minutes` before the first submission. */
export function openingBefore(firstSubmitted: number, index: number): number {
  const minutes =
    WORK_MINUTES[index % WORK_MINUTES.length] ?? WORK_MINUTES[0] ?? 1;
  return firstSubmitted - Math.round(minutes * MS_PER_MINUTE);
}

/** Moves "opened" of every submitted student attempt back, so the time to submit differs between students. */
function spreadOpenings(db: DatabaseSync): void {
  const attempts = db
    .prepare(
      `SELECT a.id AS id, MIN(s.created_at) AS first
       FROM attempts a JOIN submissions s ON s.attempt_id = a.id
       WHERE a.is_preview = 0 GROUP BY a.id ORDER BY a.id`,
    )
    .all() as { id: number; first: number }[];
  const update = db.prepare('UPDATE attempts SET created_at = ? WHERE id = ?');
  attempts.forEach(({ id, first }, index) => {
    update.run(openingBefore(first, index), id);
  });
}

/**
 * Moves the rows of a freshly seeded database into the past (the server must be stopped). Seeding
 * takes minutes, so each group of rows keeps its offsets from the first moment and moves as a whole:
 * the shared rows to `INFRA_DAYS` ago, the work of each student to its own `WorkSlot`. The order of
 * events inside an attempt stays; all times end up in 08:30..21:30 Kyiv, which is checked at the end.
 * Nothing on the server compares these times with the journals (the journals carry their own
 * virtual time).
 */
export function shiftTimes(
  dbFile: string,
  slots: ReadonlyMap<number, WorkSlot>,
  now = Date.now(),
): void {
  const db = new DatabaseSync(dbFile);
  try {
    const columns = timeColumns(db);
    const first = firstMoment(db, columns);
    const infra = kyivInstant(now, -INFRA_DAYS, INFRA_MINUTES) - first;
    db.exec('BEGIN');
    for (const [table, names] of columns) {
      const sets = names
        .map((name) => `${name} = ${name} + ${infra}`)
        .join(', ');
      db.exec(`UPDATE ${table} SET ${sets}`);
    }
    for (const [studentId, slot] of slots) {
      const own =
        kyivInstant(now, -slot.daysBack, slot.minutes) - first - infra;
      for (const { table, where } of SCOPES) {
        const names = columns.get(table) ?? [];
        if (names.length === 0) continue;
        const sets = names
          .map((name) => `${name} = ${name} + ${own}`)
          .join(', ');
        db.prepare(`UPDATE ${table} SET ${sets} WHERE ${where}`).run(studentId);
      }
    }
    spreadOpenings(db);
    requireDaytime(db, columns);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
