import type { Id, Role } from '@shared/api';
import { SESSION_TTL_MS } from '@shared/limits';
import type { Request } from 'express';

export interface AuthUser {
  id: Id;
  login: string;
  name: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const SESSION_COOKIE = 'sid';

/** No `secure`: the demo runs on http://127.0.0.1. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS,
} as const;
