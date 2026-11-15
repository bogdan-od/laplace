import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { median } from './median';

describe('median', () => {
  test('no values', () => assert.equal(median([]), null));
  test('one value', () => assert.equal(median([7]), 7));
  test('odd count: the middle one, whatever the order', () =>
    assert.equal(median([30, 10, 20]), 20));
  test('even count: the mean of the middle two', () =>
    assert.equal(median([10, 40, 20, 30]), 25));
  test('does not reorder the input', () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
  });
});
