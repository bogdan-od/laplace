import { Injectable } from '@nestjs/common';
import type {
  Assignment,
  AssignmentSummary,
  AssignBody,
  CheckCommand,
  ClassRole,
  Hint,
  HintSlot,
  Id,
  JournalRef,
  JournalRole,
  Topology,
} from '@shared/api';
import { UNDO_MS } from '@shared/limits';
import type { ReadStream } from 'node:fs';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, forbidden, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Access, isTeacherRole, type Need } from '../classes/access.service';
import type { ClassViewer } from '../classes/class-stats';
import { checkNodesExist, isSingleMachine } from '../content/rules';
import { Db } from '../db/db';
import { JournalStore } from '../journals/journal-store';
import type { PatchAssignmentDto } from './dto';
import { HintUses, Progress } from './providers';

const RESTORE_WINDOW_MS = UNDO_MS * 6;
const NOT_FOUND_TEXT = 'Завдання не знайдено';

interface AssignmentRow {
  id: Id;
  class_id: Id;
  /** NULL in the schema only for a hard-deleted item; items are deleted softly, so assignments of the API always have it. */
  item_id: Id;
  kind: 'task' | 'lesson';
  title: string;
  brief: string;
  topology: string;
  checks: string;
  hints: string;
  max_grade: number;
  due_at: number | null;
  shared_lan: number;
  frozen: number;
  created_at: number;
  deleted_at: number | null;
  class_name: string;
}

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.class_id, a.item_id, a.kind, a.title, a.brief, a.topology, a.checks, a.hints, a.max_grade,
         a.due_at, a.shared_lan, a.frozen, a.created_at, a.deleted_at, c.name AS class_name
  FROM assignments a JOIN classes c ON c.id = a.class_id`;

/** What the library hands over when an item is assigned: a frozen copy of its content. */
export interface ItemSnapshot {
  item_id: Id;
  kind: 'task' | 'lesson';
  title: string;
  brief: string;
  topology: Topology;
  checks: CheckCommand[];
  hints: Hint[];
  journals: { node: string; role: JournalRole; sha256: string }[];
}

/** Columns of assignments are written by this class only, so the JSON in them is ours. */
const parseJson = <T>(text: string): T => JSON.parse(text) as T;

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly activity: ActivityService,
    private readonly store: JournalStore,
    private readonly progress: Progress,
    private readonly hintUses: HintUses,
  ) {}

  get(user: AuthUser, id: Id): Assignment {
    const { row, role } = this.require(user, id, 'member');
    return this.view(row, { userId: user.id, role });
  }

  /** The class of an assignment, deleted ones included; null if there is no such assignment. */
  classIdOf(id: Id): Id | null {
    return (
      this.db.get<{ class_id: Id }>(
        'SELECT class_id FROM assignments WHERE id = ?',
        id,
      )?.class_id ?? null
    );
  }

  /** The "freeze everyone" flag, written by the WebSocket room on a teacher's `freeze`. */
  setFrozen(id: Id, frozen: boolean): void {
    this.db.run(
      'UPDATE assignments SET frozen = ? WHERE id = ?',
      frozen ? 1 : 0,
      id,
    );
  }

  patch(user: AuthUser, id: Id, dto: PatchAssignmentDto): Assignment {
    const { row } = this.require(user, id, 'teacher');
    const checks = dto.checks ?? parseJson<CheckCommand[]>(row.checks);
    if (dto.checks) checkNodesExist(checks, parseJson<Topology>(row.topology));
    this.db.run(
      `UPDATE assignments SET title = ?, brief = ?, due_at = ?, max_grade = ?, checks = ? WHERE id = ?`,
      dto.title ?? row.title,
      dto.brief ?? row.brief,
      dto.due_at === undefined ? row.due_at : dto.due_at,
      dto.max_grade ?? row.max_grade,
      JSON.stringify(checks),
      id,
    );
    return this.get(user, id);
  }

  remove(user: AuthUser, id: Id): null {
    this.require(user, id, 'teacher');
    this.db.run(
      'UPDATE assignments SET deleted_at = ? WHERE id = ?',
      this.clock.now(),
      id,
    );
    return null;
  }

  /** Undo of remove(), valid for RESTORE_WINDOW_MS; restoring a live assignment returns it. */
  restore(user: AuthUser, id: Id): Assignment {
    const row = this.find(id);
    if (!row) throw notFound(NOT_FOUND_TEXT);
    this.roleIn(user, row);
    const role = this.access.require(user.id, row.class_id, 'teacher');
    if (row.deleted_at !== null) {
      if (this.clock.now() - row.deleted_at > RESTORE_WINDOW_MS) {
        throw notFound(NOT_FOUND_TEXT);
      }
      this.db.run('UPDATE assignments SET deleted_at = NULL WHERE id = ?', id);
    }
    return this.view({ ...row, deleted_at: null }, { userId: user.id, role });
  }

  /** The journal file of one machine; a student may take only the `start` journal. */
  journal(
    user: AuthUser,
    id: Id,
    node: string,
    role: JournalRole,
  ): { stream: ReadStream; size: number } {
    const { role: classRole } = this.require(user, id, 'member');
    if (role === 'reference' && !isTeacherRole(classRole)) {
      throw forbidden('Еталонний журнал доступний лише вчителю класу');
    }
    const found = this.db.get<{ journal_sha: string }>(
      `SELECT journal_sha FROM assignment_journals
       WHERE assignment_id = ? AND node_id = ? AND role = ?`,
      id,
      node,
      role,
    );
    if (!found) throw notFound('Журнал не знайдено');
    return {
      stream: this.store.open(found.journal_sha),
      size: this.store.size(found.journal_sha),
    };
  }

  /** Copies a library item into a class. */
  createFromItem(
    user: AuthUser,
    snapshot: ItemSnapshot,
    body: AssignBody,
  ): Assignment {
    this.access.require(user.id, body.class_id, 'teacher');
    if (body.shared_lan && !isSingleMachine(snapshot.topology)) {
      throw badRequest(
        'Спільна мережа можлива лише для однієї машини без з’єднань',
      );
    }
    if (
      snapshot.kind === 'lesson' &&
      !snapshot.journals.some((journal) => journal.role === 'start')
    ) {
      throw badRequest('Урок без журналу не можна видати');
    }
    const id = this.db.tx(() => {
      const created = this.db.run(
        `INSERT INTO assignments
           (class_id, item_id, kind, title, brief, topology, checks, hints, max_grade, due_at,
            shared_lan, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        body.class_id,
        snapshot.item_id,
        snapshot.kind,
        snapshot.title,
        snapshot.brief,
        JSON.stringify(snapshot.topology),
        JSON.stringify(snapshot.checks),
        JSON.stringify(snapshot.hints),
        body.max_grade,
        body.due_at,
        body.shared_lan ? 1 : 0,
        this.clock.now(),
      );
      for (const journal of snapshot.journals) {
        this.db.run(
          `INSERT INTO assignment_journals (assignment_id, node_id, role, journal_sha)
           VALUES (?, ?, ?, ?)`,
          created.id,
          journal.node,
          journal.role,
          journal.sha256,
        );
      }
      this.activity.record({
        class_id: body.class_id,
        assignment_id: created.id,
        actor_id: user.id,
        kind: 'assignment_created',
        text: snapshot.title,
      });
      return created.id;
    });
    return this.get(user, id);
  }

  /** Live assignments of a class, newest first (the class page and ClassDetail.assignments). */
  summaries(classId: Id, viewer: ClassViewer): AssignmentSummary[] {
    const rows = this.db.all<AssignmentRow>(
      `${ASSIGNMENT_SELECT} WHERE a.class_id = ? AND a.deleted_at IS NULL
       ORDER BY a.created_at DESC, a.id DESC`,
      classId,
    );
    return rows.map((row) => this.summary(row, viewer));
  }

  /** Earliest due date of the class that is not in the past. */
  nextDueAt(classId: Id): number | null {
    const row = this.db.get<{ due: number | null }>(
      `SELECT MIN(due_at) AS due FROM assignments
       WHERE class_id = ? AND deleted_at IS NULL AND due_at >= ?`,
      classId,
      this.clock.now(),
    );
    return row?.due ?? null;
  }

  private find(id: Id): AssignmentRow | undefined {
    return this.db.get<AssignmentRow>(
      `${ASSIGNMENT_SELECT} WHERE a.id = ?`,
      id,
    );
  }

  /** The user's role in the assignment's class; a stranger gets 404 so the id is not revealed. */
  private roleIn(user: AuthUser, row: AssignmentRow): ClassRole {
    const role = this.access.roleOf(user.id, row.class_id);
    if (role === null) throw notFound(NOT_FOUND_TEXT);
    return role;
  }

  private require(
    user: AuthUser,
    id: Id,
    need: Need,
  ): { row: AssignmentRow; role: ClassRole } {
    const row = this.find(id);
    if (!row || row.deleted_at !== null) throw notFound(NOT_FOUND_TEXT);
    this.roleIn(user, row);
    return { row, role: this.access.require(user.id, row.class_id, need) };
  }

  private summary(
    row: AssignmentRow,
    viewer: ClassViewer,
    progress = this.progress.assignment(row.id, viewer),
  ): AssignmentSummary {
    return {
      id: row.id,
      class_id: row.class_id,
      kind: row.kind,
      title: row.title,
      due_at: row.due_at,
      max_grade: row.max_grade,
      created_at: row.created_at,
      counts: progress.counts,
      my_status: progress.my_status,
      my_grade: progress.my_grade,
    };
  }

  private view(row: AssignmentRow, viewer: ClassViewer): Assignment {
    const teacher = isTeacherRole(viewer.role);
    const progress = this.progress.assignment(row.id, viewer);
    const opened = new Set(
      teacher ? [] : this.hintUses.opened(row.id, viewer.userId),
    );
    const hints: HintSlot[] = parseJson<Hint[]>(row.hints).map(
      (hint, index) => ({
        index,
        penalty: hint.penalty,
        text: teacher || opened.has(index) ? hint.text : null,
      }),
    );
    return {
      ...this.summary(row, viewer, progress),
      item_id: row.item_id,
      class_name: row.class_name,
      brief: row.brief,
      topology: parseJson<Topology>(row.topology),
      hints,
      checks: teacher ? parseJson<CheckCommand[]>(row.checks) : null,
      journals: this.journalRefs(row.id, teacher),
      shared_lan: row.shared_lan === 1,
      frozen: row.frozen === 1,
      my_attempt_id: progress.my_attempt_id,
    };
  }

  private journalRefs(assignmentId: Id, teacher: boolean): JournalRef[] {
    return this.db.all<JournalRef>(
      `SELECT j.node_id AS node, j.role, f.size
       FROM assignment_journals j JOIN journal_files f ON f.sha256 = j.journal_sha
       WHERE j.assignment_id = ?1 AND (?2 = 1 OR j.role = 'start')
       ORDER BY j.node_id, j.role`,
      assignmentId,
      teacher ? 1 : 0,
    );
  }
}
