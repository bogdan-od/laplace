import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clipChunk } from './growth';

const chunk = { first_event: 10, event_count: 10, bytes: 1000, received_at: 5 };

describe('clipChunk', () => {
  test('a chunk inside the range is returned as it is', () =>
    assert.equal(clipChunk(chunk, 0, 20), chunk));
  test('a chunk outside the range is dropped', () => {
    assert.equal(clipChunk(chunk, 0, 10), null);
    assert.equal(clipChunk(chunk, 20, 30), null);
  });
  test('the end is cut, bytes follow in proportion', () =>
    assert.deepEqual(clipChunk(chunk, 0, 15), {
      first_event: 10,
      event_count: 5,
      bytes: 500,
      received_at: 5,
    }));
  test('the start is cut too', () =>
    assert.deepEqual(clipChunk(chunk, 12, 14), {
      first_event: 12,
      event_count: 2,
      bytes: 200,
      received_at: 5,
    }));
});
