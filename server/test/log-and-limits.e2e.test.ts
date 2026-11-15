import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import { Logger } from '@nestjs/common';
import type { ApiError } from '@shared/api';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import type { Request, Response } from 'express';
import { maskSecrets, requestLogger } from '../src/common/request-logger';
import { toApiError } from '../src/common/api-exception.filter';
import { createItem, journalText, putJournal } from './fixtures';
import { createClass, createTestApp, teacherClient, TestApp } from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});
afterEach(() => mock.restoreAll());

const error = (res: { body: unknown }): ApiError => res.body as ApiError;

describe('request log', () => {
  test('secret path segments are replaced by ***', () => {
    assert.equal(maskSecrets('/api/embed/abcDEF123_-xyz'), '/api/embed/***');
    assert.equal(maskSecrets('/api/invites/ABCD2345'), '/api/invites/***');
    assert.equal(
      maskSecrets('/api/invites/ABCD2345/accept'),
      '/api/invites/***/accept',
    );
    assert.equal(maskSecrets('/api/classes/5'), '/api/classes/5');
    assert.equal(maskSecrets('/api/library/3/embed'), '/api/library/3/embed');
  });

  test('the logger writes the masked path', () => {
    const lines: string[] = [];
    mock.method(Logger.prototype, 'log', (line: unknown) => {
      lines.push(String(line));
    });
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    requestLogger(
      { method: 'GET', originalUrl: '/api/embed/SECRETTOKEN?x=1' } as Request,
      res as unknown as Response,
      () => undefined,
    );
    res.emit('finish');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^GET \/api\/embed\/\*\*\* 200 \d+ms$/);
  });

  test('no line of a real publication or invitation contains the token or the code', async () => {
    const lines: string[] = [];
    mock.method(Logger.prototype, 'log', (line: unknown) => {
      lines.push(String(line));
    });
    const teacher = await teacherClient(t);
    const item = await createItem(teacher, { kind: 'lesson' });
    await putJournal(teacher, item.id, journalText({ lesson: true }));
    const published = await teacher
      .post(`/api/library/${item.id}/embed`)
      .expect(201);
    const token = (published.body as { token: string }).token;
    await t.client().get(`/api/embed/${token}`).expect(200);
    const { code } = await createClass(teacher);
    await t.client().get(`/api/invites/${code}`).expect(200);
    assert.ok(lines.some((line) => line.includes('/api/embed/***')));
    assert.ok(lines.some((line) => line.includes('/api/invites/***')));
    for (const line of lines) {
      assert.ok(!line.includes(token), line);
      assert.ok(!line.includes(code), line);
    }
  });
});

describe('413 on journal routes', () => {
  test('a journal body past MAX_JOURNAL_BYTES answers journal_too_large', async () => {
    const teacher = await teacherClient(t);
    const item = await createItem(teacher);
    const res = await teacher
      .put(`/api/library/${item.id}/journals/m1?role=start`)
      .set('Content-Type', 'application/json')
      .send(' '.repeat(MAX_JOURNAL_BYTES + 1))
      .expect(413);
    assert.equal(error(res).statusCode, 413);
    assert.equal(error(res).code, 'journal_too_large');
  });

  test('the same error on an ordinary route has no code', () => {
    const tooLarge = Object.assign(new Error('x'), {
      type: 'entity.too.large',
    });
    assert.deepEqual(
      toApiError(tooLarge, { method: 'POST', path: '/api/library' }),
      {
        statusCode: 413,
        message: 'Тіло запиту завелике',
      },
    );
    assert.equal(
      toApiError(tooLarge, { method: 'PUT', path: '/api/branches/4/events' })
        .code,
      'journal_too_large',
    );
  });
});
