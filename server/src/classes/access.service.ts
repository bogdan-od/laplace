import { Injectable } from '@nestjs/common';
import type { ClassRole, Id } from '@shared/api';
import { forbidden, notFound } from '../common/api-exception';
import { Db } from '../db/db';

/** `member`: any role; `teacher`: owner or assistant; `owner`: the owner only. */
export type Need = 'member' | 'teacher' | 'owner';

export const isTeacherRole = (role: ClassRole): boolean => role !== 'student';

const FORBIDDEN_TEXT: Record<Exclude<Need, 'member'>, string> = {
  teacher: 'Ця дія доступна лише вчителю класу',
  owner: 'Ця дія доступна лише власнику класу',
};

/** Roles of users in classes. Other modules call this instead of querying class_members. */
@Injectable()
export class Access {
  constructor(private readonly db: Db) {}

  /** The user's role in a live (not deleted) class; null if there is none or no such class. */
  roleOf(userId: Id, classId: Id): ClassRole | null {
    const row = this.db.get<{ owner_id: Id; member_role: ClassRole | null }>(
      `SELECT c.owner_id, m.role AS member_role
       FROM classes c LEFT JOIN class_members m ON m.class_id = c.id AND m.user_id = ?
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      userId,
      classId,
    );
    if (!row) return null;
    if (row.owner_id === userId) return 'owner';
    return row.member_role;
  }

  /**
   * The role if it is enough for `need`. Not a member (or no such class) is 404, so the existence
   * of a class is not revealed; a member with too weak a role is 403.
   */
  require(userId: Id, classId: Id, need: Need): ClassRole {
    const role = this.roleOf(userId, classId);
    if (role === null) throw notFound('Клас не знайдено');
    if (need === 'teacher' && !isTeacherRole(role)) {
      throw forbidden(FORBIDDEN_TEXT.teacher);
    }
    if (need === 'owner' && role !== 'owner') {
      throw forbidden(FORBIDDEN_TEXT.owner);
    }
    return role;
  }

  /** The user's role in every live class they belong to. */
  rolesOf(userId: Id): Map<Id, ClassRole> {
    const rows = this.db.all<{ id: Id; role: ClassRole }>(
      `SELECT c.id, CASE WHEN c.owner_id = ?1 THEN 'owner' ELSE m.role END AS role
       FROM classes c LEFT JOIN class_members m ON m.class_id = c.id AND m.user_id = ?1
       WHERE c.deleted_at IS NULL AND (c.owner_id = ?1 OR m.user_id IS NOT NULL)`,
      userId,
    );
    return new Map(rows.map((row) => [row.id, row.role]));
  }

  /** The student's number in the class (guest address 10.0.0.N); null for a non-student. */
  studentNumber(userId: Id, classId: Id): number | null {
    return (
      this.db.get<{ number: number }>(
        "SELECT number FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'",
        classId,
        userId,
      )?.number ?? null
    );
  }

  /** The owner and the assistants of a class. */
  teacherIds(classId: Id): Id[] {
    const ids = new Set<Id>();
    const owner = this.db.get<{ owner_id: Id }>(
      'SELECT owner_id FROM classes WHERE id = ?',
      classId,
    );
    if (owner) ids.add(owner.owner_id);
    const assistants = this.db.all<{ user_id: Id }>(
      "SELECT user_id FROM class_members WHERE class_id = ? AND role = 'assistant'",
      classId,
    );
    for (const assistant of assistants) ids.add(assistant.user_id);
    return [...ids];
  }

  /** Ids of live classes where the user is the owner or an assistant. */
  taughtClassIds(userId: Id): Id[] {
    return this.db
      .all<{ id: Id }>(
        `SELECT c.id FROM classes c
         WHERE c.deleted_at IS NULL AND (c.owner_id = ?1 OR EXISTS (
           SELECT 1 FROM class_members m
           WHERE m.class_id = c.id AND m.user_id = ?1 AND m.role = 'assistant'))
         ORDER BY c.id`,
        userId,
      )
      .map((row) => row.id);
  }
}
