import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { LtiJwk, LtiPlatform, LtiToolInfo } from '@shared/api';
import type { Response } from 'express';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '../auth/auth.types';
import type { AuthedRequest, AuthUser } from '../auth/auth.types';
import { CurrentUser, Public } from '../auth/decorators';
import { SessionService } from '../auth/session.service';
import { ApiException } from '../common/api-exception';
import { IdPipe } from '../common/id.pipe';
import { CreatePlatformDto } from './dto';
import { LtiKeysService } from './lti-keys.service';
import { LtiError, refusalPage } from './lti-error';
import { LtiLaunchService } from './lti-launch.service';
import { LtiPlatformsService } from './lti-platforms.service';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** Entry of LTI platforms (any LMS) plus the teacher's registration of platforms. */
@Controller('api/lti')
export class LtiController {
  private readonly log = new Logger(LtiController.name);

  constructor(
    private readonly platforms: LtiPlatformsService,
    private readonly launcher: LtiLaunchService,
    private readonly keys: LtiKeysService,
    private readonly sessions: SessionService,
  ) {}

  @Get('tool')
  tool(@CurrentUser() user: AuthUser): LtiToolInfo {
    return this.platforms.tool(user);
  }

  @Get('platforms')
  list(@CurrentUser() user: AuthUser): LtiPlatform[] {
    return this.platforms.list(user);
  }

  @Post('platforms')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePlatformDto,
  ): LtiPlatform {
    return this.platforms.create(user, body);
  }

  @Delete('platforms/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): void {
    this.platforms.remove(user, id);
  }

  @Public()
  @Get('jwks')
  jwks(): Promise<{ keys: LtiJwk[] }> {
    return this.keys.publicJwks();
  }

  @Public()
  @Get('login')
  loginByGet(@Req() request: AuthedRequest, @Res() res: Response): void {
    this.login(asRecord(request.query), res);
  }

  @Public()
  @Post('login')
  loginByPost(@Req() request: AuthedRequest, @Res() res: Response): void {
    this.login(asRecord(request.body), res);
  }

  @Public()
  @Post('launch')
  async launch(
    @Req() request: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const result = await this.launcher.launch(asRecord(request.body));
      if (result.kind === 'student') {
        res.cookie(
          SESSION_COOKIE,
          this.sessions.create(result.userId),
          SESSION_COOKIE_OPTIONS,
        );
        res.redirect(303, `/assignments/${result.assignmentId}`);
        return;
      }
      const page = `/classes/${result.classId}?a=${result.assignmentId}`;
      const signedIn = request.user?.id === result.ownerId;
      res.redirect(
        303,
        signedIn ? page : `/login?next=${encodeURIComponent(page)}`,
      );
    } catch (error) {
      this.refuse(res, error);
    }
  }

  private login(params: Record<string, unknown>, res: Response): void {
    try {
      res.redirect(302, this.launcher.beginLogin(params));
    } catch (error) {
      this.refuse(res, error);
    }
  }

  private refuse(res: Response, error: unknown): void {
    if (error instanceof LtiError || error instanceof ApiException) {
      const status =
        error instanceof LtiError ? error.status : error.getStatus();
      this.send(res, status, error.message);
      return;
    }
    this.log.error(
      'LTI request failed',
      error instanceof Error ? error.stack : error,
    );
    this.send(res, 500, 'Помилка сервера');
  }

  private send(res: Response, status: number, message: string): void {
    res
      .status(status)
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(refusalPage(message));
  }
}
