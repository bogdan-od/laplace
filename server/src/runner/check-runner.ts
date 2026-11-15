import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Journal } from '@core/core/journal.mjs';
import type { BuiltTopology } from '@core/net/topology.mjs';
import type {
  CheckCommand,
  CheckResult,
  CheckRun,
  CheckRunStatus,
  Id,
} from '@shared/api';
import { Clock } from '../common/clock';
import { topologyCore, topologyJournalsCore } from '../core';
import { Db } from '../db/db';
import { describeError } from './describe-error';
import { MachineFactory } from './machine-factory';
import { RunnerBus } from './runner-bus';
import { RunnerConfig } from './runner-config';
import type { ServerMachine } from './server-machine';
import { SlotPool } from './slot-pool';
import { JournalRejected, SubmissionJournals } from './submission-journals';
import type { SubmissionContext } from './submission-lookup';

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const RESTART_TEXT = 'Сервер перезапущено, перевірку перервано';
const INTERNAL_ERROR_TEXT = 'Внутрішня помилка під час перевірки';

/** A failure whose `message` is written for the teacher. */
class RunFailed extends Error {}

interface RunRow {
  id: Id;
  submission_id: Id;
  status: CheckRunStatus;
  results: string;
  message: string | null;
  created_at: number;
  finished_at: number | null;
}

type Machines = Map<string, ServerMachine>;

/**
 * "Run check": replays the machines of a submission on the server, lets them go live together and
 * runs the teacher's commands through the system channel one by one. A run waits for worker slots
 * like verification does and takes one slot per machine of the topology.
 */
