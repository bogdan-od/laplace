import { Injectable } from '@nestjs/common';
import type { Analytics, Id, StudentProgress } from '@shared/api';
import { Progress } from '../assignments/providers';
import type { AuthUser } from '../auth/auth.types';
import { notFound } from '../common/api-exception';
import { Access } from '../classes/access.service';
import { Db } from '../db/db';
import { median } from './median';

const ASSIGNMENT_NOT_FOUND = 'Завдання не знайдено';
const MS_PER_MINUTE = 60_000;

interface StudentRow {
  user_id: Id;
  name: string;
  attempt_created: number | null;
  first_submitted: number | null;
  grade: number | null;
  commands: number | null;
  rollbacks: number;
  help_requests: number;
  hints_used: number;
}

/** Minutes with two decimals (a start under a minute is shown in seconds): "12,5 хв", "40 с". */
const minutes = (ms: number): number =>
  Math.round((Math.max(0, ms) / MS_PER_MINUTE) * 100) / 100;

/** Per-assignment reports for the teachers of the class. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
    private readonly progress: Progress,
  ) {}

  /** The tile of every current student of the class, by student number. */
  students(user: AuthUser, assignmentId: Id): StudentProgress[] {
    const classId = this.taughtClass(user, assignmentId);
    return this.db
      .all<{ user_id: Id }>(
        `SELECT user_id FROM class_members WHERE class_id = ? AND role = 'student' ORDER BY number`,
        classId,
      )
      .flatMap(({ user_id }) => {
        const tile = this.progress.student(assignmentId, user_id);
        return tile ? [tile] : [];
      });
  }

  /** Teachers' trial attempts (`is_preview`) are not counted anywhere. */
  analytics(user: AuthUser, assignmentId: Id): Analytics {
    const classId = this.taughtClass(user, assignmentId);
    const rows = this.db.all<StudentRow>(
      `SELECT m.user_id, u.name, t.created_at AS attempt_created,
              (SELECT MIN(s.created_at) FROM submissions s WHERE s.attempt_id = t.id) AS first_submitted,
              (SELECT s.grade FROM submissions s WHERE s.attempt_id = t.id
               ORDER BY s.id DESC LIMIT 1) AS grade,
              (SELECT s.commands_count FROM submissions s
               WHERE s.attempt_id = t.id AND s.commands_count IS NOT NULL
               ORDER BY s.id DESC LIMIT 1) AS commands,
              (SELECT COUNT(*) FROM branches b
               WHERE b.attempt_id = t.id AND b.kind = 'rollback') AS rollbacks,
              (SELECT COUNT(*) FROM help_requests h WHERE h.attempt_id = t.id) AS help_requests,
              (SELECT COUNT(*) FROM hint_uses h WHERE h.attempt_id = t.id) AS hints_used
       FROM class_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN attempts t ON t.assignment_id = ?2 AND t.user_id = m.user_id AND t.is_preview = 0
       WHERE m.class_id = ?1 AND m.role = 'student'
       ORDER BY m.number`,
      classId,
      assignmentId,
    );
    const perStudent = rows.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      minutes_to_submit:
        row.attempt_created !== null && row.first_submitted !== null
          ? minutes(row.first_submitted - row.attempt_created)
          : null,
      commands: row.commands,
      rollbacks: row.rollbacks,
      help_requests: row.help_requests,
      hints_used: row.hints_used,
      grade: row.grade,
    }));
    const times = perStudent.flatMap((row) =>
      row.minutes_to_submit === null ? [] : [row.minutes_to_submit],
    );
    return {
      assignment_id: assignmentId,
      students: rows.length,
      opened: rows.filter((row) => row.attempt_created !== null).length,
      submitted: rows.filter((row) => row.first_submitted !== null).length,
      minutes_to_submit: {
        median: median(times),
        min: times.length > 0 ? Math.min(...times) : null,
        max: times.length > 0 ? Math.max(...times) : null,
      },
      per_student: perStudent,
      grades: this.distribution(perStudent.map((row) => row.grade)),
    };
  }

  private distribution(grades: (number | null)[]): Analytics['grades'] {
    const counts = new Map<number, number>();
    for (const grade of grades) {
      if (grade !== null) counts.set(grade, (counts.get(grade) ?? 0) + 1);
    }
    return [...counts]
      .sort(([a], [b]) => a - b)
      .map(([grade, count]) => ({ grade, count }));
  }

  private taughtClass(user: AuthUser, assignmentId: Id): Id {
    const row = this.db.get<{ class_id: Id }>(
      'SELECT class_id FROM assignments WHERE id = ? AND deleted_at IS NULL',
      assignmentId,
    );
    if (!row) throw notFound(ASSIGNMENT_NOT_FOUND);
    this.access.require(user.id, row.class_id, 'teacher');
    return row.class_id;
  }
}
