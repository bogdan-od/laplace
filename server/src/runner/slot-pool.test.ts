import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotPool } from './slot-pool';

const poolOf = (workers: number): SlotPool =>
  new SlotPool({ workers, timeoutMs: 1000 });

/** Lets promise callbacks run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

test('jobs beyond the number of slots wait until one is released, in order', async () => {
  const pool = poolOf(2);
  const order: string[] = [];
  const first = await pool.acquire(1);
  const second = await pool.acquire(1);
  void pool.acquire(1).then(() => order.push('third'));
  void pool.acquire(1).then(() => order.push('fourth'));
  await tick();
  assert.deepEqual(order, []);
  first();
  await tick();
  assert.deepEqual(order, ['third']);
  second();
  await tick();
  assert.deepEqual(order, ['third', 'fourth']);
});

test('a job heavier than the pool takes the whole pool and runs alone', async () => {
  const pool = poolOf(2);
  const small = await pool.acquire(1);
  let heavyRan = false;
  const heavy = pool.acquire(6).then((release) => {
    heavyRan = true;
    return release;
  });
  await tick();
  assert.equal(heavyRan, false);
  small();
  const release = await heavy;
  let lateRan = false;
  void pool.acquire(1).then(() => {
    lateRan = true;
  });
  await tick();
  assert.equal(lateRan, false);
  release();
  await tick();
  assert.equal(lateRan, true);
});

test('releasing twice does not give back more than was taken', async () => {
  const pool = poolOf(1);
  const release = await pool.acquire(1);
  release();
  release();
  await pool.acquire(1);
  let ran = false;
  void pool.acquire(1).then(() => {
    ran = true;
  });
  await tick();
  assert.equal(ran, false);
});
