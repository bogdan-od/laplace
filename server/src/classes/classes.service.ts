import { Injectable } from '@nestjs/common';
import type {
  ClassDetail,
  ClassRole,
  ClassSummary,
  Id,
  Member,
  MemberRole,
  MyAssignment,
} from '@shared/api';
import { UNDO_MS } from '@shared/limits';
import type { AuthUser } from '../auth/auth.types';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db, isUniqueViolation } from '../db/db';
import { UsersService } from '../users/users.service';
import { Access, isTeacherRole } from './access.service';
import { ClassStats } from './class-stats';
import { AddAssistantDto, CreateClassDto, PatchClassDto } from './dto';
import { newInviteCode } from './invite-code';
import { MembershipService } from './membership.service';

/** How long a deleted class can still be restored. */
const RESTORE_WINDOW_MS = UNDO_MS * 6;
const INVITE_RETRIES = 10;

interface ClassRow {
  id: Id;
  owner_id: Id;
  owner_name: string;
  name: string;
  subject: string;
  invite_code: string;
  is_demo: number;
  deleted_at: number | null;
  students: number;
}

interface MemberRow {
  user_id: Id;
  name: string;
  login: string;
  role: MemberRole;
  number: number | null;
  joined_at: number;
  last_seen_at: number | null;
}

const CLASS_COLUMNS = `
  c.id, c.owner_id, o.name AS owner_name, c.name, c.subject, c.invite_code, c.is_demo,
  c.deleted_at,
  (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS students`;
const CLASS_FROM = 'FROM classes c JOIN users o ON o.id = c.owner_id';

