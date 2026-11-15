import { Injectable } from '@nestjs/common';
import type { Id, StudentProgress, TileStatus } from '@shared/api';
import type {
  AssignmentProgress,
  HintUsesProvider,
  ProgressProvider,
} from '../assignments/providers';
import { isTeacherRole } from '../classes/access.service';
import type { ClassViewer } from '../classes/class-stats';
import { Db } from '../db/db';
import {
  HELP_SELECT,
  HelpRow,
  SUBMISSION_SELECT,
  SubmissionRow,
  teacherSummaries,
  toHelp,
} from './views';

/**
 * Tile status of an attempt `t`: a submission or a finished lesson is
 * `done`; otherwise an open help request is `stuck`; otherwise an attempt exists, `work`. A student
 * without an attempt (`t.id IS NULL`) is `idle`. Nothing else colours a tile.
 */
const STATUS_SQL = `
  CASE
    WHEN t.id IS NULL THEN 'idle'
    WHEN t.completed_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM submissions s WHERE s.attempt_id = t.id) THEN 'done'
    WHEN EXISTS (SELECT 1 FROM help_requests h
                 WHERE h.attempt_id = t.id AND h.resolved_at IS NULL) THEN 'stuck'
    ELSE 'work'
  END`;

/** The latest submission of attempt `t` has no grade yet. */
const UNGRADED_SQL = `
  EXISTS (SELECT 1 FROM submissions s
          WHERE s.attempt_id = t.id AND s.grade IS NULL
            AND s.id = (SELECT MAX(id) FROM submissions WHERE attempt_id = t.id))`;

const EMPTY_COUNTS: Record<TileStatus, number> = {
  stuck: 0,
  work: 0,
  done: 0,
  idle: 0,
};

/**
 * What the assignments and classes pages show about attempts. Teacher previews are never counted:
 * only attempts of current students of the class are.
 */
@Injectable()
export class AttemptProgress implements ProgressProvider, HintUsesProvider {
  constructor(private readonly db: Db) {}

  assignment(assignmentId: Id, viewer: ClassViewer): AssignmentProgress {
    return isTeacherRole(viewer.role)
      ? this.forTeacher(assignmentId)
      : this.forStudent(assignmentId, viewer.userId);
  }

  classCounters(
    classId: Id,
    viewer: ClassViewer,
  ): { to_review: number; open_help: number } {
    if (!isTeacherRole(viewer.role)) return { to_review: 0, open_help: 0 };
    const row = this.db.get<{ to_review: number; open_help: number }>(
      `SELECT
         (SELECT COUNT(*) FROM attempts t
            JOIN assignments a ON a.id = t.assignment_id
            JOIN class_members m ON m.class_id = a.class_id AND m.user_id = t.user_id
                                AND m.role = 'student'
          WHERE a.class_id = ?1 AND a.deleted_at IS NULL AND t.is_preview = 0
            AND ${UNGRADED_SQL}) AS to_review,
         (SELECT COUNT(*) FROM help_requests h
            JOIN attempts t ON t.id = h.attempt_id
            JOIN assignments a ON a.id = t.assignment_id
            JOIN class_members m ON m.class_id = a.class_id AND m.user_id = t.user_id
                                AND m.role = 'student'
          WHERE a.class_id = ?1 AND a.deleted_at IS NULL AND t.is_preview = 0
            AND h.resolved_at IS NULL) AS open_help`,
      classId,
    );
    return row ?? { to_review: 0, open_help: 0 };
  }

