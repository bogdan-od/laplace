import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { csvCell, gradesCsv } from './grades-csv';

describe('csvCell', () => {
  test('plain text and numbers stay as they are', () => {
    assert.equal(csvCell('Олена'), 'Олена');
    assert.equal(csvCell(10), '10');
    assert.equal(csvCell(0), '0');
  });
  test('null is an empty cell', () => assert.equal(csvCell(null), ''));
  test('a separator, a quote or a line break gets the cell quoted', () => {
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('a\nb'), '"a\nb"');
    assert.equal(csvCell('a\rb'), '"a\rb"');
  });
  test('a comma needs no quotes: the separator is a semicolon', () =>
    assert.equal(csvCell('Іваненко, Іван'), 'Іваненко, Іван'));
  test('a text that a spreadsheet would run as a formula is made plain', () => {
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('-1+1'), "'-1+1");
  });
});

describe('gradesCsv', () => {
  test('BOM, header, rows, empty cells, CRLF', () => {
    const text = gradesCsv(
      ['A', 'B'],
      [
        { number: 1, name: 'Ірина', grades: [9, null] },
        { number: 2, name: 'Петро', grades: [null, 0] },
      ],
    );
    assert.equal(text, '\uFEFF№;ПІБ;A;B\r\n1;Ірина;9;\r\n2;Петро;;0\r\n');
  });
});
