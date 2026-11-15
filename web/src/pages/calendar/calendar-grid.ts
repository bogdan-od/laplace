import type { CalendarEntry } from "@shared/api";

/** `month` is 0-11, as in `Date`. */
export interface Month {
  year: number;
  month: number;
}

export interface Day {
  /** Local date as "2037-11-05". */
  key: string;
  date: Date;
  inMonth: boolean;
}

export const VISIBLE_ENTRIES = 3;

const DAYS_IN_WEEK = 7;
const MONTH_PARAM = /^(\d{4})-(0[1-9]|1[0-2])$/;
// 2024-01-01 is a Monday: the week header is taken from the next seven days.
const A_MONDAY = new Date(2024, 0, 1);
const MONTH_NAME = new Intl.DateTimeFormat("uk-UA", { month: "long" });
const WEEKDAY_NAME = new Intl.DateTimeFormat("uk-UA", { weekday: "short" });

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function dayKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monthKey({ year, month }: Month): string {
  return `${pad(year, 4)}-${pad(month + 1)}`;
}

export function monthOf(ms: number): Month {
  const date = new Date(ms);
  return { year: date.getFullYear(), month: date.getMonth() };
}

/** `?m=2037-11`; anything else (missing, wrong) means the month of `now`. */
export function parseMonth(param: string | null, now: number): Month {
  const match = param === null ? null : MONTH_PARAM.exec(param);
  if (!match) return monthOf(now);
  return { year: Number(match[1]), month: Number(match[2]) - 1 };
}

export function shiftMonth({ year, month }: Month, delta: number): Month {
  const shifted = new Date(year, month + delta, 1);
  return { year: shifted.getFullYear(), month: shifted.getMonth() };
}

/** "Листопад 2037". */
export function monthTitle({ year, month }: Month): string {
  return `${capitalize(MONTH_NAME.format(new Date(year, month, 1)))} ${year}`;
}

/** "Пн", "Вт", ... starting with Monday. */
export function weekdayNames(): string[] {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) =>
    capitalize(WEEKDAY_NAME.format(new Date(A_MONDAY.getFullYear(), A_MONDAY.getMonth(), A_MONDAY.getDate() + i))),
  );
}

/** The weeks that cover the month, Monday first; the days of the neighbour months fill the first and last week. */
export function monthWeeks({ year, month }: Month): Day[][] {
  const lead = (new Date(year, month, 1).getDay() + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
  const inMonthDays = new Date(year, month + 1, 0).getDate();
  const weekCount = Math.ceil((lead + inMonthDays) / DAYS_IN_WEEK);
  return Array.from({ length: weekCount }, (_, week) =>
    Array.from({ length: DAYS_IN_WEEK }, (_, i) => {
      const date = new Date(year, month, 1 - lead + week * DAYS_IN_WEEK + i);
      return { key: dayKey(date), date, inMonth: date.getMonth() === month };
    }),
  );
}

/** Local midnight of the first visible day and of the day after the last one, in ms: `from` is inclusive, `to` is not. */
export function visibleRange(weeks: readonly Day[][]): { from: number; to: number } {
  const first = weeks[0]?.[0]?.date;
  const last = weeks.at(-1)?.at(-1)?.date;
  if (!first || !last) throw new Error("a month has at least one week");
  return { from: first.getTime(), to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime() };
}

/** Entries by the local day of their due time, each day in time order. */
export function entriesByDay(entries: readonly CalendarEntry[]): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.due_at - b.due_at || a.assignment_id - b.assignment_id)) {
    const key = dayKey(new Date(entry.due_at));
    days.set(key, [...(days.get(key) ?? []), entry]);
  }
  return days;
}

/** The entries a day cell shows: all of them when expanded, otherwise the first three and the count of the rest. */
export function visibleEntries(entries: readonly CalendarEntry[], expanded: boolean): { shown: readonly CalendarEntry[]; hidden: number } {
  if (expanded || entries.length <= VISIBLE_ENTRIES) return { shown: entries, hidden: 0 };
  return { shown: entries.slice(0, VISIBLE_ENTRIES), hidden: entries.length - VISIBLE_ENTRIES };
}

/** "1 чекає перевірки", "2 чекають перевірки", "5 чекають перевірки". */
export function waitingText(n: number): string {
  const one = n % 10 === 1 && n % 100 !== 11;
  return `${n} ${one ? "чекає" : "чекають"} перевірки`;
}
