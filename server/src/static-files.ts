import { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import { join } from 'node:path';
import { repoRoot } from './repo-root';

export const FILES_PREFIX = '/files/';

// Only these directories are public. app/data holds old journals and must never be served.
const PUBLIC_DIRS = ['images', 'vendor'];

export function useImageFiles(app: NestExpressApplication): void {
  for (const dir of PUBLIC_DIRS) {
    app.useStaticAssets(join(repoRoot(), dir), {
      prefix: `${FILES_PREFIX}${dir}/`,
      index: false,
      dotfiles: 'ignore',
      etag: true,
      // The browser revalidates and gets 304 instead of downloading 170 MB images again.
      setHeaders: (res: Response) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    });
  }
}
