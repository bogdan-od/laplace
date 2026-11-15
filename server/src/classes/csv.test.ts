import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStudentsCsv } from './csv';

test('parses names and optional logins with ; or , and skips blank lines and the header', () => {
  const result = parseStudentsCsv(
    '﻿ПІБ;логін\r\nІванов Іван;ivan\n\n  Петров   Петро  \nСидоренко Олег,sydor\n',
  );
  assert.deepEqual(result.rows, [
    { line: 2, name: 'Іванов Іван', login: 'ivan' },
    { line: 4, name: 'Петров Петро', login: null },
    { line: 5, name: 'Сидоренко Олег', login: 'sydor' },
  ]);
  assert.deepEqual(result.errors, []);
});

test('the header is recognised in English and only as the first line', () => {
  assert.equal(parseStudentsCsv('Name\nA B').rows.length, 1);
  assert.equal(parseStudentsCsv('A B\nПІБ').rows.length, 2);
});

test('empty cells and trailing separators are tolerated, extra columns are an error', () => {
  const result = parseStudentsCsv('Іванов Іван;;\n;ivan\nА;Б;В');
  assert.deepEqual(result.rows, [
    { line: 1, name: 'Іванов Іван', login: null },
  ]);
  assert.deepEqual(
    result.errors.map((e) => e.line),
    [2, 3],
  );
});

test('strips quotes around cells', () => {
  assert.deepEqual(parseStudentsCsv('"Іванов Іван";"ivan"').rows, [
    { line: 1, name: 'Іванов Іван', login: 'ivan' },
  ]);
});
