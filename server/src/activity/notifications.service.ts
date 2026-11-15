import { Injectable } from '@nestjs/common';
import type { Id, NotificationList } from '@shared/api';
import { Db } from '../db/db';
import { ACTIVITY_SELECT, ActivityRow, toActivity } from './activity.service';
import {
  OWNER_ONLY_KINDS,
  sqlList,
  STUDENT_KINDS,
  TEACHER_KINDS,
} from './recipients';

const LIMIT = 50;

// Mirrors ActivityService.recipients(); ?1 is the viewing user. The kind lists are constants from
// recipients.ts, not user input.
const VISIBLE = `
  c.deleted_at IS NULL AND a.actor_id <> ?1 AND (
    (a.kind IN (${sqlList(TEACHER_KINDS)}) AND (c.owner_id = ?1 OR EXISTS (
       SELECT 1 FROM class_members m
       WHERE m.class_id = a.class_id AND m.user_id = ?1 AND m.role = 'assistant')))
    OR (a.kind IN (${sqlList(OWNER_ONLY_KINDS)}) AND c.owner_id = ?1)
    OR (a.kind IN (${sqlList(STUDENT_KINDS)}) AND a.student_id = ?1)
  )`;

@Injectable()
export class NotificationsService {
  constructor(private readonly db: Db) {}

  list(userId: Id): NotificationList {
    const rows = this.db.all<ActivityRow>(
      `${ACTIVITY_SELECT} JOIN classes c ON c.id = a.class_id
       WHERE ${VISIBLE} ORDER BY a.id DESC LIMIT ${LIMIT}`,
      userId,
    );
    const unread = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM activity a JOIN classes c ON c.id = a.class_id
       WHERE ${VISIBLE}
         AND a.id > COALESCE((SELECT last_read_id FROM notification_reads WHERE user_id = ?1), 0)`,
      userId,
    );
    return { items: rows.map(toActivity), unread: unread?.n ?? 0 };
  }

  /** Marks everything up to up_to as read; ids that do not exist yet cannot be read in advance. */
  markRead(userId: Id, upTo: Id): void {
    this.db.run(
      `INSERT INTO notification_reads (user_id, last_read_id)
       VALUES (?1, MIN(?2, (SELECT COALESCE(MAX(id), 0) FROM activity)))
       ON CONFLICT (user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
      userId,
      upTo,
    );
  }
}
