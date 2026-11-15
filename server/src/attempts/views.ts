import type {
  Branch,
  BranchKind,
  HelpRequest,
  Id,
  CheckResult,
  SubmissionChecks,
  SubmissionSummary,
  TeacherInput,
  VerifyStatus,
} from '@shared/api';
import type { Db } from '../db/db';

export interface BranchRow {
  id: Id;
  attempt_id: Id;
  node_id: string;
  parent_id: Id | null;
  fork_event: number;
  kind: BranchKind;
  author_id: Id;
  author_name: string;
  event_count: number;
  bytes: number;
  last_c: number | null;
  last_w: number | null;
  created_at: number;
  updated_at: number;
}

export const BRANCH_SELECT = `
  SELECT b.id, b.attempt_id, b.node_id, b.parent_id, b.fork_event, b.kind, b.author_id,
         u.name AS author_name, b.event_count, b.bytes, b.last_c, b.last_w, b.created_at, b.updated_at
  FROM branches b JOIN users u ON u.id = b.author_id`;

export const toBranch = (row: BranchRow): Branch => ({
  id: row.id,
  node: row.node_id,
  parent_id: row.parent_id,
  fork_event: row.fork_event,
  kind: row.kind,
  author: { id: row.author_id, name: row.author_name },
  event_count: row.event_count,
  bytes: row.bytes,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export interface HelpRow {
  id: Id;
  attempt_id: Id;
  assignment_id: Id;
  class_id: Id;
  student_id: Id;
  student_name: string;
  node: string;
  branch_id: Id;
  event_count: number;
  text: string;
  created_at: number;
  resolved_at: number | null;
  reply_branch_id: Id | null;
}

export const HELP_SELECT = `
  SELECT h.id, h.attempt_id, a.assignment_id, s.class_id, a.user_id AS student_id,
         u.name AS student_name, h.node_id AS node, h.branch_id, h.event_count, h.text,
         h.created_at, h.resolved_at, h.reply_branch_id
  FROM help_requests h
  JOIN attempts a ON a.id = h.attempt_id
  JOIN assignments s ON s.id = a.assignment_id
  JOIN users u ON u.id = a.user_id`;

export const toHelp = (row: HelpRow): HelpRequest => ({
  id: row.id,
  attempt_id: row.attempt_id,
  assignment_id: row.assignment_id,
  class_id: row.class_id,
  student: { id: row.student_id, name: row.student_name },
  node: row.node,
  branch_id: row.branch_id,
  event_count: row.event_count,
  text: row.text,
  created_at: row.created_at,
  resolved_at: row.resolved_at,
  reply_branch_id: row.reply_branch_id,
});

export interface SubmissionRow {
  id: Id;
  attempt_id: Id;
  created_at: number;
  verify_status: VerifyStatus;
  grade: number | null;
}

export const SUBMISSION_SELECT =
  'SELECT id, attempt_id, created_at, verify_status, grade FROM submissions';

export const toSubmissionSummary = (
  row: SubmissionRow,
  checks: SubmissionChecks | null = null,
): SubmissionSummary => ({
  id: row.id,
  attempt_id: row.attempt_id,
  created_at: row.created_at,
  verify_status: row.verify_status,
  grade: row.grade,
  checks,
});

/**
 * The result of the latest finished (`done`) check run of each given submission, in one query.
 * Submissions without such a run, or whose run had no commands, are absent from the map.
 */
export function latestChecks(
  db: Db,
  submissionIds: readonly Id[],
): Map<Id, SubmissionChecks> {
  const found = new Map<Id, SubmissionChecks>();
  if (submissionIds.length === 0) return found;
  const marks = submissionIds.map(() => '?').join(', ');
  const rows = db.all<{ submission_id: Id; results: string }>(
    `SELECT submission_id, results FROM check_runs
     WHERE status = 'done' AND submission_id IN (${marks})
       AND id = (SELECT MAX(r.id) FROM check_runs r
                 WHERE r.submission_id = check_runs.submission_id AND r.status = 'done')`,
    ...submissionIds,
  );
  for (const row of rows) {
    const results = JSON.parse(row.results) as CheckResult[];
    if (results.length === 0) continue;
    found.set(row.submission_id, {
      passed: results.filter((result) => result.rc === 0).length,
      total: results.length,
    });
  }
  return found;
}

/** Summaries of `rows` for a teacher: with the result of the check runs, fetched for all rows at once. */
export function teacherSummaries(
  db: Db,
  rows: readonly SubmissionRow[],
): SubmissionSummary[] {
  const checks = latestChecks(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    toSubmissionSummary(row, checks.get(row.id) ?? null),
  );
}

/** What teachers typed into the student's machines in the assignment (the log is per assignment and student). */
export function teacherInputsOf(
  db: Db,
  assignmentId: Id,
  studentId: Id,
): TeacherInput[] {
  return db
    .all<{
      node_id: string;
      port: 0 | 2;
      data: string;
      author_id: Id;
      author_name: string;
      received_at: number;
    }>(
      `SELECT i.node_id, i.port, i.data, i.author_id, u.name AS author_name, i.received_at
       FROM teacher_inputs i JOIN users u ON u.id = i.author_id
       WHERE i.assignment_id = ? AND i.student_id = ? ORDER BY i.received_at, i.id`,
      assignmentId,
      studentId,
    )
    .map((row) => ({
      node: row.node_id,
      port: row.port,
      data: row.data,
      author: { id: row.author_id, name: row.author_name },
      received_at: row.received_at,
    }));
}
