import type { Analytics } from "@shared/api";

export interface GradeColumn {
  grade: number;
  count: number;
  /** Height as a share of the tallest column, 0..100. */
  percent: number;
}

/** One column per whole grade 0..maxGrade (grades the server did not return have count 0). */
export function gradeColumns(grades: Analytics["grades"], maxGrade: number): GradeColumn[] {
  const counts = new Map<number, number>();
  for (const { grade, count } of grades) counts.set(grade, (counts.get(grade) ?? 0) + count);
  // A grade above the maximum (the maximum was lowered later) still gets its column.
  const top = Math.max(maxGrade, ...counts.keys());
  const tallest = Math.max(0, ...counts.values());
  return Array.from({ length: top + 1 }, (_, grade) => {
    const count = counts.get(grade) ?? 0;
    return { grade, count, percent: tallest === 0 ? 0 : (count / tallest) * 100 };
  });
}

const MANY_COLUMNS = 21;
const LABEL_STEP_WHEN_MANY = 10;

/** Which columns carry a number under them: all of them when few, every tenth when many. */
export function showsLabel(grade: number, columns: number): boolean {
  return columns < MANY_COLUMNS || grade % LABEL_STEP_WHEN_MANY === 0;
}

const SECONDS_PER_MINUTE = 60;
const WHOLE_MINUTE_THRESHOLD = 1;

function decimalText(value: number): string {
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

/** "12,5 хв"; under a minute in seconds ("12 с"); null is "-". */
export function minutesText(minutes: number | null): string {
  if (minutes === null) return "-";
  const seconds = Math.round(minutes * SECONDS_PER_MINUTE);
  if (minutes < WHOLE_MINUTE_THRESHOLD && seconds < SECONDS_PER_MINUTE) return `${seconds} с`;
  return `${decimalText(minutes)} хв`;
}

export function numberText(value: number | null): string {
  return value === null ? "-" : String(value);
}

/** "від 4 до 31 хв" for the spread, "-" when nobody has submitted; a start under a minute carries its own unit. */
export function spreadText(spread: Analytics["minutes_to_submit"]): string {
  if (spread.min === null || spread.max === null) return "-";
  const from = spread.min < WHOLE_MINUTE_THRESHOLD ? minutesText(spread.min) : decimalText(spread.min);
  return `від ${from} до ${minutesText(spread.max)}`;
}

type StudentRow = Analytics["per_student"][number];

/** A student with nothing at all in the row has not opened the assignment (the server sends a row for every member). */
export function hasNotStarted(row: StudentRow): boolean {
  return (
    row.minutes_to_submit === null &&
    row.commands === null &&
    row.grade === null &&
    row.rollbacks === 0 &&
    row.help_requests === 0 &&
    row.hints_used === 0
  );
}

/**
 * Rows of those who worked, and the names of those who have not started (shown as one line under the table).
 * `idleIds` are the students the room strip counts as not started; without it the row itself decides.
 */
export function splitStudents(
  rows: readonly StudentRow[],
  idleIds?: ReadonlySet<number>,
): { worked: StudentRow[]; idle: StudentRow[] } {
  const isIdle = (row: StudentRow) => (idleIds ? idleIds.has(row.user_id) : hasNotStarted(row));
  return { worked: rows.filter((row) => !isIdle(row)), idle: rows.filter(isIdle) };
}
