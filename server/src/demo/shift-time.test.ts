import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORK_MINUTES, openingBefore } from './shift-time';

const MS_PER_MINUTE = 60_000;

test('openingBefore puts the opening that many minutes before the submission', () => {
  const submitted = Date.UTC(2037, 10, 12, 10, 0);
  assert.equal(openingBefore(submitted, 1), submitted - 4 * MS_PER_MINUTE);
  assert.equal(openingBefore(submitted, 0), submitted - 42_000);
});

test('openingBefore takes the durations in turn', () => {
  const submitted = 1_000_000_000;
  assert.equal(
    openingBefore(submitted, WORK_MINUTES.length),
    openingBefore(submitted, 0),
  );
});

test('the longest duration fits between the earliest slot (09:20) and 08:30', () => {
  assert.ok(Math.max(...WORK_MINUTES) < 50);
});
