import { Injectable } from '@nestjs/common';
import type { CheckRun, Id, SubmissionSummary } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { badRequest } from '../common/api-exception';
import { CheckRunner } from './check-runner';
import { SubmissionLookup } from './submission-lookup';
import { VerifyRunner } from './verify-runner';

const NO_CHECKS_TEXT = 'У завданні немає команд перевірки';

/** What the routes of the runner do; the rights are checked here. */
@Injectable()
export class RunnerService {
  constructor(
    private readonly lookup: SubmissionLookup,
    private readonly verifier: VerifyRunner,
    private readonly checker: CheckRunner,
  ) {}

  /** Verifies the submission again. One that is already waiting or running is returned as it is. */
  verify(user: AuthUser, submissionId: Id): SubmissionSummary {
    this.lookup.taught(user, submissionId);
    this.verifier.requeue(submissionId);
    return this.lookup.summary(submissionId);
  }

  startCheckRun(user: AuthUser, submissionId: Id): CheckRun {
    const submission = this.lookup.taught(user, submissionId);
    if (submission.checks.length === 0) throw badRequest(NO_CHECKS_TEXT);
    return this.checker.start(submission, user.id);
  }

  /** Queues the newest submission of every student; returns how many were not already waiting. */
  verifyAll(user: AuthUser, assignmentId: Id): { queued: number } {
    this.lookup.assignmentTaught(user, assignmentId);
    const queued = this.lookup
      .latestOfAssignment(assignmentId)
      .filter((id) => this.verifier.requeue(id));
    return { queued: queued.length };
  }

  checkAll(user: AuthUser, assignmentId: Id): { queued: number } {
    const assignment = this.lookup.assignmentTaught(user, assignmentId);
    if (assignment.checks.length === 0) throw badRequest(NO_CHECKS_TEXT);
    const ids = this.lookup.latestOfAssignment(assignmentId);
    for (const id of ids) {
      this.checker.start(this.lookup.taught(user, id), user.id);
    }
    return { queued: ids.length };
  }
}
