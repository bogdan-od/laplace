import { Injectable } from '@nestjs/common';
import type { Activity, ActivityKind, Id } from '@shared/api';
import { Observable, Subject } from 'rxjs';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { OWNER_ONLY_KINDS, STUDENT_KINDS, TEACHER_KINDS } from './recipients';

export interface ActivityInput {
  class_id: Id;
  assignment_id?: Id | null;
  actor_id: Id;
  /** Whose attempt it concerns; the recipient of STUDENT_KINDS. */
  student_id?: Id | null;
  kind: ActivityKind;
  ref_id?: Id | null;
  text?: string | null;
}

export interface ActivityRow {
  id: Id;
  class_id: Id;
  assignment_id: Id | null;
  kind: ActivityKind;
  ref_id: Id | null;
  text: string | null;
  at: number;
  actor_id: Id;
  actor_name: string;
  student_id: Id | null;
  student_name: string | null;
}

export const ACTIVITY_SELECT = `
  SELECT a.id, a.class_id, a.assignment_id, a.kind, a.ref_id, a.text, a.at,
         a.actor_id, u.name AS actor_name, a.student_id, s.name AS student_name
  FROM activity a
  JOIN users u ON u.id = a.actor_id
  LEFT JOIN users s ON s.id = a.student_id`;

export function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    class_id: row.class_id,
    assignment_id: row.assignment_id,
    actor: { id: row.actor_id, name: row.actor_name },
    student:
      row.student_id !== null && row.student_name !== null
        ? { id: row.student_id, name: row.student_name }
        : null,
    kind: row.kind,
    ref_id: row.ref_id,
    text: row.text,
    at: row.at,
  };
}

@Injectable()
export class ActivityService {
  private readonly subject = new Subject<Activity>();

  /** Every recorded activity, after its transaction has committed. The WebSocket gateway turns it into `notify`. */
  readonly activity$: Observable<Activity> = this.subject.asObservable();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Writes the activity row and publishes it on activity$ once the surrounding transaction commits. */
  record(input: ActivityInput): Activity {
    const { id } = this.db.run(
      `INSERT INTO activity (class_id, assignment_id, actor_id, student_id, kind, ref_id, text, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.class_id,
      input.assignment_id ?? null,
      input.actor_id,
      input.student_id ?? null,
      input.kind,
      input.ref_id ?? null,
      input.text ?? null,
      this.clock.now(),
    );
    const row = this.db.get<ActivityRow>(
      `${ACTIVITY_SELECT} WHERE a.id = ?`,
      id,
    );
    if (!row) throw new Error(`activity ${id} vanished after insert`);
    const activity = toActivity(row);
    this.db.afterCommit(() => this.subject.next(activity));
    return activity;
  }

  /** Users to notify about an activity; the same rule as GET /api/notifications. */
  recipients(activity: Activity): Id[] {
    const ids = new Set<Id>();
    const live = this.db.get<{ id: Id }>(
      'SELECT id FROM classes WHERE id = ? AND deleted_at IS NULL',
      activity.class_id,
    );
    if (!live) return [];
    if (STUDENT_KINDS.includes(activity.kind)) {
      if (activity.student) ids.add(activity.student.id);
    } else if (
      TEACHER_KINDS.includes(activity.kind) ||
      OWNER_ONLY_KINDS.includes(activity.kind)
    ) {
      const owner = this.db.get<{ owner_id: Id }>(
        'SELECT owner_id FROM classes WHERE id = ?',
        activity.class_id,
      );
      if (owner) ids.add(owner.owner_id);
    }
    if (TEACHER_KINDS.includes(activity.kind)) {
      const assistants = this.db.all<{ user_id: Id }>(
        "SELECT user_id FROM class_members WHERE class_id = ? AND role = 'assistant'",
        activity.class_id,
      );
      for (const assistant of assistants) ids.add(assistant.user_id);
    }
    ids.delete(activity.actor.id);
    return [...ids];
  }
}
