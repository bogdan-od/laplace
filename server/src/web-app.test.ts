import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createTestApp, TestApp } from '../test/helpers';

const PAGE = '<!doctype html><title>laplace</title>';
let dist: string;
let t: TestApp;

before(async () => {
  dist = mkdtempSync(join(tmpdir(), 'laplace-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), PAGE);
  writeFileSync(
    join(dist, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'export {};');
  t = await createTestApp({ webDist: dist });
});

after(async () => {
  await t.close();
  rmSync(dist, { recursive: true, force: true });
});

test('a page address answers with index.html, revalidated', async () => {
  for (const url of ['/', '/classes/1', '/review?x=1']) {
    const res = await t.client().get(url).expect(200);
    assert.equal(res.text, PAGE, url);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-cache');
  }
});

test('an unknown /api path is a JSON 404, not the page', async () => {
  const res = await t.client().get('/api/nope').expect(404);
  assert.match(res.headers['content-type'] as string, /json/);
  assert.equal((res.body as { statusCode: number }).statusCode, 404);
});

test('hashed assets are immutable and a missing asset is a 404', async () => {
  const res = await t.client().get('/assets/index-abc123.js').expect(200);
  assert.match(res.headers['cache-control'] as string, /immutable/);
  assert.match(res.headers['cache-control'] as string, /max-age=31536000/);
  const missing = await t.client().get('/assets/old-chunk.js').expect(404);
  assert.notEqual(missing.text, PAGE);
});

test('other files of dist are served as they are', async () => {
  const res = await t.client().get('/favicon.svg').expect(200);
  assert.match(res.headers['content-type'] as string, /svg/);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('only GET gets the page; /files stays with the file routes', async () => {
  await t.client().post('/classes/1').send({}).expect(404);
  const res = await t.client().get('/files/nope.bin').expect(404);
  assert.notEqual(res.text, PAGE);
});

test('without dist the server starts and answers the API only', async () => {
  const bare = await createTestApp({ webDist: join(dist, 'absent') });
  try {
    await bare.client().get('/api/images').expect(200);
    await bare.client().get('/classes/1').expect(404);
  } finally {
    await bare.close();
  }
});
