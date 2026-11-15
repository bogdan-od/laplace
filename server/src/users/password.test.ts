import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './password';

test('hash has the schema.sql format and verifies only the right password', async () => {
  const hash = await hashPassword('correct horse');
  const [scheme, n, r, p, salt, key] = hash.split('$');
  assert.deepEqual([scheme, n, r, p], ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(salt ?? '', 'base64').length, 16);
  assert.equal(Buffer.from(key ?? '', 'base64').length, 64);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  assert.notEqual(hash, await hashPassword('correct horse'), 'salt differs');
});

test('a malformed stored hash never verifies', async () => {
  assert.equal(await verifyPassword('x', 'plain'), false);
  assert.equal(await verifyPassword('x', 'bcrypt$1$2$3$4$5'), false);
});
