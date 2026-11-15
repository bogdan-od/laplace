import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { notLoggedIn } from '../common/api-exception';
import { AuthedRequest, SESSION_COOKIE } from './auth.types';
import { IS_PUBLIC } from './decorators';
import { SessionService } from './session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const user = this.sessions.userFromToken(cookies?.[SESSION_COOKIE]);
    if (user) request.user = user;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (!user && !isPublic) throw notLoggedIn();
    return true;
  }
}
