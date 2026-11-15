import { Injectable } from '@nestjs/common';
import type {
  Attempt,
  HintSlot,
  Hint,
  Id,
  SubmissionSummary,
} from '@shared/api';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';
import {
  AttemptContext,
  AttemptsAccess,
  ATTEMPT_NOT_FOUND,
} from './attempts-access.service';
import { ProgressBus } from './progress-bus';
import {
  BRANCH_SELECT,
  type BranchRow,
  HELP_SELECT,
  type HelpRow,
  SUBMISSION_SELECT,
  type SubmissionRow,
  toBranch,
  toHelp,
  teacherSummaries,
  toSubmissionSummary,
} from './views';

const ASSIGNMENT_NOT_FOUND = 'Завдання не знайдено';
const HINT_NOT_FOUND = 'Підказку не знайдено';

@Injectable()
export class AttemptsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly rights: AttemptsAccess,
    private readonly activity: ActivityService,
    private readonly progress: ProgressBus,
  ) {}

  /** The viewer's own attempt at the assignment. */
  mine(user: AuthUser, assignmentId: Id): Attempt {
    this.liveAssignment(user, assignmentId);
    const found = this.db.get<{ id: Id }>(
      'SELECT id FROM attempts WHERE assignment_id = ? AND user_id = ?',
      assignmentId,
      user.id,
    );
    if (!found) throw notFound(ATTEMPT_NOT_FOUND);
    return this.view(this.rights.readable(user, found.id));
  }

  /** Creates the attempt, or returns the existing one (`created` is false then). */
  open(
    user: AuthUser,
    assignmentId: Id,
  ): { attempt: Attempt; created: boolean } {
    const { classId, title } = this.liveAssignment(user, assignmentId);
    const existing = this.db.get<{ id: Id }>(
      'SELECT id FROM attempts WHERE assignment_id = ? AND user_id = ?',
      assignmentId,
      user.id,
    );
    if (existing) {
      const attempt = this.view(this.rights.readable(user, existing.id));
      return { attempt, created: false };
    }
    const id = this.db.tx(() => {
      const created = this.db.run(
        `INSERT INTO attempts (assignment_id, user_id, variant, is_preview, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        assignmentId,
        user.id,
        this.variantOf(user, classId),
        this.isPreview(user, classId) ? 1 : 0,
        this.clock.now(),
      );
      this.activity.record({
        class_id: classId,
        assignment_id: assignmentId,
        actor_id: user.id,
        student_id: user.id,
        kind: 'attempt_opened',
        text: title,
      });
      this.progress.emit({ assignment_id: assignmentId, user_id: user.id });
      return created.id;
    });
    return {
      attempt: this.view(this.rights.readable(user, id)),
      created: true,
    };
  }

  get(user: AuthUser, attemptId: Id): Attempt {
    const context = this.rights.readable(user, attemptId);
    return this.view(context, context.user_id !== user.id);
  }

  /** Makes a branch the current one of its machine. */
  setHead(user: AuthUser, attemptId: Id, node: string, branchId: Id): Attempt {
    const context = this.rights.owned(user, attemptId);
    const branch = this.db.get<{ node_id: string }>(
      'SELECT node_id FROM branches WHERE id = ? AND attempt_id = ?',
      branchId,
      attemptId,
    );
    if (!branch || branch.node_id !== node) {
      throw badRequest(
        `Гілка ${branchId} не належить машині "${node}" цієї спроби`,
      );
    }
    this.db.run(
      `INSERT INTO attempt_heads (attempt_id, node_id, branch_id) VALUES (?, ?, ?)
       ON CONFLICT (attempt_id, node_id) DO UPDATE SET branch_id = excluded.branch_id`,
      attemptId,
      node,
      branchId,
    );
    return this.view(context);
  }

  /** Opens a hint; opening it again changes nothing. */
  openHint(user: AuthUser, attemptId: Id, index: number): HintSlot {
    const context = this.rights.owned(user, attemptId);
    const hints = JSON.parse(context.hints) as Hint[];
    const hint = hints[index];
    if (!hint) throw notFound(HINT_NOT_FOUND);
    this.db.tx(() => {
      const inserted = this.db.run(
        'INSERT OR IGNORE INTO hint_uses (attempt_id, hint_index, used_at) VALUES (?, ?, ?)',
        attemptId,
        index,
        this.clock.now(),
      );
      if (inserted.changes === 0) return;
      this.activity.record({
        class_id: context.class_id,
        assignment_id: context.assignment_id,
        actor_id: user.id,
        student_id: user.id,
        kind: 'hint_used',
        text: context.assignment_title,
      });
    });
    return { index, penalty: hint.penalty, text: hint.text };
  }

  /** "Finish lesson": only for lessons; the first call sets the time. */
  complete(user: AuthUser, attemptId: Id): Attempt {
    const context = this.rights.owned(user, attemptId);
    if (context.assignment_kind !== 'lesson') {
      throw badRequest('Завершити можна лише урок');
    }
    this.db.tx(() => {
      this.db.run(
        'UPDATE attempts SET completed_at = ? WHERE id = ? AND completed_at IS NULL',
        this.clock.now(),
        attemptId,
      );
      this.progress.emit({
        assignment_id: context.assignment_id,
        user_id: context.user_id,
      });
    });
    return this.view(this.rights.readable(user, attemptId));
  }

  /** `withChecks`: the viewer is a teacher, who sees the result of the check runs in the summaries. */
  private view(context: AttemptContext, withChecks = false): Attempt {
    const id = context.id;
    const heads: Record<string, Id> = {};
    for (const row of this.db.all<{ node_id: string; branch_id: Id }>(
      'SELECT node_id, branch_id FROM attempt_heads WHERE attempt_id = ?',
      id,
    )) {
      heads[row.node_id] = row.branch_id;
    }
    return {
      id,
      assignment_id: context.assignment_id,
      user: { id: context.user_id, name: context.user_name },
      variant: context.variant,
      is_preview: context.is_preview,
      created_at: context.created_at,
      completed_at: context.completed_at,
      heads,
      branches: this.db
        .all<BranchRow>(
          `${BRANCH_SELECT} WHERE b.attempt_id = ? ORDER BY b.id`,
          id,
        )
        .map(toBranch),
      help: this.db
        .all<HelpRow>(`${HELP_SELECT} WHERE h.attempt_id = ? ORDER BY h.id`, id)
        .map(toHelp),
      submissions: this.submissionsOf(id, withChecks),
      hints_used: this.db
        .all<{ hint_index: number }>(
          'SELECT hint_index FROM hint_uses WHERE attempt_id = ? ORDER BY hint_index',
          id,
        )
        .map((row) => row.hint_index),
    };
  }

  private submissionsOf(
    attemptId: Id,
    withChecks: boolean,
  ): SubmissionSummary[] {
    const rows = this.db.all<SubmissionRow>(
      `${SUBMISSION_SELECT} WHERE attempt_id = ? ORDER BY id`,
      attemptId,
    );
    return withChecks
      ? teacherSummaries(this.db, rows)
      : rows.map((row) => toSubmissionSummary(row));
  }

  /** A live assignment of a class the user belongs to; anything else is 404. */
  private liveAssignment(
    user: AuthUser,
    assignmentId: Id,
  ): { classId: Id; title: string } {
    const found = this.db.get<{ class_id: Id; title: string }>(
      'SELECT class_id, title FROM assignments WHERE id = ? AND deleted_at IS NULL',
      assignmentId,
    );
    if (!found || this.access.roleOf(user.id, found.class_id) === null) {
      throw notFound(ASSIGNMENT_NOT_FOUND);
    }
    return { classId: found.class_id, title: found.title };
  }

  private isPreview(user: AuthUser, classId: Id): boolean {
    const role = this.access.roleOf(user.id, classId);
    return role !== null && isTeacherRole(role);
  }

  /** The student's number in the class, 1 for a teacher. */
  private variantOf(user: AuthUser, classId: Id): number {
    if (this.isPreview(user, classId)) return 1;
    const member = this.db.get<{ number: number | null }>(
      'SELECT number FROM class_members WHERE class_id = ? AND user_id = ?',
      classId,
      user.id,
    );
    return member?.number ?? 1;
  }
}
