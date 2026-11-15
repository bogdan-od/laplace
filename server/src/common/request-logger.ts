import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('Http');
const NS_PER_MS = 1_000_000n;

/**
 * Path segments that are secrets: a publication token opens a journal and an invite code joins a
 * class, so neither may reach the log.
 */
const SECRET_SEGMENTS = /^(\/api\/(?:embed|invites)\/)[^/]+/;

export const maskSecrets = (path: string): string =>
  path.replace(SECRET_SEGMENTS, '$1***');

/** Logs method, path (without the query string), status and duration. Never bodies or headers. */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - started) / NS_PER_MS);
    const path = maskSecrets(req.originalUrl.split('?')[0] ?? '');
    logger.log(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
  });
  next();
}
