import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_STUDENTS_PER_CLASS } from '@shared/limits';

// Proves that `nest build` rewrote the @shared alias for the test build: a value import of the
// constant would throw "Cannot find module '@shared/limits'" otherwise.
test('@shared/limits resolves at run time in tests', () => {
  assert.equal(MAX_STUDENTS_PER_CLASS, 254);
});