@Injectable()
export class CheckRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(CheckRunner.name);
  private readonly active = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: RunnerConfig,
    private readonly pool: SlotPool,
    private readonly machines: MachineFactory,
    private readonly journals: SubmissionJournals,
    private readonly bus: RunnerBus,
  ) {}

  /** A run cut short by a restart is not resumed: the teacher presses the button again. */
  onApplicationBootstrap(): void {
    this.db.run(
      `UPDATE check_runs SET status = 'failed', message = ?, finished_at = ?
       WHERE status IN ('queued', 'running')`,
      RESTART_TEXT,
      this.clock.now(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.machines.stopAll();
    await Promise.allSettled([...this.active]);
  }

  /** Resolves when no run is waiting or running. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  /** Records a `queued` run, starts it in the background and returns it at once. */
  start(submission: SubmissionContext, startedBy: Id): CheckRun {
    const { id } = this.db.run(
      `INSERT INTO check_runs (submission_id, started_by, status, results, created_at)
       VALUES (?, ?, 'queued', '[]', ?)`,
      submission.id,
      startedBy,
      this.clock.now(),
    );
    const job = this.execute(id, submission, startedBy);
    this.active.add(job);
    void job.finally(() => this.active.delete(job));
    return this.view(id);
  }

  private async execute(
    runId: Id,
    submission: SubmissionContext,
    startedBy: Id,
  ): Promise<void> {
    const release = await this.pool.acquire(
      submission.topology.machines.length,
    );
    try {
      if (this.stopped) return;
      this.db.run(
        "UPDATE check_runs SET status = 'running' WHERE id = ?",
        runId,
      );
      this.publish(runId, startedBy);
      await this.perform(runId, submission, startedBy);
      if (this.stopped) return;
      this.finish(runId, startedBy, 'done', null);
    } catch (error) {
      if (this.stopped) return;
      this.finish(runId, startedBy, 'failed', this.explain(error));
    } finally {
      release();
    }
  }

  private async perform(
    runId: Id,
    submission: SubmissionContext,
    startedBy: Id,
  ): Promise<void> {
    const journals = await this.loadJournals(submission);
    const created: ServerMachine[] = [];
    let built: BuiltTopology<ServerMachine> | undefined;
    try {
      built = topologyCore().build_topology<ServerMachine>(
        submission.topology,
        {
          create_machine: (description) => {
            const journal = journals.get(description.id);
            if (!journal) {
              throw new RunFailed(`Немає журналу машини "${description.id}"`);
            }
            const machine = this.machines.create({
              id: description.id,
              journal,
            });
            created.push(machine);
            return machine;
          },
        },
      );
      await this.launch(built.machines);
      const results: CheckResult[] = [];
      for (const check of submission.checks) {
        if (this.stopped) return;
        results.push(
          await this.runCommand(built.machines, check, submission.variant),
        );
        this.db.run(
          'UPDATE check_runs SET results = ? WHERE id = ?',
          JSON.stringify(results),
          runId,
        );
        this.publish(runId, startedBy);
      }
    } finally {
      built?.teardown();
      await Promise.all(created.map((machine) => machine.stop()));
    }
  }

  private async loadJournals(
    submission: SubmissionContext,
  ): Promise<Map<string, Journal>> {
    const order = submission.topology.machines.map((machine) => machine.id);
    try {
      const loaded = await this.journals.load(submission.id, order);
      return new Map(loaded.map(({ node, journal }) => [node, journal]));
    } catch (error) {
      if (error instanceof JournalRejected) {
        throw new RunFailed(`${error.node}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Replays every journal at full speed, then switches all machines to live mode together. */
  private async launch(machines: Machines): Promise<void> {
    const { launch_topology } = topologyJournalsCore();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new RunFailed(
              `Машини не запустилися за ${this.config.timeoutMs / 1000} с`,
            ),
          ),
        this.config.timeoutMs,
      );
    });
    try {
      await Promise.race([launch_topology(machines, machines.keys()), expired]);
    } catch (error) {
      if (error instanceof RunFailed) throw error;
      throw new RunFailed(
        error instanceof Error ? error.message : INTERNAL_ERROR_TEXT,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async runCommand(
    machines: Machines,
    check: CheckCommand,
    variant: number,
  ): Promise<CheckResult> {
    const base = {
      node: check.node,
      title: check.title,
      command: check.command,
    };
    const machine = machines.get(check.node);
    if (!machine) {
      return {
        ...base,
        rc: null,
        output: `Машини "${check.node}" немає в топології`,
      };
    }
    try {
      const { rc, output } = await machine.system(
        check.command.replaceAll('{n}', String(variant)),
        {
          timeout_ms: COMMAND_TIMEOUT_MS,
        },
      );
      return { ...base, rc, output: truncate(output) };
    } catch (error) {
      const text = error instanceof Error ? error.message : INTERNAL_ERROR_TEXT;
      return { ...base, rc: null, output: truncate(text) };
    }
  }

  private explain(error: unknown): string {
    if (error instanceof RunFailed) return error.message;
    this.log.error(`check run crashed: ${describeError(error)}`);
    return INTERNAL_ERROR_TEXT;
  }

  private finish(
    runId: Id,
    startedBy: Id,
    status: 'done' | 'failed',
    message: string | null,
  ): void {
    this.db.run(
      'UPDATE check_runs SET status = ?, message = ?, finished_at = ? WHERE id = ?',
      status,
      message,
      this.clock.now(),
      runId,
    );
    this.publish(runId, startedBy);
  }

  private publish(runId: Id, startedBy: Id): void {
    this.bus.emitCheckRun({ started_by: startedBy, run: this.view(runId) });
  }

  private view(id: Id): CheckRun {
    const row = this.db.get<RunRow>(
      `SELECT id, submission_id, status, results, message, created_at, finished_at
       FROM check_runs WHERE id = ?`,
      id,
    );
    if (!row) throw new Error(`check run ${id} vanished`);
    return {
      id: row.id,
      submission_id: row.submission_id,
      status: row.status,
      results: JSON.parse(row.results) as CheckResult[],
      message: row.message,
      created_at: row.created_at,
      finished_at: row.finished_at,
    };
  }
}

/** Cuts the output to 64 KiB; a character cut in half becomes the replacement character. */
function truncate(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= MAX_OUTPUT_BYTES) return output;
  return bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
}
