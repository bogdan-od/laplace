import { Injectable } from '@nestjs/common';
import type { Activity, Id } from '@shared/api';
import {
  ACTIVITY_SELECT,
  type ActivityRow,
  toActivity,
} from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import { Access } from '../classes/access.service';
import { Db } from '../db/db';
import { type GradeRow, gradesCsv } from './grades-csv';

const ACTIVITY_PAGE = 50;

/** Reports over a whole class for its teachers. */
@Injectable()
export class ClassReportsService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  /**
   * One row per student, one column per task; a lesson has no grade. The grade of a cell is the
   * one of the student's latest submission, as everywhere else.
   */
  gradesCsv(user: AuthUser, classId: Id): string {
    this.access.require(user.id, classId, 'teacher');
    const tasks = this.db.all<{ id: Id; title: string }>(
      `SELECT id, title FROM assignments
       WHERE class_id = ? AND kind = 'task' AND deleted_at IS NULL ORDER BY created_at, id`,
      classId,
    );
    const grades = new Map<string, number | null>();
    for (const row of this.db.all<{
      assignment_id: Id;
      user_id: Id;
      grade: number | null;
    }>(
      `SELECT t.assignment_id, t.user_id,
              (SELECT s.grade FROM submissions s WHERE s.attempt_id = t.id
               ORDER BY s.id DESC LIMIT 1) AS grade
       FROM attempts t JOIN assignments a ON a.id = t.assignment_id
       WHERE a.class_id = ? AND t.is_preview = 0`,
      classId,
    )) {
      grades.set(`${row.assignment_id}:${row.user_id}`, row.grade);
    }
    const students = this.db.all<{ user_id: Id; number: number; name: string }>(
      `SELECT m.user_id, m.number, u.name FROM class_members m JOIN users u ON u.id = m.user_id
       WHERE m.class_id = ? AND m.role = 'student' ORDER BY m.number`,
      classId,
    );
    const rows: GradeRow[] = students.map((student) => ({
      number: student.number,
      name: student.name,
      grades: tasks.map(
        (task) => grades.get(`${task.id}:${student.user_id}`) ?? null,
      ),
    }));
    return gradesCsv(
      tasks.map((task) => task.title),
      rows,
    );
  }

  /** Everything that happened in the class, newest first, a page at a time (`before` is an id). */
  activity(
    user: AuthUser,
    classId: Id,
    before: number | undefined,
  ): Activity[] {
    this.access.require(user.id, classId, 'teacher');
    return this.db
      .all<ActivityRow>(
        `${ACTIVITY_SELECT} WHERE a.class_id = ? AND a.id < ?
         ORDER BY a.id DESC LIMIT ${ACTIVITY_PAGE}`,
        classId,
        before ?? Number.MAX_SAFE_INTEGER,
      )
      .map(toActivity);
  }
}
