import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCHEME = 'scrypt';

/** The password_hash of an account that has no password (LTI students): verifyPassword never accepts it. */
export const NO_PASSWORD_HASH = '!';

/** Format from schema.sql: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N, r: R, p: P });
  return [
    SCHEME,
    N,
    R,
    P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== SCHEME || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(
    password,
    Buffer.from(salt, 'base64'),
    expected.length,
    { N: Number(n), r: Number(r), p: Number(p) },
  );
  return timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real check, so an unknown login is not distinguishable by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy');
  await verifyPassword(password, await dummyHash);
}
