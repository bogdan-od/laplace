import { Injectable } from '@nestjs/common';
import type { CalendarEntry, ClassRole, Id } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { Clock } from '../common/clock';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';
import { buildCalendar } from './ics';
import { Progress } from './providers';

interface DueRow {
  id: Id;
  title: string;
  class_id: Id;
  class_name: string;
  due_at: number;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly progress: Progress,
  ) {}

  /** Due dates in [from, to) over all my classes (as owner, assistant or student). */
  entries(user: AuthUser, from: number, to: number): CalendarEntry[] {
    const roles = this.access.rolesOf(user.id);
    return this.dueRows(roles, from, to).map((row) => {
      const viewer = {
        userId: user.id,
        role: roles.get(row.class_id) ?? 'student',
      };
      const progress = this.progress.assignment(row.id, viewer);
      return {
        assignment_id: row.id,
        title: row.title,
        class_id: row.class_id,
        class_name: row.class_name,
        due_at: row.due_at,
        my_status: isTeacherRole(viewer.role) ? null : progress.my_status,
        to_review: isTeacherRole(viewer.role) ? progress.to_review : 0,
      };
    });
  }

  /** RFC 5545 calendar with an event per due date, whatever the date. */
  ics(user: AuthUser): string {
    const rows = this.dueRows(
      this.access.rolesOf(user.id),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return buildCalendar(
      rows.map((row) => ({
        uid: `assignment-${row.id}@laplace`,
        summary: `${row.class_name}: ${row.title}`,
        at: row.due_at,
      })),
      this.clock.now(),
    );
  }

  private dueRows(
    roles: Map<Id, ClassRole>,
    from: number,
    to: number,
  ): DueRow[] {
    const classIds = [...roles.keys()];
    if (classIds.length === 0) return [];
    const marks = classIds.map(() => '?').join(', ');
    return this.db.all<DueRow>(
      `SELECT a.id, a.title, a.class_id, c.name AS class_name, a.due_at
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE a.deleted_at IS NULL AND a.due_at >= ? AND a.due_at < ?
         AND a.class_id IN (${marks})
       ORDER BY a.due_at, a.id`,
      from,
      to,
      ...classIds,
    );
  }
}
