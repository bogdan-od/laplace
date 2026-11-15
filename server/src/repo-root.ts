import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MARKER = join('app', 'profiles.mjs');

let cached: string | undefined;

/** Repository root: `LAPLACE_ROOT`, or the nearest ancestor of this file that holds `app/profiles.mjs`. */
export function repoRoot(): string {
  if (cached) return cached;
  const fromEnv = process.env.LAPLACE_ROOT;
  if (fromEnv) {
    cached = resolve(fromEnv);
    return cached;
  }
  let dir = __dirname;
  for (;;) {
    if (existsSync(join(dir, MARKER))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `repository root not found above ${__dirname}: set LAPLACE_ROOT`,
      );
    }
    dir = parent;
  }
}
