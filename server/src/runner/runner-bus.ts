import { Injectable } from '@nestjs/common';
import type { CheckRun, Id, SubmissionSummary } from '@shared/api';
import { Observable, Subject } from 'rxjs';

/** A submission changed its verification status. The WebSocket gateway sends it as the WS message `submission`. */
export interface SubmissionStatusEvent {
  assignment_id: Id;
  student_id: Id;
  submission: SubmissionSummary;
}

/**
 * A check run changed. The WebSocket gateway sends `run` as the WS message `check-run` to the teacher who started it.
 */
export interface CheckRunEvent {
  started_by: Id;
  run: CheckRun;
}

@Injectable()
export class RunnerBus {
  private readonly submissions = new Subject<SubmissionStatusEvent>();
  private readonly runs = new Subject<CheckRunEvent>();

  /** Every status change: queued, running and the final one. */
  readonly submissionStatus$: Observable<SubmissionStatusEvent> =
    this.submissions.asObservable();
  /** Every change of a check run: status and each finished command. */
  readonly checkRun$: Observable<CheckRunEvent> = this.runs.asObservable();

  emitSubmission(event: SubmissionStatusEvent): void {
    this.submissions.next(event);
  }

  emitCheckRun(event: CheckRunEvent): void {
    this.runs.next(event);
  }
}
