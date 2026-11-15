import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePort } from './port';

test('the port defaults to 8086', () => {
  assert.equal(parsePort(undefined), 8086);
  assert.equal(parsePort(''), 8086);
});

test('a valid PORT is used', () => {
  assert.equal(parsePort('8091'), 8091);
  assert.equal(parsePort('65535'), 65_535);
});

test('a wrong PORT names the variable and the value', () => {
  for (const raw of ['abc', '0', '-1', '80.5', '65536', ' ']) {
    assert.throws(
      () => parsePort(raw),
      /PORT must be an integer from 1 to 65535/,
    );
  }
  assert.throws(() => parsePort('abc'), /got "abc"/);
});
