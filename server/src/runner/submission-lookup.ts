import { Injectable } from '@nestjs/common';
import type {
  CheckCommand,
  Id,
  SubmissionSummary,
  Topology,
  VerifyStatus,
} from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { notFound } from '../common/api-exception';
import { Access } from '../classes/access.service';
import {
  SUBMISSION_SELECT as SUMMARY_SELECT,
  type SubmissionRow as SummaryRow,
  toSubmissionSummary,
} from '../attempts/views';
import { Db } from '../db/db';

const SUBMISSION_NOT_FOUND = 'Здачу не знайдено';
const ASSIGNMENT_NOT_FOUND = 'Завдання не знайдено';

/** A submission with the attempt and the assignment it belongs to. */
export interface SubmissionContext {
  id: Id;
  assignment_id: Id;
  assignment_title: string;
  class_id: Id;
  student_id: Id;
  /** The attempt's variant: the value of `{n}` in check commands. */
  variant: number;
  is_preview: boolean;
  verify_status: VerifyStatus;
  topology: Topology;
  checks: CheckCommand[];
}

interface SubmissionRow {
  id: Id;
  assignment_id: Id;
  assignment_title: string;
  class_id: Id;
  student_id: Id;
  variant: number;
  is_preview: number;
  verify_status: VerifyStatus;
  topology: string;
  checks: string;
  assignment_deleted: number | null;
}

export interface AssignmentContext {
  id: Id;
  class_id: Id;
  checks: CheckCommand[];
}

const SUBMISSION_SELECT = `
  SELECT s.id, a.id AS assignment_id, a.title AS assignment_title, a.class_id,
         t.user_id AS student_id, t.variant, t.is_preview, s.verify_status, a.topology, a.checks,
         a.deleted_at AS assignment_deleted
  FROM submissions s
  JOIN attempts t ON t.id = s.attempt_id
  JOIN assignments a ON a.id = t.assignment_id
  WHERE s.id = ?`;

/** Reads submissions for the runner and checks that the caller teaches the class. */
@Injectable()
export class SubmissionLookup {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  /** For the runner itself: no user, a deleted assignment still counts. */
  byId(id: Id): SubmissionContext | undefined {
    const row = this.db.get<SubmissionRow>(SUBMISSION_SELECT, id);
    return row ? toContext(row) : undefined;
  }

  /** For a teacher of the class. A non-member gets 404, a student of the class 403. */
  taught(user: AuthUser, id: Id): SubmissionContext {
    const row = this.db.get<SubmissionRow>(SUBMISSION_SELECT, id);
    if (!row || row.assignment_deleted !== null) {
      throw notFound(SUBMISSION_NOT_FOUND);
    }
    this.access.require(user.id, row.class_id, 'teacher');
    return toContext(row);
  }

  assignmentTaught(user: AuthUser, id: Id): AssignmentContext {
    const row = this.db.get<{
      id: Id;
      class_id: Id;
      checks: string;
      deleted_at: number | null;
    }>(
      'SELECT id, class_id, checks, deleted_at FROM assignments WHERE id = ?',
      id,
    );
    if (!row || row.deleted_at !== null) throw notFound(ASSIGNMENT_NOT_FOUND);
    this.access.require(user.id, row.class_id, 'teacher');
    return {
      id: row.id,
      class_id: row.class_id,
      checks: JSON.parse(row.checks) as CheckCommand[],
    };
  }

  /** The newest submission of every student's real attempt (teachers' trial attempts are left out). */
  latestOfAssignment(assignmentId: Id): Id[] {
    return this.db
      .all<{ id: Id }>(
        `SELECT MAX(s.id) AS id
         FROM submissions s JOIN attempts t ON t.id = s.attempt_id
         WHERE t.assignment_id = ? AND t.is_preview = 0
         GROUP BY s.attempt_id ORDER BY id`,
        assignmentId,
      )
      .map((row) => row.id);
  }

  summary(id: Id): SubmissionSummary {
    const row = this.db.get<SummaryRow>(`${SUMMARY_SELECT} WHERE id = ?`, id);
    if (!row) throw notFound(SUBMISSION_NOT_FOUND);
    return toSubmissionSummary(row);
  }
}

function toContext(row: SubmissionRow): SubmissionContext {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    assignment_title: row.assignment_title,
    class_id: row.class_id,
    student_id: row.student_id,
    variant: row.variant,
    is_preview: row.is_preview === 1,
    verify_status: row.verify_status,
    topology: JSON.parse(row.topology) as Topology,
    checks: JSON.parse(row.checks) as CheckCommand[],
  };
}
