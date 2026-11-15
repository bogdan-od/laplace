import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { notLoggedIn } from '../common/api-exception';
import { AuthedRequest, AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';

/** Marks a route that works without a session. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/** The logged-in user; the guard has already rejected requests without one. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw notLoggedIn();
    return user;
  },
);
