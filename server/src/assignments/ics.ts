const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;
const PRODID = '-//Laplace//UK';

export interface IcsEvent {
  uid: string;
  summary: string;
  /** ms since the epoch; DTSTART and DTEND are both this moment. */
  at: number;
}

/** RFC 5545 section 3.3.5: UTC date-time, for example 20371112T083000Z. */
export function icsTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** RFC 5545 section 3.3.11: backslash, semicolon, comma and line breaks are escaped in TEXT. */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line so that no line exceeds 75 octets (RFC 5545 section 3.1). A continuation
 * line starts with one space, which counts toward its 75 octets. UTF-8 sequences are not split.
 */
export function icsFold(line: string): string {
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (octets + size > MAX_LINE_OCTETS) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(CRLF);
}

export function buildCalendar(
  events: readonly IcsEvent[],
  now: number,
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(event.at)}`,
      `DTEND:${icsTime(event.at)}`,
      `SUMMARY:${icsEscape(event.summary)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join(CRLF) + CRLF;
}
