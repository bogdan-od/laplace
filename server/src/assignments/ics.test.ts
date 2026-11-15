import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCalendar, icsEscape, icsFold, icsTime } from './ics';

test('icsTime is UTC without separators or milliseconds', () => {
  assert.equal(
    icsTime(Date.UTC(2037, 10, 12, 8, 30, 5, 123)),
    '20371112T083005Z',
  );
});

test('icsEscape escapes backslash, semicolon, comma and newlines', () => {
  assert.equal(icsEscape('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
});

test('icsFold keeps every line within 75 octets and does not split a character', () => {
  const folded = icsFold(`SUMMARY:${'Ї'.repeat(100)}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(lines.slice(1).every((line) => line.startsWith(' ')));
  assert.equal(
    lines.map((line, i) => (i === 0 ? line : line.slice(1))).join(''),
    `SUMMARY:${'Ї'.repeat(100)}`,
  );
});

test('buildCalendar writes one VEVENT per event with CRLF endings', () => {
  const text = buildCalendar(
    [
      { uid: 'assignment-1@laplace', summary: '10-А: Мережа', at: 0 },
      { uid: 'assignment-2@laplace', summary: 'Х', at: 86_400_000 },
    ],
    1_700_000_000_000,
  );
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.ok(text.includes('DTSTART:19700101T000000Z'));
  assert.ok(!/[^\r]\n/.test(text));
});
