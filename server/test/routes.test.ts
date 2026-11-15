import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { API_ROUTES } from '@shared/api';
import type { Application } from 'express';
import { createTestApp, TestApp } from './helpers';

/** Routes outside API_ROUTES that the server serves on purpose. */
const EXTRA_ROUTES = ['GET /api/docs'];

/**
 * Paths with a rule of their own: static files, the WebSocket upgrade and the files of Swagger UI
 * under /api/docs/ (its page, scripts and the JSON and YAML documents).
 */
const SEPARATE_PREFIXES = ['/files/', '/ws', '/api/docs/'];

/** The routes in `expected` that `actual` lacks, and the other way round. */
function routeDiff(
  actual: readonly string[],
  expected: readonly string[],
): { missing: string[]; unexpected: string[] } {
  return {
    missing: expected.filter((route) => !actual.includes(route)),
    unexpected: actual.filter((route) => !expected.includes(route)),
  };
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every "METHOD /path" Express has a route for, in the form API_ROUTES uses. */
function registered(app: Application): string[] {
  const router = (app as unknown as { router: { stack: Layer[] } }).router;
  const found = new Set<string>();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) found.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return [...found].sort();
}

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

describe('route set', () => {
  test('the routes of the app are API_ROUTES plus the documented extras', () => {
    const actual = registered(
      t.app.getHttpAdapter().getInstance() as Application,
    ).filter((route) => {
      const path = route.slice(route.indexOf(' ') + 1);
      return !SEPARATE_PREFIXES.some((prefix) => path.startsWith(prefix));
    });
    const expected = [...API_ROUTES, ...EXTRA_ROUTES].sort();
    assert.deepEqual(
      routeDiff(actual, expected),
      { missing: [], unexpected: [] },
      'routes registered in the app differ from API_ROUTES',
    );
  });

  test('routeDiff lists both a missing and an extra route', () => {
    assert.deepEqual(
      routeDiff(['GET /a', 'GET /extra'], ['GET /a', 'POST /b']),
      { missing: ['POST /b'], unexpected: ['GET /extra'] },
    );
  });
});
