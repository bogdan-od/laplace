import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { journalCore, topologyCore } from './core';
import { configureApp } from './setup';

test('journalCore() gives a working check_journal_strict', () => {
  const { check_journal_strict, FORMAT } = journalCore();
  assert.match(FORMAT, /^v86-replay\//);
  assert.throws(() => check_journal_strict({ header: {}, events: [] }));
});

test('topologyCore() gives a working validate_topology', () => {
  const { validate_topology } = topologyCore();
  assert.ok(validate_topology(42).length > 0);
});

test('the server process keeps the real clock and Math.random', async () => {
  process.env.LAPLACE_DB = ':memory:';
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1000);
  assert.ok(
    Math.abs(Date.now() - performance.timeOrigin - performance.now()) < 1000,
  );
  assert.match(
    Function.prototype.toString.call(Math.random),
    /\[native code\]/,
  );
  assert.match(Function.prototype.toString.call(Date.now), /\[native code\]/);
  await app.close();
});
