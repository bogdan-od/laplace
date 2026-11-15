export const CSV_BOM = '\uFEFF';
const SEPARATOR = ';';
const LINE_END = '\r\n';
const QUOTED = /[;"\r\n]/;
/** A spreadsheet runs a cell that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t]/;

/** One cell: quoted when it holds `;`, a quote or a line break; a formula-like text is made plain. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return QUOTED.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export interface GradeRow {
  number: number;
  name: string;
  /** One grade per assignment column, null when there is none. */
  grades: (number | null)[];
}

/**
 * The grade table for Excel with a Ukrainian locale: UTF-8 with a BOM and `;` as the separator.
 * Columns: number, name, then one per assignment title.
 */
export function gradesCsv(
  titles: readonly string[],
  rows: readonly GradeRow[],
): string {
  const lines = [
    ['№', 'ПІБ', ...titles],
    ...rows.map((row) => [row.number, row.name, ...row.grades]),
  ];
  return (
    CSV_BOM +
    lines.map((cells) => cells.map(csvCell).join(SEPARATOR)).join(LINE_END) +
    LINE_END
  );
}
