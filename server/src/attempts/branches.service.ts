import { Injectable } from '@nestjs/common';
import type {
  AppendResult,
  Branch,
  BranchDetail,
  ChunkInfo,
  Id,
  JournalEvent,
  JournalHeader,
  Topology,
} from '@shared/api';
import { MAX_CHUNK_BYTES, MAX_JOURNAL_BYTES } from '@shared/limits';
import type { Readable } from 'node:stream';
import type { AuthUser } from '../auth/auth.types';
import { ApiException, badRequest, forbidden } from '../common/api-exception';
import { Clock } from '../common/clock';
import { isTeacherRole } from '../classes/access.service';
import { journalCore } from '../core';
import { Db } from '../db/db';
import { coreMessage } from '../journals/journal-store';
import { type AttemptContext, AttemptsAccess } from './attempts-access.service';
import { BranchJournals } from './branch-journals';
import type { AppendEventsDto, CreateBranchDto } from './dto';
import { pathBytes } from './journal-path';
import { ProgressBus } from './progress-bus';
import {
  BRANCH_SELECT,
  type BranchRow,
  HELP_SELECT,
  type HelpRow,
  teacherInputsOf,
  toBranch,
  toHelp,
} from './views';

/** The tile shows at most this much of the last command. */
const MAX_LAST_COMMAND_CHARS = 200;

