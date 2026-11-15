// Ukrainian dates and plurals. No past-tense verbs about people (the user's gender is unknown).

const MONTH_DAY = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", year: "numeric" });
const CLOCK = new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", hour12: false });

/** "14 листопада", with the year when it is not the current one. */
export function formatDate(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(date);
}

export function formatClock(ms: number): string {
  return CLOCK.format(new Date(ms));
}

/** Today: "14:05"; otherwise "10 листопада, 14:05". */
export function formatWhen(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? formatClock(ms) : `${formatDate(ms, now)}, ${formatClock(ms)}`;
}

/** "1 здача", "2 здачі", "5 здач". */
export function plural(n: number, one: string, few: string, many: string): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return `${n} ${one}`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** A due date with its time: "14 листопада, 23:59". */
export function formatDue(ms: number, now: number = Date.now()): string {
  return `${formatDate(ms, now)}, ${formatClock(ms)}`;
}
