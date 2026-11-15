import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDaytime, kyivInstant, kyivMinutes, kyivText } from './kyiv-time';

test('kyivInstant gives the Kyiv wall time in winter and in summer', () => {
  const winter = Date.UTC(2037, 10, 13, 5, 0);
  assert.equal(
    kyivText(kyivInstant(winter, 0, 23 * 60 + 59)),
    '2037-11-13 23:59',
  );
  assert.equal(kyivInstant(winter, 0, 0), Date.UTC(2037, 10, 12, 22, 0));
  const summer = Date.UTC(2037, 6, 13, 5, 0);
  assert.equal(kyivInstant(summer, 0, 0), Date.UTC(2037, 6, 12, 21, 0));
});

test('kyivInstant counts calendar days across the end of daylight saving time', () => {
  const before = Date.UTC(2037, 9, 24, 12, 0);
  const after = kyivInstant(before, 2, 9 * 60);
  assert.equal(kyivText(after), '2037-10-26 09:00');
  assert.equal(kyivMinutes(after), 9 * 60);
});

test('isDaytime is 08:30..21:30 Kyiv time', () => {
  const base = Date.UTC(2037, 10, 13, 5, 0);
  assert.equal(isDaytime(kyivInstant(base, 0, 8 * 60 + 29)), false);
  assert.equal(isDaytime(kyivInstant(base, 0, 8 * 60 + 30)), true);
  assert.equal(isDaytime(kyivInstant(base, 0, 21 * 60 + 30)), true);
  assert.equal(isDaytime(kyivInstant(base, 0, 21 * 60 + 31)), false);
  assert.equal(isDaytime(kyivInstant(base, 0, 1 * 60 + 40)), false);
});
