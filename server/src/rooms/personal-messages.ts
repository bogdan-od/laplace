import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import { ActivityService } from '../activity/activity.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { Access } from '../classes/access.service';
import { describeError } from '../runner/describe-error';
import { RunnerBus } from '../runner/runner-bus';
import { Connections } from './connections';

/**
 * Messages addressed to a user rather than to a room: `notify`, `submission` and `check-run`.
 * They reach every connection of the user, joined or not.
 */
@Injectable()
export class PersonalMessages implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PersonalMessages.name);
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly activity: ActivityService,
    private readonly runner: RunnerBus,
    private readonly access: Access,
    private readonly assignments: AssignmentsService,
    private readonly connections: Connections,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.activity.activity$.subscribe((activity) =>
        this.guard('notify', () =>
          this.connections.sendToUsers(this.activity.recipients(activity), {
            type: 'notify',
            activity,
          }),
        ),
      ),
      this.runner.submissionStatus$.subscribe((event) =>
        this.guard('submission', () => {
          const classId = this.assignments.classIdOf(event.assignment_id);
          if (classId === null) return;
          this.connections.sendToUsers(
            [event.student_id, ...this.access.teacherIds(classId)],
            {
              type: 'submission',
              assignment_id: event.assignment_id,
              student_id: event.student_id,
              submission: event.submission,
            },
          );
        }),
      ),
      this.runner.checkRun$.subscribe((event) =>
        this.guard('check-run', () =>
          this.connections.sendToUsers([event.started_by], {
            type: 'check-run',
            run: event.run,
          }),
        ),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
  }

  /** An error in a subscriber would be rethrown by RxJS outside any handler and end the process. */
  private guard(what: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.log.error(`${what} not delivered: ${describeError(error)}`);
    }
  }
}
