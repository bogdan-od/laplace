import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import { ApiException } from '../src/common/api-exception';
import { LARGE_BODY_ROUTES } from '../src/common/large-bodies';
import { JournalStore } from '../src/journals/journal-store';
import { journalText } from './fixtures';
import { createTestApp, TestApp } from './helpers';

let t: TestApp;
let store: JournalStore;
before(async () => {
  t = await createTestApp();
  store = t.app.get(JournalStore);
});
after(async () => {
  await t.close();
});

const status = (error: unknown): number | undefined =>
  error instanceof ApiException ? error.getStatus() : undefined;

describe('JournalStore', () => {
  test('put returns the sha256 of the bytes and size/open read them back', async () => {
    const text = journalText({ events: 3 });
    const sha = await store.put(text);
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.equal(store.size(sha), Buffer.byteLength(text));
    const parts: Buffer[] = [];
    for await (const part of store.open(sha)) parts.push(part as Buffer);
    assert.equal(Buffer.concat(parts).toString(), text);
  });

  test('concurrent puts of the same journal leave one file and no temp files', async () => {
    const text = journalText({ events: 11 });
    const shas = await Promise.all([
      store.put(text),
      store.put(Buffer.from(text)),
      store.put(text),
    ]);
    assert.equal(new Set(shas).size, 1);
    const names = readdirSync(t.journalDir);
    assert.equal(names.filter((name) => name === `${shas[0]}.json`).length, 1);
    assert.equal(names.filter((name) => name.startsWith('.tmp-')).length, 0);
  });

  test('a refusing accept callback writes nothing', async () => {
    const before = readdirSync(t.journalDir).length;
    await assert.rejects(
      store.put(journalText({ events: 13 }), () => {
        throw new ApiException(400, 'no');
      }),
    );
    assert.equal(readdirSync(t.journalDir).length, before);
  });

  test('open and size refuse unknown hashes and path tricks with 404', () => {
    for (const sha of ['../../etc/passwd', 'abc', 'a'.repeat(64), '']) {
      assert.throws(
        () => store.open(sha),
        (e) => status(e) === 404,
      );
      assert.throws(
        () => store.size(sha),
        (e) => status(e) === 404,
      );
    }
  });

  test('a journal above MAX_JOURNAL_BYTES is 413 journal_too_large', () => {
    assert.throws(
      () => store.parse(Buffer.alloc(MAX_JOURNAL_BYTES + 1)),
      (e) =>
        status(e) === 413 && (e as ApiException).code === 'journal_too_large',
    );
  });
});

describe('LARGE_BODY_ROUTES', () => {
  test('match the journal and chunk routes only', () => {
    const matches = (method: string, path: string) =>
      LARGE_BODY_ROUTES.some((r) => r.method === method && r.path.test(path));
    assert.ok(matches('PUT', '/api/library/12/journals/m1'));
    assert.ok(matches('PUT', '/api/branches/3/events'));
    assert.ok(!matches('GET', '/api/library/12/journals/m1'));
    assert.ok(!matches('POST', '/api/library'));
    assert.ok(!matches('PUT', '/api/library/12/journals/m1/extra'));
    assert.ok(!matches('PUT', '/api/library/x/journals/m1'));
  });
});
