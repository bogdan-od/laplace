import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiException } from './api-exception';
import { toApiError } from './api-exception.filter';

test('an internal error becomes 500 "Помилка сервера" without its text', () => {
  const error = toApiError(new Error('secret journal bytes: 0xdeadbeef'));
  assert.deepEqual(error, { statusCode: 500, message: 'Помилка сервера' });
});

test('Nest exceptions get Ukrainian generic texts, not English ones', () => {
  assert.deepEqual(toApiError(new NotFoundException('Cannot GET /x')), {
    statusCode: 404,
    message: 'Не знайдено',
  });
  assert.equal(
    toApiError(new BadRequestException('Unexpected token')).message,
    'Некоректний запит',
  );
});

test('ApiException keeps its message, code and extra fields', () => {
  const error = toApiError(
    new ApiException(409, 'Розрив', 'chunk_gap', { event_count: 5 }),
  );
  assert.deepEqual(error, {
    statusCode: 409,
    message: 'Розрив',
    code: 'chunk_gap',
    event_count: 5,
  });
});
