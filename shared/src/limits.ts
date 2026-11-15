// Limits checked on both sides: the frontend to prevent the mistake, the backend to not trust the client.

export const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
export const MIN_PASSWORD_CHARS = 8;
export const MAX_NAME_CHARS = 100;
export const MAX_TITLE_CHARS = 200;
export const MAX_BRIEF_CHARS = 20_000;
export const MAX_TEXT_CHARS = 4_000;       // help request, comment, grade note
export const MAX_COMMAND_CHARS = 2_000;    // a check command
export const MAX_CHECKS = 20;
export const MAX_HINTS = 10;
export const MAX_CSV_CHARS = 200_000;
export const MAX_STUDENTS_PER_CLASS = 254;  // student number = last byte of 10.0.0.N

export const MAX_JOURNAL_BYTES = 64 * 2 ** 20;  // full branch journal; rejected with journal_too_large
export const MAX_CHUNK_BYTES = 8 * 2 ** 20;     // PUT events body
export const AUTOSAVE_MS = 3_000;               // at most one chunk per interval, plus one on pagehide
export const KEEPALIVE_MAX_BYTES = 60_000;      // browsers cap fetch keepalive bodies at 64 KiB

export const MAX_WS_MESSAGE_BYTES = 1 * 2 ** 20;
export const MAX_SERIAL_HISTORY_CHARS = 256_000; // a serial message with full: true
export const WS_PING_MS = 10_000;
export const WS_STALE_MS = 30_000;              // a client that pinged and went silent is dropped

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const UNDO_MS = 10_000;                  // how long the undo toast stays after a delete
