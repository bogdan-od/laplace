import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { CheckRun, SubmissionSummary } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { RunnerService } from './runner.service';

@Controller('api/submissions')
export class SubmissionRunnerController {
  constructor(private readonly runner: RunnerService) {}

  @Post(':id/verify')
  @HttpCode(200)
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): SubmissionSummary {
    return this.runner.verify(user, id);
  }

  @Post(':id/check-runs')
  startCheckRun(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): CheckRun {
    return this.runner.startCheckRun(user, id);
  }
}

@Controller('api/assignments')
export class AssignmentRunnerController {
  constructor(private readonly runner: RunnerService) {}

  @Post(':id/verify-all')
  @HttpCode(200)
  verifyAll(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): { queued: number } {
    return this.runner.verifyAll(user, id);
  }

  @Post(':id/check-all')
  @HttpCode(200)
  checkAll(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): { queued: number } {
    return this.runner.checkAll(user, id);
  }
}
