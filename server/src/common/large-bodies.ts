import { MAX_CHUNK_BYTES, MAX_JOURNAL_BYTES } from '@shared/limits';
import { json, raw, type Request, type RequestHandler } from 'express';

/**
 * A route whose body may exceed the global JSON limit. `raw` hands the controller the exact bytes
 * (so the journal hash is taken over what was sent and a 64 MiB body is not parsed twice); `json`
 * gives a parsed object for a DTO.
 */
export interface LargeBodyRoute {
  method: string;
  path: RegExp;
  limit: number;
  kind: 'json' | 'raw';
}

export const LARGE_BODY_ROUTES: readonly LargeBodyRoute[] = [
  {
    method: 'PUT',
    path: /^\/api\/library\/\d+\/journals\/[^/]+$/,
    limit: MAX_JOURNAL_BYTES,
    kind: 'raw',
  },
  {
    method: 'PUT',
    path: /^\/api\/branches\/\d+\/events$/,
    limit: MAX_CHUNK_BYTES,
    kind: 'json',
  },
];

export const isLargeBodyRoute = (method: string, path: string): boolean =>
  LARGE_BODY_ROUTES.some(
    (route) => route.method === method && route.path.test(path),
  );

/**
 * Parses the bodies of LARGE_BODY_ROUTES with their own limit. Registered before the global
 * parser: body-parser skips a request whose body is already read, so the 1 MiB limit never sees
 * these routes. Only a logged-in caller gets the big limit; otherwise the request falls through to
 * the global parser (413 beyond 1 MiB, then 401 from the guard), so an anonymous client cannot make
 * the server buffer 64 MiB.
 */
export function largeBodies(
  isLoggedIn: (req: Request) => boolean,
  routes: readonly LargeBodyRoute[] = LARGE_BODY_ROUTES,
): RequestHandler {
  const parsers = routes.map((route) => ({
    route,
    parse:
      route.kind === 'raw'
        ? raw({ type: 'application/json', limit: route.limit })
        : json({ limit: route.limit }),
  }));
  return (req, res, next) => {
    const match = parsers.find(
      ({ route }) => route.method === req.method && route.path.test(req.path),
    );
    if (!match || !isLoggedIn(req)) {
      next();
      return;
    }
    match.parse(req, res, next);
  };
}
