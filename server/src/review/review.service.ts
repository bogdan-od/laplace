import { Injectable } from '@nestjs/common';
import type { Id, ReviewItem } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import {
  HELP_SELECT,
  type HelpRow,
  type SubmissionRow,
  toHelp,
  latestChecks,
  toSubmissionSummary,
} from '../attempts/views';
import { Access } from '../classes/access.service';
import { Db } from '../db/db';

/** The inbox shows the newest items only; older ones are reached through the class pages. */
const REVIEW_LIMIT = 200;

interface InboxSubmissionRow extends SubmissionRow {
  user_id: Id;
  user_name: string;
  assignment_id: Id;
}

const placeholders = (ids: readonly Id[]): string =>
  ids.map(() => '?').join(', ');

/** Everything a teacher has to look at, from all classes they teach. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  inbox(user: AuthUser): ReviewItem[] {
    const classIds = this.access.taughtClassIds(user.id);
    if (classIds.length === 0) return [];
    const marks = placeholders(classIds);
    const classNames = new Map(
      this.db
        .all<{ id: Id; name: string }>(
          `SELECT id, name FROM classes WHERE id IN (${marks})`,
          ...classIds,
        )
        .map((row) => [row.id, row.name]),
    );
    const assignments = new Map(
      this.db
        .all<{ id: Id; title: string; class_id: Id }>(
          `SELECT id, title, class_id FROM assignments
           WHERE deleted_at IS NULL AND class_id IN (${marks})`,
          ...classIds,
        )
        .map((row) => [row.id, row]),
    );
    const items: { at: number; item: ReviewItem }[] = [];
    const ungraded = this.ungraded(marks, classIds);
    const checks = latestChecks(
      this.db,
      ungraded.map((row) => row.id),
    );
    for (const row of ungraded) {
      const assignment = assignments.get(row.assignment_id);
      const className = assignment && classNames.get(assignment.class_id);
      if (!assignment || className === undefined) continue;
      items.push({
        at: row.created_at,
        item: {
          kind: 'submission',
          submission: toSubmissionSummary(row, checks.get(row.id) ?? null),
          assignment: { id: assignment.id, title: assignment.title },
          class: { id: assignment.class_id, name: className },
          student: { id: row.user_id, name: row.user_name },
        },
      });
    }
    for (const row of this.openHelp(marks, classIds)) {
      const assignment = assignments.get(row.assignment_id);
      const className = assignment && classNames.get(assignment.class_id);
      if (!assignment || className === undefined) continue;
      items.push({
        at: row.created_at,
        item: {
          kind: 'help',
          help: toHelp(row),
          assignment: { id: assignment.id, title: assignment.title },
          class: { id: assignment.class_id, name: className },
        },
      });
    }
    items.sort((a, b) => b.at - a.at);
    return items.slice(0, REVIEW_LIMIT).map(({ item }) => item);
  }

  /** The latest submission of each real attempt of a current student, when it has no grade yet. */
  private ungraded(marks: string, classIds: Id[]): InboxSubmissionRow[] {
    return this.db.all<InboxSubmissionRow>(
      `SELECT s.id, s.attempt_id, s.created_at, s.verify_status, s.grade,
              t.user_id, u.name AS user_name, t.assignment_id
       FROM submissions s
       JOIN attempts t ON t.id = s.attempt_id
       JOIN assignments a ON a.id = t.assignment_id
       JOIN class_members m ON m.class_id = a.class_id AND m.user_id = t.user_id
                           AND m.role = 'student'
       JOIN users u ON u.id = t.user_id
       WHERE a.class_id IN (${marks}) AND a.deleted_at IS NULL AND t.is_preview = 0
         AND s.grade IS NULL
         AND s.id = (SELECT MAX(id) FROM submissions WHERE attempt_id = t.id)
       ORDER BY s.created_at DESC, s.id DESC LIMIT ${REVIEW_LIMIT}`,
      ...classIds,
    );
  }

  private openHelp(marks: string, classIds: Id[]): HelpRow[] {
    return this.db.all<HelpRow>(
      `${HELP_SELECT}
       JOIN class_members m ON m.class_id = s.class_id AND m.user_id = a.user_id
                           AND m.role = 'student'
       WHERE s.class_id IN (${marks}) AND s.deleted_at IS NULL AND a.is_preview = 0
         AND h.resolved_at IS NULL
       ORDER BY h.created_at DESC, h.id DESC LIMIT ${REVIEW_LIMIT}`,
      ...classIds,
    );
  }
}
