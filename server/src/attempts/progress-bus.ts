import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import { Observable, Subject } from 'rxjs';
import { Db } from '../db/db';

/** A student's tile may have changed. The WebSocket gateway recomputes `StudentProgress` and sends `tile`. */
export interface ProgressEvent {
  assignment_id: Id;
  user_id: Id;
}

@Injectable()
export class ProgressBus {
  private readonly subject = new Subject<ProgressEvent>();

  /** Fires after a chunk, a help request or its closing, a submission and a finished lesson. */
  readonly progress$: Observable<ProgressEvent> = this.subject.asObservable();

  constructor(private readonly db: Db) {}

  /** Publishes once the surrounding transaction has committed. */
  emit(event: ProgressEvent): void {
    this.db.afterCommit(() => this.subject.next(event));
  }
}
