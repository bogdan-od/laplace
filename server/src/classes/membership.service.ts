import { Injectable } from '@nestjs/common';
import type { Id, InviteInfo } from '@shared/api';
import { MAX_STUDENTS_PER_CLASS } from '@shared/limits';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { INVITE_CODE_RE } from './invite-code';

export const classFullMessage = (): string =>
  `У класі вже ${MAX_STUDENTS_PER_CLASS} студенти`;

export interface JoinResult {
  number: number;
  /** false if the user was already a member (nothing changed). */
  joined: boolean;
}

interface InviteRow {
  id: Id;
  name: string;
  subject: string;
  owner_name: string;
}

@Injectable()
export class MembershipService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly activity: ActivityService,
  ) {}

  /** Id of the live class with this invite code, or null for an unknown or malformed code. */
  classIdByInvite(code: string): Id | null {
    if (!INVITE_CODE_RE.test(code)) return null;
    const row = this.db.get<{ id: Id }>(
      'SELECT id FROM classes WHERE invite_code = ? AND deleted_at IS NULL',
      code,
    );
    return row?.id ?? null;
  }

  /** Like classIdByInvite, but a missing class is the user-facing bad_invite error. */
  requireClassByInvite(code: string | undefined): Id {
    const classId = code ? this.classIdByInvite(code) : null;
    if (classId === null) {
      throw badRequest('Код запрошення недійсний', 'bad_invite');
    }
    return classId;
  }

  inviteInfo(code: string): InviteInfo {
    const row = INVITE_CODE_RE.test(code)
      ? this.db.get<InviteRow>(
          `SELECT c.id, c.name, c.subject, u.name AS owner_name
           FROM classes c JOIN users u ON u.id = c.owner_id
           WHERE c.invite_code = ? AND c.deleted_at IS NULL`,
          code,
        )
      : undefined;
    if (!row) throw notFound('Запрошення не знайдено');
    return {
      code,
      class_name: row.name,
      subject: row.subject,
      teacher_name: row.owner_name,
    };
  }

  /** Smallest free student number 1..254, or a 409 when the class is full. */
  private nextNumber(classId: Id): number {
    const taken = new Set(
      this.db
        .all<{ number: number }>(
          "SELECT number FROM class_members WHERE class_id = ? AND role = 'student'",
          classId,
        )
        .map((row) => row.number),
    );
    for (let n = 1; n <= MAX_STUDENTS_PER_CLASS; n++) {
      if (!taken.has(n)) return n;
    }
    throw conflict(classFullMessage());
  }

  /**
   * Adds a student to the class and records member_joined (unless the teacher imports them).
   * Already a member: nothing changes.
   * Joins the caller's transaction if there is one (registration with an invite code).
   */
  joinAsStudent(
    classId: Id,
    student: Pick<AuthUser, 'id'>,
    options: { record: boolean } = { record: true },
  ): JoinResult {
    return this.db.tx(() => {
      const existing = this.db.get<{ number: number | null }>(
        'SELECT number FROM class_members WHERE class_id = ? AND user_id = ?',
        classId,
        student.id,
      );
      if (existing) return { number: existing.number ?? 0, joined: false };
      const owner = this.db.get<{ owner_id: Id }>(
        'SELECT owner_id FROM classes WHERE id = ?',
        classId,
      );
      if (owner?.owner_id === student.id) {
        throw forbidden('Власник класу не може вступити до нього як студент');
      }
      const number = this.nextNumber(classId);
      this.db.run(
        `INSERT INTO class_members (class_id, user_id, role, number, joined_at)
         VALUES (?, ?, 'student', ?, ?)`,
        classId,
        student.id,
        number,
        this.clock.now(),
      );
      if (options.record) {
        this.activity.record({
          class_id: classId,
          actor_id: student.id,
          student_id: student.id,
          kind: 'member_joined',
        });
      }
      return { number, joined: true };
    });
  }
}
