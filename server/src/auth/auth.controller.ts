import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Me } from '@shared/api';
import type { Response } from 'express';
import { AuthService, LoggedIn } from './auth.service';
import type { AuthedRequest, AuthUser } from './auth.types';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from './auth.types';
import { CurrentUser, Public } from './decorators';
import { LoginDto, PatchMeDto, RegisterDto } from './dto';
import { SessionService } from './session.service';

const cookieToken = (request: AuthedRequest): unknown =>
  (request.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];

@Controller('api')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('auth/register')
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    return this.setSession(res, await this.auth.register(body));
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    return this.setSession(res, await this.auth.login(body));
  }

  @Post('auth/logout')
  @HttpCode(200)
  logout(
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): null {
    this.sessions.destroy(cookieToken(request));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Me {
    return this.auth.me(user.id);
  }

  @Patch('me')
  patchMe(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthedRequest,
    @Body() body: PatchMeDto,
  ): Promise<Me> {
    return this.auth.patchMe(user, cookieToken(request), body);
  }

  private setSession(res: Response, { me, token }: LoggedIn): Me {
    res.cookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
    return me;
  }
}