  student(assignmentId: Id, userId: Id): StudentProgress | null {
    const row = this.db.get<{
      name: string;
      number: number;
      attempt_id: Id | null;
      started_at: number | null;
      last_activity_at: number | null;
      commands: number | null;
      last_command: string | null;
      status: TileStatus;
      rollbacks: number;
    }>(
      `SELECT u.name, m.number, t.id AS attempt_id, t.created_at AS started_at,
              t.last_activity_at, t.commands, t.last_command, ${STATUS_SQL} AS status,
              (SELECT COUNT(*) FROM branches b
               WHERE b.attempt_id = t.id AND b.kind = 'rollback') AS rollbacks
       FROM assignments a
       JOIN class_members m ON m.class_id = a.class_id AND m.user_id = ?2 AND m.role = 'student'
       JOIN users u ON u.id = m.user_id
       LEFT JOIN attempts t ON t.assignment_id = a.id AND t.user_id = m.user_id AND t.is_preview = 0
       WHERE a.id = ?1`,
      assignmentId,
      userId,
    );
    if (!row) return null;
    const help =
      row.attempt_id === null
        ? undefined
        : this.db.get<HelpRow>(
            `${HELP_SELECT} WHERE h.attempt_id = ? AND h.resolved_at IS NULL ORDER BY h.id DESC LIMIT 1`,
            row.attempt_id,
          );
    const submission =
      row.attempt_id === null
        ? undefined
        : this.db.get<SubmissionRow>(
            `${SUBMISSION_SELECT} WHERE attempt_id = ? ORDER BY id DESC LIMIT 1`,
            row.attempt_id,
          );
    return {
      user_id: userId,
      name: row.name,
      number: row.number,
      status: row.status,
      attempt_id: row.attempt_id,
      started_at: row.started_at,
      last_activity_at: row.last_activity_at,
      commands: row.commands ?? 0,
      last_command: row.last_command ?? '',
      rollbacks: row.rollbacks,
      open_help: help ? toHelp(help) : null,
      latest_submission: submission
        ? (teacherSummaries(this.db, [submission])[0] ?? null)
        : null,
    };
  }

  opened(assignmentId: Id, userId: Id): number[] {
    return this.db
      .all<{ hint_index: number }>(
        `SELECT u.hint_index FROM hint_uses u JOIN attempts t ON t.id = u.attempt_id
         WHERE t.assignment_id = ? AND t.user_id = ? ORDER BY u.hint_index`,
        assignmentId,
        userId,
      )
      .map((row) => row.hint_index);
  }

  private forTeacher(assignmentId: Id): AssignmentProgress {
    const counts = { ...EMPTY_COUNTS };
    let toReview = 0;
    const rows = this.db.all<{ status: TileStatus; ungraded: number }>(
      `SELECT ${STATUS_SQL} AS status, CASE WHEN ${UNGRADED_SQL} THEN 1 ELSE 0 END AS ungraded
       FROM assignments a
       JOIN class_members m ON m.class_id = a.class_id AND m.role = 'student'
       LEFT JOIN attempts t ON t.assignment_id = a.id AND t.user_id = m.user_id AND t.is_preview = 0
       WHERE a.id = ?`,
      assignmentId,
    );
    for (const row of rows) {
      counts[row.status] += 1;
      toReview += row.ungraded;
    }
    return {
      counts,
      my_status: null,
      my_grade: null,
      my_attempt_id: null,
      to_review: toReview,
    };
  }

  private forStudent(assignmentId: Id, userId: Id): AssignmentProgress {
    const row = this.db.get<{
      attempt_id: Id | null;
      status: TileStatus;
      grade: number | null;
    }>(
      `SELECT t.id AS attempt_id, ${STATUS_SQL} AS status,
              (SELECT s.grade FROM submissions s WHERE s.attempt_id = t.id
               ORDER BY s.id DESC LIMIT 1) AS grade
       FROM (SELECT ?1 AS assignment_id) q
       LEFT JOIN attempts t ON t.assignment_id = q.assignment_id AND t.user_id = ?2`,
      assignmentId,
      userId,
    );
    return {
      counts: {},
      my_status: row?.status ?? 'idle',
      my_grade: row?.grade ?? null,
      my_attempt_id: row?.attempt_id ?? null,
      to_review: 0,
    };
  }
}
