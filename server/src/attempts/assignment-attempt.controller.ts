import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Attempt } from '@shared/api';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { AttemptsService } from './attempts.service';

const HTTP_OK = 200;

@Controller('api/assignments')
export class AssignmentAttemptController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get(':id/attempt')
  mine(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) assignmentId: number,
  ): Attempt {
    return this.attempts.mine(user, assignmentId);
  }

  /** 201 for a new attempt, 200 when it already existed. */
  @Post(':id/attempt')
  open(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) assignmentId: number,
    @Res({ passthrough: true }) res: Response,
  ): Attempt {
    const { attempt, created } = this.attempts.open(user, assignmentId);
    if (!created) res.status(HTTP_OK);
    return attempt;
  }
}
