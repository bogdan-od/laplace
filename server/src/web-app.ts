import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { repoRoot } from './repo-root';
import { FILES_PREFIX } from './static-files';

const INDEX_FILE = 'index.html';
const ASSETS_DIR = 'assets';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Paths that belong to the server (or to a hashed asset): they must never answer with the page.
const SERVER_PREFIXES = ['/api', '/ws', FILES_PREFIX, `/${ASSETS_DIR}/`];

/** The built front end, `web/dist` in the repository. */
export const defaultWebDist = (): string => join(repoRoot(), 'web', 'dist');

function belongsToServer(path: string): boolean {
  return SERVER_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}

/**
 * Serves the built front end: files of `dist` as they are (hashed `assets/` for a year, the rest
 * revalidated) and `index.html` for every other GET, so that a page address opens after a reload.
 * Without `dist` the server answers only the API.
 */
export function useWebApp(app: NestExpressApplication, dist: string): void {
  if (!existsSync(join(dist, INDEX_FILE))) {
    new Logger('WebApp').warn(
      'web/dist not found, run `npm run build` in web/',
    );
    return;
  }
  const assets = join(dist, ASSETS_DIR) + sep;
  app.useStaticAssets(dist, {
    index: false,
    dotfiles: 'ignore',
    etag: true,
    setHeaders: (res: Response, file: string) => {
      res.setHeader(
        'Cache-Control',
        file.startsWith(assets) ? IMMUTABLE : 'no-cache',
      );
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      belongsToServer(req.path)
    ) {
      next();
      return;
    }
    res.sendFile(INDEX_FILE, {
      root: dist,
      headers: { 'Cache-Control': 'no-cache' },
    });
  });
}
