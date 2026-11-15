import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Id, VerifyStatus } from '@shared/api';
import { ActivityService } from '../activity/activity.service';
import { VerifyQueue, type VerifyQueueBackend } from '../attempts/verify-queue';
import { Clock } from '../common/clock';
import { journalCore } from '../core';
import { Db } from '../db/db';
import { MachineFactory } from './machine-factory';
import { replayJournal } from './replay';
import { RunnerBus } from './runner-bus';
import { describeError } from './describe-error';
import { RunnerConfig } from './runner-config';
import { SlotPool } from './slot-pool';
import {
  JournalRejected,
  type LoadedJournal,
  SubmissionJournals,
} from './submission-journals';
import { type SubmissionContext, SubmissionLookup } from './submission-lookup';

const INTERNAL_ERROR_TEXT = 'Внутрішня помилка під час перевірки';

interface Outcome {
  status: Extract<VerifyStatus, 'ok' | 'tail_unchecked' | 'failed' | 'timeout'>;
  message: string | null;
  commands: number | null;
}

/**
 * The verification queue. The queue itself is the `verify_status` column: a submission is
 * `queued` until a worker slot is free, `running` while its machines are replayed one by one, and
 * then `ok`, `tail_unchecked`, `failed` or `timeout`. On start everything still `queued` or
 * `running` goes back into the queue.
 */
@Injectable()
export class VerifyRunner
  implements
    VerifyQueueBackend,
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy
{
  private readonly log = new Logger(VerifyRunner.name);
  private readonly active = new Map<Id, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: RunnerConfig,
    private readonly pool: SlotPool,
    private readonly machines: MachineFactory,
    private readonly lookup: SubmissionLookup,
    private readonly journals: SubmissionJournals,
    private readonly activity: ActivityService,
    private readonly bus: RunnerBus,
    private readonly queue: VerifyQueue,
  ) {}

  onModuleInit(): void {
    this.queue.use(this);
  }

  onApplicationBootstrap(): void {
    this.db.run(
      "UPDATE submissions SET verify_status = 'queued' WHERE verify_status = 'running'",
    );
    const waiting = this.db.all<{ id: Id }>(
      "SELECT id FROM submissions WHERE verify_status = 'queued' ORDER BY id",
    );
    for (const { id } of waiting) this.enqueue(id);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.machines.stopAll();
    await Promise.allSettled([...this.active.values()]);
  }

  /**
   * Puts a submission whose row says `queued` into the in-memory queue and announces the `queued`
   * status; a second call changes nothing.
   */
  enqueue(id: Id): void {
    if (this.stopped || this.active.has(id)) return;
    const submission = this.lookup.byId(id);
    if (submission) this.publish(submission);
    const job = this.verify(id).finally(() => this.active.delete(id));
    this.active.set(id, job);
  }

  /** Resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  /**
   * Sets the status of a submission to `queued` for a new verification and queues it. Returns
   * false when it is already queued or running.
   */
  requeue(id: Id): boolean {
    const current = this.lookup.byId(id);
    if (!current) return false;
    if (
      current.verify_status === 'queued' ||
      current.verify_status === 'running'
    ) {
      return false;
    }
    this.db.run(
      `UPDATE submissions SET verify_status = 'queued', verify_message = NULL,
         verified_at = NULL, commands_count = NULL WHERE id = ?`,
      id,
    );
    this.enqueue(id);
    return true;
  }

  private async verify(id: Id): Promise<void> {
    const release = await this.pool.acquire(1);
    try {
      if (this.stopped) return;
      const submission = this.lookup.byId(id);
      if (!submission) return;
      this.db.run(
        "UPDATE submissions SET verify_status = 'running' WHERE id = ?",
        id,
      );
      this.publish(submission);
      const outcome = await this.check(submission);
      if (this.stopped) return;
      this.finish(submission, outcome);
    } catch (error) {
      if (this.stopped) return;
      this.log.error(
        `verification of submission ${id} crashed: ${describeError(error)}`,
      );
      this.finishSafely(id, {
        status: 'failed',
        message: INTERNAL_ERROR_TEXT,
        commands: null,
      });
    } finally {
      release();
    }
  }

  private async check(submission: SubmissionContext): Promise<Outcome> {
    const order = submission.topology.machines.map((machine) => machine.id);
    let loaded: LoadedJournal[];
    try {
      loaded = await this.journals.load(submission.id, order);
    } catch (error) {
      if (error instanceof JournalRejected) {
        return {
          status: 'failed',
          message: `${error.node}: ${error.message}`,
          commands: null,
        };
      }
      throw error;
    }
    const { commands } = journalCore();
    const count = loaded.reduce(
      (sum, { journal }) => sum + commands(journal.events).length,
      0,
    );
    let tailChecked = true;
    for (const { node, journal } of loaded) {
      const verdict = await replayJournal(
        this.machines,
        node,
        journal,
        this.config.timeoutMs,
      );
      if (verdict.kind === 'failed') {
        return {
          status: 'failed',
          message: `${node}: ${verdict.message}`,
          commands: count,
        };
      }
      if (verdict.kind === 'timeout') {
        return {
          status: 'timeout',
          message: `${node}: повтор не вклався в ${this.config.timeoutMs / 1000} с`,
          commands: count,
        };
      }
      if (journal.events.at(-1)?.t !== 'check') tailChecked = false;
    }
    return {
      status: tailChecked ? 'ok' : 'tail_unchecked',
      message: null,
      commands: count,
    };
  }

  private finish(submission: SubmissionContext, outcome: Outcome): void {
    this.db.tx(() => {
      this.db.run(
        `UPDATE submissions SET verify_status = ?, verify_message = ?, verified_at = ?,
           commands_count = ? WHERE id = ?`,
        outcome.status,
        outcome.message,
        this.clock.now(),
        outcome.commands,
        submission.id,
      );
      if (
        (outcome.status === 'failed' || outcome.status === 'timeout') &&
        !submission.is_preview
      ) {
        this.activity.record({
          class_id: submission.class_id,
          assignment_id: submission.assignment_id,
          actor_id: submission.student_id,
          student_id: submission.student_id,
          kind: 'verify_failed',
          ref_id: submission.id,
          text: submission.assignment_title,
        });
      }
    });
    this.publish(submission);
  }

  /** The last resort after a crash: never throws, so the queue keeps going. */
  private finishSafely(id: Id, outcome: Outcome): void {
    try {
      const submission = this.lookup.byId(id);
      if (submission) this.finish(submission, outcome);
    } catch (error) {
      this.log.error(
        `cannot record the failure of submission ${id}: ${describeError(error)}`,
      );
    }
  }

  private publish(submission: SubmissionContext): void {
    this.bus.emitSubmission({
      assignment_id: submission.assignment_id,
      student_id: submission.student_id,
      submission: this.lookup.summary(submission.id),
    });
  }
}
