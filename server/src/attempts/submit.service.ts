import { Injectable } from '@nestjs/common';
import type { Id, SubmissionSummary } from '@shared/api';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest } from '../common/api-exception';
import { Clock } from '../common/clock';
import { journalCore } from '../core';
import { Db } from '../db/db';
import { AttemptsAccess } from './attempts-access.service';
import { BranchJournals } from './branch-journals';
import type { SubmitDto } from './dto';
import { ProgressBus } from './progress-bus';
import { VerifyQueue } from './verify-queue';
import {
  SUBMISSION_SELECT,
  type SubmissionRow,
  toSubmissionSummary,
} from './views';

interface SubmittedHead {
  node: string;
  branch_id: Id;
  event_count: number;
  digest: string;
}

@Injectable()
export class SubmitService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly rights: AttemptsAccess,
    private readonly journals: BranchJournals,
    private readonly activity: ActivityService,
    private readonly progress: ProgressBus,
    private readonly queue: VerifyQueue,
  ) {}

  /**
   * Takes the given branch heads as the student's answer. It does not require the journals to end
   * with a `check`: that is verification's call (`tail_unchecked`), so a student whose machine
   * died can still submit.
   */
  submit(user: AuthUser, attemptId: Id, dto: SubmitDto): SubmissionSummary {
    const context = this.rights.owned(user, attemptId);
    this.rights.requireNotFrozen(context);
    const nodes = context.topology.machines.map((machine) => machine.id);
    this.requireExactNodes(nodes, dto);
    const heads = dto.heads.map((head) => this.checkHead(attemptId, head));
    const id = this.db.tx(() => {
      const created = this.db.run(
        'INSERT INTO submissions (attempt_id, created_at) VALUES (?, ?)',
        attemptId,
        this.clock.now(),
      );
      for (const head of heads) {
        this.db.run(
          `INSERT INTO submission_journals (submission_id, node_id, branch_id, event_count, digest)
           VALUES (?, ?, ?, ?, ?)`,
          created.id,
          head.node,
          head.branch_id,
          head.event_count,
          head.digest,
        );
      }
      // A teacher trying the task as a student must not notify the other teachers.
      if (!context.is_preview) {
        this.activity.record({
          class_id: context.class_id,
          assignment_id: context.assignment_id,
          actor_id: user.id,
          student_id: user.id,
          kind: 'submitted',
          ref_id: created.id,
          text: context.assignment_title,
        });
      }
      this.progress.emit({
        assignment_id: context.assignment_id,
        user_id: context.user_id,
      });
      this.db.afterCommit(() => this.queue.enqueue(created.id));
      return created.id;
    });
    const row = this.db.get<SubmissionRow>(
      `${SUBMISSION_SELECT} WHERE id = ?`,
      id,
    );
    if (!row) throw new Error(`submission ${id} vanished after insert`);
    return toSubmissionSummary(row);
  }

  /** The heads must name each machine of the topology once, and no other. */
  private requireExactNodes(nodes: string[], dto: SubmitDto): void {
    const given = dto.heads.map((head) => head.node);
    const duplicate = given.find((node, i) => given.indexOf(node) !== i);
    if (duplicate !== undefined) {
      throw badRequest(`Машина "${duplicate}" вказана двічі`);
    }
    const unknown = given.find((node) => !nodes.includes(node));
    if (unknown !== undefined) {
      throw badRequest(`Машини "${unknown}" немає в завданні`);
    }
    const missing = nodes.find((node) => !given.includes(node));
    if (missing !== undefined) {
      throw badRequest(`Не вистачає журналу машини "${missing}"`);
    }
  }

  private checkHead(
    attemptId: Id,
    head: SubmitDto['heads'][number],
  ): SubmittedHead {
    const branch = this.db.get<{ node_id: string; event_count: number }>(
      'SELECT node_id, event_count FROM branches WHERE id = ? AND attempt_id = ?',
      head.branch_id,
      attemptId,
    );
    if (!branch || branch.node_id !== head.node) {
      throw badRequest(
        `Гілка ${head.branch_id} не належить машині "${head.node}" цієї спроби`,
      );
    }
    if (head.event_count > branch.event_count) {
      throw badRequest(
        `Машина "${head.node}": на сервері лише ${branch.event_count} подій, а у здачі ${head.event_count}`,
      );
    }
    return { ...head, digest: this.digest(head.branch_id, head.event_count) };
  }

  /** journal_digest of the assembled journal; chunks are append-only, so it never changes. */
  private digest(branchId: Id, eventCount: number): string {
    const events = this.journals.events(branchId, eventCount);
    return journalCore().journal_digest({ events });
  }
}
