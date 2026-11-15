import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { map, merge, Subscription } from 'rxjs';
import { Progress } from '../assignments/providers';
import { ProgressBus } from '../attempts/progress-bus';
import { describeError } from '../runner/describe-error';
import { RunnerBus } from '../runner/runner-bus';
import { RoomsService } from './rooms.service';

/** Recomputes a student's tile when something changes and sends it to the teachers in the room. */
@Injectable()
export class Tiles implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(Tiles.name);
  private subscription: Subscription | undefined;

  constructor(
    private readonly progressBus: ProgressBus,
    private readonly runner: RunnerBus,
    private readonly progress: Progress,
    private readonly rooms: RoomsService,
  ) {}

  onModuleInit(): void {
    this.subscription = merge(
      this.progressBus.progress$,
      this.runner.submissionStatus$.pipe(
        map((event) => ({
          assignment_id: event.assignment_id,
          user_id: event.student_id,
        })),
      ),
    ).subscribe((event) => {
      try {
        this.send(event.assignment_id, event.user_id);
      } catch (error) {
        this.log.error(`tile not delivered: ${describeError(error)}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private send(assignmentId: number, userId: number): void {
    const teachers = this.rooms.teachersOf(assignmentId);
    if (teachers.length === 0) return;
    const progress = this.progress.student(assignmentId, userId);
    if (!progress) return;
    for (const teacher of teachers) {
      teacher.send({ type: 'tile', assignment_id: assignmentId, progress });
    }
  }
}
