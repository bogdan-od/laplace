import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, TestApp } from '../../test/helpers';

let t: TestApp;
let app: NestExpressApplication;

before(async () => {
  t = await createTestApp();
  app = t.app;
});

after(async () => {
  await t.close();
});

test('GET /api/images returns the files root without logging in', async () => {
  const res = await request(app.getHttpServer()).get('/api/images').expect(200);
  assert.deepEqual(res.body, { root: '/files/' });
});

test('serves a public file with ETag and answers 304 to a revalidation', async () => {
  const url = '/files/images/seabios.bin';
  const first = await request(app.getHttpServer()).get(url).expect(200);
  assert.equal(first.headers['cache-control'], 'no-cache');
  const etag = first.headers.etag as string;
  assert.ok(etag);
  await request(app.getHttpServer())
    .get(url)
    .set('If-None-Match', etag)
    .expect(304);
});

test('does not serve app/data or other repository files', async () => {
  for (const url of [
    '/files/app/data/journals/x.json',
    '/files/app/profiles.mjs',
    '/files/images/../app/profiles.mjs',
  ]) {
    await request(app.getHttpServer()).get(url).expect(404);
  }
});
