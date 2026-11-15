export interface CsvRow {
  /** 1-based line number in the uploaded text, counting blank lines. */
  line: number;
  name: string;
  login: string | null;
}

export interface CsvLineError {
  line: number;
  message: string;
}

export interface ParsedCsv {
  rows: CsvRow[];
  errors: CsvLineError[];
}

const HEADER_CELLS = new Set(['піб', 'name']);
const MAX_CELLS = 2;
const BOM = '﻿';

function splitCells(line: string): string[] {
  // ";" wins when present, so a comma inside a name does not split it.
  const separator = line.includes(';') ? ';' : ',';
  const cells = line.split(separator).map((cell) =>
    cell
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim(),
  );
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** Lines "name" or "name;login" (separator ; or ,). Blank lines and a header line are skipped. */
export function parseStudentsCsv(csv: string): ParsedCsv {
  const rows: CsvRow[] = [];
  const errors: CsvLineError[] = [];
  const lines = csv.replace(BOM, '').split(/\r\n|\r|\n/);
  let seenContent = false;
  lines.forEach((text, index) => {
    if (text.trim() === '') return;
    const line = index + 1;
    const cells = splitCells(text);
    const isHeader =
      !seenContent && HEADER_CELLS.has((cells[0] ?? '').toLowerCase());
    seenContent = true;
    if (isHeader) return;
    const name = (cells[0] ?? '').replace(/\s+/g, ' ');
    if (name === '' || cells.length > MAX_CELLS) {
      errors.push({
        line,
        message:
          name === '' ? 'Порожнє ім’я' : 'Очікується "ПІБ" або "ПІБ;логін"',
      });
      return;
    }
    rows.push({ line, name, login: cells[1] ? cells[1] : null });
  });
  return { rows, errors };
}
