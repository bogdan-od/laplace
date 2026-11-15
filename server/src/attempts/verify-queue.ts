import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';

/** What the submission route needs from the verification queue. */
export interface VerifyQueueBackend {
  /** Called once per new submission, after the transaction that created it has committed. */
  enqueue(submissionId: Id): void;
}

const DO_NOTHING: VerifyQueueBackend = { enqueue: () => undefined };

/** Entry point of the queue. Until the verifier plugs in its implementation with `use`, nothing is verified. */
@Injectable()
export class VerifyQueue implements VerifyQueueBackend {
  private backend: VerifyQueueBackend = DO_NOTHING;

  use(backend: VerifyQueueBackend): void {
    this.backend = backend;
  }

  enqueue(submissionId: Id): void {
    this.backend.enqueue(submissionId);
  }
}
