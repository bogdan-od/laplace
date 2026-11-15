const ZONE = 'Europe/Kyiv';
const MINUTE_MS = 60_000;

/** Daytime of the demo: every row of the database falls between these Kyiv times. */
export const DAY_START_MINUTES = 8 * 60 + 30;
export const DAY_END_MINUTES = 21 * 60 + 30;
export const END_OF_DAY_MINUTES = 23 * 60 + 59;

const FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wall(ms: number): Wall {
  const parts: Record<string, number> = {};
  for (const part of FORMAT.formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as unknown as Wall;
}

/** How far the Kyiv wall clock is ahead of UTC at the instant `ms`. */
function offsetMs(ms: number): number {
  const w = wall(ms);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Minutes since the Kyiv midnight. */
export function kyivMinutes(ms: number): number {
  const w = wall(ms);
  return w.hour * 60 + w.minute + w.second / 60;
}

/** The instant at `minutes` since midnight on the Kyiv calendar day `dayOffset` days from the day of `base`. */
export function kyivInstant(
  base: number,
  dayOffset: number,
  minutes: number,
): number {
  const w = wall(base);
  const asUtc =
    Date.UTC(w.year, w.month - 1, w.day + dayOffset) + minutes * MINUTE_MS;
  return asUtc - offsetMs(asUtc - offsetMs(asUtc));
}

export function isDaytime(ms: number): boolean {
  const minutes = kyivMinutes(ms);
  return minutes >= DAY_START_MINUTES && minutes <= DAY_END_MINUTES;
}

export function kyivText(ms: number): string {
  const w = wall(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
}
