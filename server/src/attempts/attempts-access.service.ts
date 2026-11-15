import { Injectable } from '@nestjs/common';
import type { ClassRole, Id, Topology } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { conflict, forbidden, notFound } from '../common/api-exception';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';

export const ATTEMPT_NOT_FOUND = 'Спробу не знайдено';
const BRANCH_NOT_FOUND = 'Гілку не знайдено';

/** An attempt with the assignment it belongs to and what the viewer is in that class. */
export interface AttemptContext {
  id: Id;
  assignment_id: Id;
  class_id: Id;
  user_id: Id;
  user_name: string;
  variant: number;
  is_preview: boolean;
  created_at: number;
  completed_at: number | null;
  assignment_kind: 'task' | 'lesson';
  assignment_title: string;
  topology: Topology;
  hints: string;
  role: ClassRole;
  /** The teacher froze the assignment ("freeze everyone"). */
  frozen: boolean;
  /** The viewer owns the attempt. */
  owner: boolean;
}

interface AttemptRow {
  id: Id;
  assignment_id: Id;
  class_id: Id;
  user_id: Id;
  user_name: string;
  variant: number;
  is_preview: number;
  created_at: number;
  completed_at: number | null;
  assignment_kind: 'task' | 'lesson';
  assignment_title: string;
  topology: string;
  hints: string;
  frozen: number;
}

const ATTEMPT_SELECT = `
  SELECT t.id, t.assignment_id, s.class_id, t.user_id, u.name AS user_name, t.variant,
         t.is_preview, t.created_at, t.completed_at, s.kind AS assignment_kind,
         s.title AS assignment_title, s.topology, s.hints, s.frozen
  FROM attempts t
  JOIN assignments s ON s.id = t.assignment_id
  JOIN users u ON u.id = t.user_id
  WHERE s.deleted_at IS NULL`;

export interface BranchContext {
  attempt: AttemptContext;
  branch_id: Id;
  author_id: Id;
  kind: string;
}

/**
 * Rights over attempts and their branches. A user outside the class gets
 * 404 so the id is not revealed; a class member with the wrong role gets 403.
 */
@Injectable()
export class AttemptsAccess {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  /** The owner or a teacher of the class may read. */
  readable(user: AuthUser, attemptId: Id): AttemptContext {
    const context = this.load(user, attemptId);
    if (!context.owner && !isTeacherRole(context.role)) {
      throw forbidden('Спроба належить іншому студенту');
    }
    return context;
  }

  /** Only the owner. */
  owned(user: AuthUser, attemptId: Id): AttemptContext {
    const context = this.load(user, attemptId);
    if (!context.owner) throw forbidden('Ця дія доступна лише автору спроби');
    return context;
  }

  /** Only a teacher of the class. */
  taught(user: AuthUser, attemptId: Id): AttemptContext {
    const context = this.load(user, attemptId);
    if (!isTeacherRole(context.role)) {
      throw forbidden('Ця дія доступна лише вчителю класу');
    }
    return context;
  }

  /**
   * While the assignment is frozen a student may neither submit nor start a branch. A teacher is
   * never stopped. Appending chunks is not checked: what happened must not be lost.
   */
  requireNotFrozen(context: AttemptContext): void {
    if (context.frozen && !isTeacherRole(context.role)) {
      throw conflict('Викладач заморозив завдання');
    }
  }

  /** The attempt of a branch for reading its journal and chunks. */
  readableBranch(user: AuthUser, branchId: Id): BranchContext {
    const found = this.branch(branchId);
    return { ...found, attempt: this.readable(user, found.attempt_id) };
  }

  /**
   * The attempt of a branch for appending chunks: the author of a `reply` branch (a teacher), or
   * the owner of the attempt for the other kinds.
   */
  writableBranch(user: AuthUser, branchId: Id): BranchContext {
    const found = this.branch(branchId);
    const attempt = this.load(user, found.attempt_id);
    const allowed =
      found.kind === 'reply'
        ? found.author_id === user.id && isTeacherRole(attempt.role)
        : attempt.owner;
    if (!allowed) {
      throw forbidden(
        found.kind === 'reply'
          ? 'Відповідь може доповнювати лише її автор'
          : 'Ця дія доступна лише автору спроби',
      );
    }
    return { ...found, attempt };
  }

  private branch(branchId: Id): Omit<BranchContext, 'attempt'> & {
    attempt_id: Id;
  } {
    const row = this.db.get<{
      id: Id;
      attempt_id: Id;
      author_id: Id;
      kind: string;
    }>(
      'SELECT id, attempt_id, author_id, kind FROM branches WHERE id = ?',
      branchId,
    );
    if (!row) throw notFound(BRANCH_NOT_FOUND);
    return {
      branch_id: row.id,
      attempt_id: row.attempt_id,
      author_id: row.author_id,
      kind: row.kind,
    };
  }

  private load(user: AuthUser, attemptId: Id): AttemptContext {
    const row = this.db.get<AttemptRow>(
      `${ATTEMPT_SELECT} AND t.id = ?`,
      attemptId,
    );
    if (!row) throw notFound(ATTEMPT_NOT_FOUND);
    const role = this.access.roleOf(user.id, row.class_id);
    if (role === null) throw notFound(ATTEMPT_NOT_FOUND);
    return {
      id: row.id,
      assignment_id: row.assignment_id,
      class_id: row.class_id,
      user_id: row.user_id,
      user_name: row.user_name,
      variant: row.variant,
      is_preview: row.is_preview === 1,
      created_at: row.created_at,
      completed_at: row.completed_at,
      assignment_kind: row.assignment_kind,
      assignment_title: row.assignment_title,
      topology: JSON.parse(row.topology) as Topology,
      hints: row.hints,
      role,
      frozen: row.frozen === 1,
      owner: row.user_id === user.id,
    };
  }
}
