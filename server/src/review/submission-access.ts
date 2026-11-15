import { Injectable } from '@nestjs/common';
import type { ClassRole, Id, VerifyStatus } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { forbidden, notFound } from '../common/api-exception';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';

export const SUBMISSION_NOT_FOUND = 'Здачу не знайдено';

/** A submission with its attempt, assignment and class, as seen by one user. */
export interface SubmissionView {
  id: Id;
  attempt_id: Id;
  created_at: number;
  verify_status: VerifyStatus;
  verify_message: string | null;
  commands_count: number | null;
  grade: number | null;
  note: string;
  graded_by: Id | null;
  graded_at: number | null;
  student_id: Id;
  student_name: string;
  is_preview: boolean;
  assignment_id: Id;
  assignment_title: string;
  class_id: Id;
  class_name: string;
  max_grade: number;
  due_at: number | null;
  /** JSON Hint[] of the assignment. */
  hints: string;
  role: ClassRole;
  /** The viewer owns the attempt. */
  owner: boolean;
}

type SubmissionRow = Omit<SubmissionView, 'is_preview' | 'role' | 'owner'> & {
  is_preview: number;
};

const SELECT = `
  SELECT s.id, s.attempt_id, s.created_at, s.verify_status, s.verify_message, s.commands_count,
         s.grade, s.note, s.graded_by, s.graded_at, t.user_id AS student_id,
         u.name AS student_name, t.is_preview, a.id AS assignment_id, a.title AS assignment_title,
         a.class_id, c.name AS class_name, a.max_grade, a.due_at, a.hints
  FROM submissions s
  JOIN attempts t ON t.id = s.attempt_id
  JOIN assignments a ON a.id = t.assignment_id AND a.deleted_at IS NULL
  JOIN classes c ON c.id = a.class_id
  JOIN users u ON u.id = t.user_id
  WHERE s.id = ?`;

/**
 * Rights over submissions: the author of the attempt and the teachers of
 * the class read; only teachers grade and comment. A user outside the class gets 404 so the id is
 * not revealed; a member with the wrong role gets 403.
 */
@Injectable()
export class SubmissionAccess {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  readable(user: AuthUser, id: Id): SubmissionView {
    const view = this.load(user, id);
    if (!view.owner && !isTeacherRole(view.role)) {
      throw forbidden('Здача належить іншому студенту');
    }
    return view;
  }

  taught(user: AuthUser, id: Id): SubmissionView {
    const view = this.load(user, id);
    if (!isTeacherRole(view.role)) {
      throw forbidden('Ця дія доступна лише вчителю класу');
    }
    return view;
  }

  private load(user: AuthUser, id: Id): SubmissionView {
    const row = this.db.get<SubmissionRow>(SELECT, id);
    if (!row) throw notFound(SUBMISSION_NOT_FOUND);
    const role = this.access.roleOf(user.id, row.class_id);
    if (role === null) throw notFound(SUBMISSION_NOT_FOUND);
    return {
      ...row,
      is_preview: row.is_preview === 1,
      role,
      owner: row.student_id === user.id,
    };
  }
}