@Injectable()
export class ClassesService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly stats: ClassStats,
    private readonly users: UsersService,
    private readonly membership: MembershipService,
  ) {}

  list(user: AuthUser): ClassSummary[] {
    const rows = this.db.all<ClassRow & { member_role: MemberRole | null }>(
      `SELECT mine.role AS member_role, ${CLASS_COLUMNS} ${CLASS_FROM}
       LEFT JOIN class_members mine ON mine.class_id = c.id AND mine.user_id = ?1
       WHERE c.deleted_at IS NULL AND (c.owner_id = ?1 OR mine.user_id IS NOT NULL)
       ORDER BY c.created_at, c.id`,
      user.id,
    );
    return rows.map((row) => {
      const role = row.owner_id === user.id ? 'owner' : row.member_role;
      return this.summary(row, role ?? 'student', user.id);
    });
  }

  /** Assignments of every class where the user is a student, for the student's home page. */
  myAssignments(user: AuthUser): MyAssignment[] {
    const rows = this.db.all<{ id: Id; name: string }>(
      `SELECT c.id, c.name FROM classes c
       JOIN class_members m ON m.class_id = c.id AND m.user_id = ?1 AND m.role = 'student'
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at, c.id`,
      user.id,
    );
    const frozen = new Set(
      this.db
        .all<{ id: Id }>(
          `SELECT a.id FROM assignments a
           JOIN class_members m ON m.class_id = a.class_id AND m.user_id = ?1 AND m.role = 'student'
           WHERE a.frozen = 1 AND a.deleted_at IS NULL`,
          user.id,
        )
        .map((row) => row.id),
    );
    return rows.flatMap((row) =>
      this.stats
        .assignments(row.id, { userId: user.id, role: 'student' })
        .map((assignment) => ({
          ...assignment,
          class_name: row.name,
          frozen: frozen.has(assignment.id),
        })),
    );
  }

  detail(user: AuthUser, classId: Id): ClassDetail {
    const role = this.access.require(user.id, classId, 'member');
    return this.detailOf(classId, role, user.id);
  }

  create(user: AuthUser, dto: CreateClassDto): ClassDetail {
    if (user.role !== 'teacher') {
      throw forbidden('Створювати класи можуть лише вчителі');
    }
    const id = this.insertWithFreshCode(
      (code) =>
        this.db.run(
          `INSERT INTO classes (owner_id, name, subject, invite_code, created_at)
         VALUES (?, ?, ?, ?, ?)`,
          user.id,
          dto.name,
          dto.subject,
          code,
          this.clock.now(),
        ).id,
    );
    return this.detailOf(id, 'owner', user.id);
  }

  patch(user: AuthUser, classId: Id, dto: PatchClassDto): ClassDetail {
    const role = this.access.require(user.id, classId, 'teacher');
    this.db.run(
      'UPDATE classes SET name = COALESCE(?, name), subject = COALESCE(?, subject) WHERE id = ?',
      dto.name ?? null,
      dto.subject ?? null,
      classId,
    );
    return this.detailOf(classId, role, user.id);
  }

  remove(user: AuthUser, classId: Id): null {
    this.access.require(user.id, classId, 'owner');
    this.db.run(
      'UPDATE classes SET deleted_at = ? WHERE id = ?',
      this.clock.now(),
      classId,
    );
    return null;
  }

  /** Undo of remove(). Valid for RESTORE_WINDOW_MS after the delete; restoring a live class is a no-op. */
  restore(user: AuthUser, classId: Id): ClassDetail {
    const row = this.db.get<{ owner_id: Id; deleted_at: number | null }>(
      'SELECT owner_id, deleted_at FROM classes WHERE id = ?',
      classId,
    );
    if (!row) throw notFound('Клас не знайдено');
    if (row.deleted_at === null) {
      this.access.require(user.id, classId, 'owner');
    } else {
      const expired = this.clock.now() - row.deleted_at > RESTORE_WINDOW_MS;
      if (row.owner_id !== user.id || expired) {
        throw notFound('Клас не знайдено');
      }
      this.db.run('UPDATE classes SET deleted_at = NULL WHERE id = ?', classId);
    }
    return this.detailOf(classId, 'owner', user.id);
  }

  newInvite(user: AuthUser, classId: Id): ClassDetail {
    this.access.require(user.id, classId, 'owner');
    this.insertWithFreshCode((code) => {
      this.db.run(
        'UPDATE classes SET invite_code = ? WHERE id = ?',
        code,
        classId,
      );
      return classId;
    });
    return this.detailOf(classId, 'owner', user.id);
  }

  addAssistant(user: AuthUser, classId: Id, dto: AddAssistantDto): ClassDetail {
    this.access.require(user.id, classId, 'owner');
    const target = this.users.byLogin(dto.login);
    if (!target) throw notFound('Користувача з таким логіном не знайдено');
    if (target.id === user.id) {
      throw badRequest('Власник класу вже має всі права');
    }
    const existing = this.db.get<{ role: MemberRole }>(
      'SELECT role FROM class_members WHERE class_id = ? AND user_id = ?',
      classId,
      target.id,
    );
    if (existing?.role === 'student') {
      throw conflict('Цей користувач уже навчається в цьому класі');
    }
    if (!existing) {
      this.db.run(
        `INSERT INTO class_members (class_id, user_id, role, number, joined_at)
         VALUES (?, ?, 'assistant', NULL, ?)`,
        classId,
        target.id,
        this.clock.now(),
      );
    }
    return this.detailOf(classId, 'owner', user.id);
  }

  removeMember(user: AuthUser, classId: Id, userId: Id): null {
    const role = this.access.require(user.id, classId, 'teacher');
    const member = this.db.get<{ role: MemberRole }>(
      'SELECT role FROM class_members WHERE class_id = ? AND user_id = ?',
      classId,
      userId,
    );
    if (!member) throw notFound('Учасника не знайдено');
    if (member.role === 'assistant' && role !== 'owner') {
      throw forbidden('Ця дія доступна лише власнику класу');
    }
    this.db.run(
      'DELETE FROM class_members WHERE class_id = ? AND user_id = ?',
      classId,
      userId,
    );
    return null;
  }

  accept(user: AuthUser, code: string): ClassSummary {
    const classId = this.membership.classIdByInvite(code);
    if (classId === null) throw notFound('Запрошення не знайдено');
    if (user.role !== 'student') {
      throw forbidden('Приєднатися за запрошенням може лише студент');
    }
    this.membership.joinAsStudent(classId, user);
    return this.summary(this.requireRow(classId), 'student', user.id);
  }

  private requireRow(classId: Id): ClassRow {
    const row = this.db.get<ClassRow>(
      `SELECT ${CLASS_COLUMNS} ${CLASS_FROM} WHERE c.id = ? AND c.deleted_at IS NULL`,
      classId,
    );
    if (!row) throw notFound('Клас не знайдено');
    return row;
  }

  private summary(row: ClassRow, role: ClassRole, userId: Id): ClassSummary {
    return {
      id: row.id,
      name: row.name,
      subject: row.subject,
      my_role: role,
      students: row.students,
      is_demo: row.is_demo === 1,
      ...this.stats.counters(row.id, { userId, role }),
    };
  }

  private detailOf(classId: Id, role: ClassRole, userId: Id): ClassDetail {
    const row = this.requireRow(classId);
    const teacher = isTeacherRole(role);
    return {
      ...this.summary(row, role, userId),
      owner: { id: row.owner_id, name: row.owner_name },
      invite_code: teacher ? row.invite_code : null,
      members: teacher ? this.members(classId) : [],
      assignments: this.stats.assignments(classId, { userId, role }),
    };
  }

  private members(classId: Id): Member[] {
    return this.db.all<MemberRow>(
      `SELECT m.user_id, u.name, u.login, m.role, m.number, m.joined_at, u.last_seen_at
       FROM class_members m JOIN users u ON u.id = m.user_id
       WHERE m.class_id = ?
       ORDER BY m.role, m.number, u.name`,
      classId,
    );
  }

  /** Retries on the (very unlikely) collision of two random 8-character codes. */
  private insertWithFreshCode(write: (code: string) => Id): Id {
    for (let attempt = 0; attempt < INVITE_RETRIES; attempt++) {
      try {
        return write(newInviteCode());
      } catch (error) {
        if (!isUniqueViolation(error, 'classes.invite_code')) throw error;
      }
    }
    throw new Error('could not generate a unique invite code');
  }
}