interface AppendState {
  event_count: number;
  last_c: number | null;
  last_w: number | null;
  header: string;
  kind: string;
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rights: AttemptsAccess,
    private readonly journals: BranchJournals,
    private readonly progress: ProgressBus,
  ) {}

  /**
   * A branch with the attempt it belongs to, for the player. Teacher input is the teacher's own view:
   * the student does not see it, as in a submission.
   */
  detail(user: AuthUser, branchId: Id): BranchDetail {
    const { attempt } = this.rights.readableBranch(user, branchId);
    const row = this.db.get<BranchRow>(
      `${BRANCH_SELECT} WHERE b.id = ?`,
      branchId,
    );
    if (!row) throw new Error(`branch ${branchId} vanished`);
    return {
      branch: toBranch(row),
      attempt_id: attempt.id,
      assignment: {
        id: attempt.assignment_id,
        title: attempt.assignment_title,
        class_id: attempt.class_id,
      },
      student: { id: attempt.user_id, name: attempt.user_name },
      machine: row.node_id,
      help_requests: this.db
        .all<HelpRow>(
          `${HELP_SELECT} WHERE h.attempt_id = ? ORDER BY h.id`,
          attempt.id,
        )
        .map(toHelp),
      teacher_inputs: isTeacherRole(attempt.role)
        ? teacherInputsOf(this.db, attempt.assignment_id, attempt.user_id)
        : [],
    };
  }

  create(user: AuthUser, attemptId: Id, dto: CreateBranchDto): Branch {
    const context = this.rights.readable(user, attemptId);
    this.requireMayCreate(user, context, dto);
    this.rights.requireNotFrozen(context);
    const profile = this.machineProfile(context.topology, dto.node);
    this.checkHeader(dto.header, profile);
    const fork = this.forkPoint(attemptId, dto);
    const id = this.db.tx(() => {
      const created = this.db.run(
        `INSERT INTO branches (attempt_id, node_id, parent_id, fork_event, kind, author_id, header,
                               event_count, last_c, last_w, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attemptId,
        dto.node,
        dto.parent?.branch_id ?? null,
        fork.event,
        dto.kind,
        user.id,
        JSON.stringify(dto.header),
        fork.event,
        fork.last?.c ?? null,
        fork.last?.w ?? null,
        this.clock.now(),
        this.clock.now(),
      );
      if (dto.make_head) {
        this.db.run(
          `INSERT INTO attempt_heads (attempt_id, node_id, branch_id) VALUES (?, ?, ?)
           ON CONFLICT (attempt_id, node_id) DO UPDATE SET branch_id = excluded.branch_id`,
          attemptId,
          dto.node,
          created.id,
        );
      }
      return created.id;
    });
    const row = this.db.get<BranchRow>(`${BRANCH_SELECT} WHERE b.id = ?`, id);
    if (!row) throw new Error(`branch ${id} vanished after insert`);
    return toBranch(row);
  }

  /** Appends a chunk. Nothing awaits between the checks and the commit, so they cannot go stale. */
  append(user: AuthUser, branchId: Id, dto: AppendEventsDto): AppendResult {
    const context = this.rights.writableBranch(user, branchId);
    const state = this.db.get<AppendState>(
      'SELECT event_count, last_c, last_w, header, kind FROM branches WHERE id = ?',
      branchId,
    );
    const path = this.journals.path(branchId);
    if (!state || !path) throw new Error(`branch ${branchId} vanished`);
    if (dto.from !== state.event_count) {
      throw new ApiException(
        409,
        'Початок фрагмента не збігається з кінцем журналу на сервері',
        'chunk_gap',
        { event_count: state.event_count },
      );
    }
    const text = JSON.stringify(dto.events);
    const bytes = Buffer.byteLength(text);
    if (
      bytes > MAX_CHUNK_BYTES ||
      pathBytes(path.branches) + bytes > MAX_JOURNAL_BYTES
    ) {
      throw new ApiException(413, 'Журнал завеликий', 'journal_too_large');
    }
    this.checkChunk(state, dto);
    const last = dto.events[dto.events.length - 1];
    if (!last) throw new Error('an empty chunk passed validation');
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO chunks (branch_id, first_event, event_count, bytes, events, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        branchId,
        dto.from,
        dto.events.length,
        bytes,
        text,
        now,
      );
      this.db.run(
        `UPDATE branches SET event_count = event_count + ?, bytes = bytes + ?, last_c = ?,
                             last_w = ?, updated_at = ? WHERE id = ?`,
        dto.events.length,
        bytes,
        last.c,
        last.w,
        now,
        branchId,
      );
      // A teacher's reply is not the student's activity: it must not move the student's tile.
      if (state.kind !== 'reply') {
        this.db.run(
          `UPDATE attempts SET last_activity_at = ?,
                               commands = COALESCE(?, commands),
                               last_command = COALESCE(?, last_command)
           WHERE id = ?`,
          now,
          dto.meta?.commands ?? null,
          dto.meta?.last_command.slice(0, MAX_LAST_COMMAND_CHARS) ?? null,
          context.attempt.id,
        );
      }
      this.progress.emit({
        assignment_id: context.attempt.assignment_id,
        user_id: context.attempt.user_id,
      });
    });
    return { event_count: state.event_count + dto.events.length };
  }

  /** The journal of a branch as a JSON stream, cut to `to` events. */
  journal(user: AuthUser, branchId: Id, to: number | undefined): Readable {
    this.rights.readableBranch(user, branchId);
    const branch = this.db.get<{ event_count: number }>(
      'SELECT event_count FROM branches WHERE id = ?',
      branchId,
    );
    if (to !== undefined && to > (branch?.event_count ?? 0)) {
      throw badRequest('Номер події виходить за межі журналу');
    }
    return this.journals.assemble(branchId, to);
  }

  chunks(user: AuthUser, branchId: Id): ChunkInfo[] {
    this.rights.readableBranch(user, branchId);
    return this.db.all<ChunkInfo>(
      `SELECT first_event, event_count, bytes, received_at FROM chunks
       WHERE branch_id = ? ORDER BY first_event`,
      branchId,
    );
  }

  /** `reply` is written by a teacher, the other kinds by the owner; `make_head` only by the owner. */
  private requireMayCreate(
    user: AuthUser,
    context: AttemptContext,
    dto: CreateBranchDto,
  ): void {
    if (dto.kind === 'reply') {
      if (!isTeacherRole(context.role)) {
        throw forbidden('Відповідь може створити лише вчитель класу');
      }
    } else if (!context.owner) {
      throw forbidden('Ця дія доступна лише автору спроби');
    }
    if (dto.make_head && !context.owner) {
      throw forbidden('Поточну гілку може змінювати лише автор спроби');
    }
  }

  private machineProfile(topology: Topology, node: string): string {
    const machine = topology.machines.find(
      (candidate) => candidate.id === node,
    );
    if (!machine) throw badRequest(`Машини "${node}" немає в завданні`);
    return machine.profile;
  }

  private checkHeader(header: JournalHeader, profile: string): void {
    try {
      journalCore().check_journal_strict({ header, events: [] });
    } catch (error) {
      throw badRequest(coreMessage(error), 'journal_invalid');
    }
    if (header.profile !== profile) {
      throw badRequest(
        `Профіль журналу "${header.profile}" не збігається з профілем машини "${profile}"`,
        'journal_invalid',
      );
    }
  }

  /** Where the new branch forks and the `c`/`w` of the event just before it. */
  private forkPoint(
    attemptId: Id,
    dto: CreateBranchDto,
  ): { event: number; last: { c: number; w: number } | null } {
    if (dto.kind === 'start') {
      if (dto.parent !== null) {
        throw badRequest('Початкова гілка не може мати батьківської');
      }
      const exists = this.db.get<{ id: Id }>(
        "SELECT id FROM branches WHERE attempt_id = ? AND node_id = ? AND kind = 'start'",
        attemptId,
        dto.node,
      );
      if (exists) {
        throw badRequest(`Для машини "${dto.node}" початкова гілка вже є`);
      }
      return { event: 0, last: null };
    }
    if (dto.parent === null) throw badRequest('Потрібна батьківська гілка');
    const parent = this.db.get<{ node_id: string; event_count: number }>(
      'SELECT node_id, event_count FROM branches WHERE id = ? AND attempt_id = ?',
      dto.parent.branch_id,
      attemptId,
    );
    if (!parent || parent.node_id !== dto.node) {
      throw badRequest('Батьківська гілка належить іншій спробі або машині');
    }
    if (dto.parent.event > parent.event_count) {
      throw badRequest(
        'Точка відкату лежить за межами журналу батьківської гілки',
      );
    }
    const path = this.journals.path(dto.parent.branch_id);
    if (!path) throw new Error('the parent branch vanished');
    return {
      event: dto.parent.event,
      last: this.journals.lastEvent(path.branches, dto.parent.event),
    };
  }

  /** Strict check of the chunk and the order against the end of the branch. */
  private checkChunk(state: AppendState, dto: AppendEventsDto): void {
    const core = journalCore();
    try {
      core.check_journal_strict({
        header: JSON.parse(state.header) as JournalHeader,
        events: dto.events,
      });
    } catch (error) {
      throw badRequest(
        `Фрагмент з події ${dto.from}: ${coreMessage(error)}`,
        'journal_invalid',
      );
    }
    if (dto.from + dto.events.length > core.JOURNAL_LIMITS.max_events) {
      throw badRequest(
        `Журнал: подій більше за ліміт ${core.JOURNAL_LIMITS.max_events}`,
        'journal_invalid',
      );
    }
    const first: JournalEvent | undefined = dto.events[0];
    if (
      first &&
      state.last_c !== null &&
      state.last_w !== null &&
      (first.c < state.last_c ||
        (first.c === state.last_c && first.w < state.last_w))
    ) {
      throw badRequest(
        `Подія ${dto.from} (${first.t}): порядок порушено: ${state.last_c}/${state.last_w} -> ${first.c}/${first.w}`,
        'journal_invalid',
      );
    }
  }
}
