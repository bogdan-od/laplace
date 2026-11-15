import { randomInt } from 'node:crypto';

/** No 0/O/1/I: codes are read aloud and typed from a board. */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
const STUDENT_PASSWORD_LENGTH = 10;

function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
  }
  return out;
}

export const newInviteCode = (): string => randomString(INVITE_LENGTH);

/** Initial password of an imported student: the invite alphabet is easy to read off a printout. */
export const newStudentPassword = (): string =>
  randomString(STUDENT_PASSWORD_LENGTH);

export const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
