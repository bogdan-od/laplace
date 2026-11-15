import { Injectable } from '@nestjs/common';
import type { HelpRequest, Id } from '@shared/api';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/api-exception';
import { Clock } from '../common/clock';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';
import { AttemptsAccess } from './attempts-access.service';
import type { HelpDto } from './dto';
import { ProgressBus } from './progress-bus';
import { HELP_SELECT, type HelpRow, toHelp } from './views';

const HELP_NOT_FOUND = 'Запит допомоги не знайдено';
/** The notification shows the start of the request. */
const MAX_ACTIVITY_TEXT_CHARS = 200;

@Injectable()
export class HelpService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly rights: AttemptsAccess,
    private readonly activity: ActivityService,
    private readonly progress: ProgressBus,
  ) {}

  request(user: AuthUser, attemptId: Id, dto: HelpDto): HelpRequest {
    const context = this.rights.owned(user, attemptId);
    const branch = this.db.get<{ node_id: string; event_count: number }>(
      'SELECT node_id, event_count FROM branches WHERE id = ? AND attempt_id = ?',
      dto.branch_id,
      attemptId,
    );
    if (!branch || branch.node_id !== dto.node) {
      throw badRequest(
        `Гілка ${dto.branch_id} не належить машині "${dto.node}" цієї спроби`,
      );
    }
    if (dto.event_count > branch.event_count) {
      throw badRequest('Момент запиту лежить за межами журналу гілки');
    }
    const id = this.db.tx(() => {
      const created = this.db.run(
        `INSERT INTO help_requests (attempt_id, node_id, branch_id, event_count, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        attemptId,
        dto.node,
        dto.branch_id,
        dto.event_count,
        dto.text,
        this.clock.now(),
      );
      if (!context.is_preview) {
        this.activity.record({
          class_id: context.class_id,
          assignment_id: context.assignment_id,
          actor_id: user.id,
          student_id: user.id,
          kind: 'help_requested',
          ref_id: created.id,
          text: dto.text.slice(0, MAX_ACTIVITY_TEXT_CHARS),
        });
      }
      this.progress.emit({
        assignment_id: context.assignment_id,
        user_id: context.user_id,
      });
      return created.id;
    });
    return this.find(id);
  }

  /** Requests the viewer may see: those of their own attempts and those of classes they teach. */
  list(user: AuthUser, onlyOpen: boolean): HelpRequest[] {
    return this.db
      .all<HelpRow>(
        `${HELP_SELECT}
         JOIN classes c ON c.id = s.class_id
         WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL
           AND (?1 = 0 OR h.resolved_at IS NULL)
           AND (a.user_id = ?2 OR (a.is_preview = 0 AND (c.owner_id = ?2 OR EXISTS (
             SELECT 1 FROM class_members m
             WHERE m.class_id = c.id AND m.user_id = ?2 AND m.role = 'assistant'))))
         ORDER BY h.created_at DESC, h.id DESC`,
        onlyOpen ? 1 : 0,
        user.id,
      )
      .map(toHelp);
  }

  resolve(user: AuthUser, helpId: Id): HelpRequest {
    const help = this.teacherOwned(user, helpId);
    if (help.resolved_at === null) {
      this.db.tx(() => {
        this.db.run(
          'UPDATE help_requests SET resolved_at = ?, resolved_by = ? WHERE id = ?',
          this.clock.now(),
          user.id,
          helpId,
        );
        this.finish(user, help, 'help_resolved');
      });
    }
    return this.find(helpId);
  }

  /** The answer is a `reply` branch that starts exactly at the moment of the request. */
  reply(user: AuthUser, helpId: Id, branchId: Id): HelpRequest {
    const help = this.teacherOwned(user, helpId);
    if (help.reply_branch_id !== null) {
      throw conflict('На цей запит уже надано відповідь');
    }
    const branch = this.db.get<{
      attempt_id: Id;
      node_id: string;
      parent_id: Id | null;
      fork_event: number;
      kind: string;
      author_id: Id;
    }>(
      'SELECT attempt_id, node_id, parent_id, fork_event, kind, author_id FROM branches WHERE id = ?',
      branchId,
    );
    const valid =
      branch?.kind === 'reply' &&
      branch.attempt_id === help.attempt_id &&
      branch.node_id === help.node &&
      branch.parent_id === help.branch_id &&
      branch.fork_event === help.event_count &&
      branch.author_id === user.id;
    if (!valid) {
      throw badRequest(
        'Гілка не є вашою відповіддю на цей запит: вона має відгалужуватися від моменту запиту',
      );
    }
    this.db.tx(() => {
      this.db.run(
        `UPDATE help_requests SET reply_branch_id = ?, resolved_at = COALESCE(resolved_at, ?),
                                  resolved_by = COALESCE(resolved_by, ?)
         WHERE id = ?`,
        branchId,
        this.clock.now(),
        user.id,
        helpId,
      );
      this.finish(user, help, 'help_replied');
    });
    return this.find(helpId);
  }

  private finish(
    user: AuthUser,
    help: HelpRow,
    kind: 'help_resolved' | 'help_replied',
  ): void {
    this.activity.record({
      class_id: help.class_id,
      assignment_id: help.assignment_id,
      actor_id: user.id,
      student_id: help.student_id,
      kind,
      ref_id: help.id,
    });
    this.progress.emit({
      assignment_id: help.assignment_id,
      user_id: help.student_id,
    });
  }

  /** A request of a class the user teaches; a student or a stranger is refused as usual. */
  private teacherOwned(user: AuthUser, helpId: Id): HelpRow {
    const help = this.db.get<HelpRow>(
      `${HELP_SELECT} WHERE h.id = ? AND s.deleted_at IS NULL`,
      helpId,
    );
    if (!help) throw notFound(HELP_NOT_FOUND);
    const role = this.access.roleOf(user.id, help.class_id);
    if (role === null) throw notFound(HELP_NOT_FOUND);
    if (!isTeacherRole(role)) {
      throw forbidden('Ця дія доступна лише вчителю класу');
    }
    return help;
  }

  private find(helpId: Id): HelpRequest {
    const row = this.db.get<HelpRow>(`${HELP_SELECT} WHERE h.id = ?`, helpId);
    if (!row) throw new Error(`help request ${helpId} vanished`);
    return toHelp(row);
  }
}
