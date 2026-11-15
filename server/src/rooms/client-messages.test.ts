import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_SERIAL_HISTORY_CHARS } from '@shared/limits';
import {
  MAX_FRAME_CHARS,
  MAX_INPUT_CHARS,
  MAX_SERIAL_CHARS,
  parseClientMessage,
} from './client-messages';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('parseClientMessage', () => {
  test('accepts every message of the contract', () => {
    assert.deepEqual(parse({ type: 'join', assignment_id: 3 }), {
      type: 'join',
      assignment_id: 3,
    });
    assert.deepEqual(
      parse({ type: 'join', assignment_id: 3, machines: ['a', 'b'] }),
      { type: 'join', assignment_id: 3, machines: ['a', 'b'] },
    );
    assert.deepEqual(parse({ type: 'signal', to: 't7', data: { sdp: 1 } }), {
      type: 'signal',
      to: 't7',
      data: { sdp: 1 },
    });
    assert.deepEqual(parse({ type: 'frame', to: 'p2', data: 'AAEC' }), {
      type: 'frame',
      to: 'p2',
      data: 'AAEC',
    });
    assert.deepEqual(
      parse({ type: 'serial', data: 'x', port: 2, machine: 'm1', full: true }),
      { type: 'serial', data: 'x', port: 2, machine: 'm1', full: true },
    );
    assert.deepEqual(
      parse({ type: 'input', to: 'p1', data: 'ls\n', port: 0 }),
      { type: 'input', to: 'p1', data: 'ls\n', port: 0 },
    );
    assert.deepEqual(parse({ type: 'freeze', frozen: false }), {
      type: 'freeze',
      frozen: false,
    });
    assert.deepEqual(parse({ type: 'ping' }), { type: 'ping' });
  });

  test('drops unknown fields so only checked data is forwarded', () => {
    assert.deepEqual(parse({ type: 'serial', data: 'x', extra: 'y' }), {
      type: 'serial',
      data: 'x',
    });
  });

  test('rejects garbage, wrong types and unknown message types', () => {
    for (const text of ['', 'nope', '[]', '"ping"', 'null', '{"type":"x"}']) {
      assert.equal(parseClientMessage(text), null, text);
    }
    const bad: unknown[] = [
      { type: 'join' },
      { type: 'join', assignment_id: '3' },
      { type: 'join', assignment_id: 1.5 },
      { type: 'join', assignment_id: 0 },
      { type: 'join', assignment_id: 3, machines: 'a' },
      { type: 'join', assignment_id: 3, machines: [1] },
      { type: 'signal', data: 1 },
      { type: 'signal', to: 'x1', data: 1 },
      { type: 'signal', to: 'p0', data: 1 },
      { type: 'signal', to: 'p1' },
      { type: 'frame', to: 'p1', data: 5 },
      { type: 'frame', to: 'p1', data: 'not base64!' },
      { type: 'serial' },
      { type: 'serial', data: 'x', port: 1 },
      { type: 'serial', data: 'x', full: false },
      { type: 'serial', data: 'x', machine: '' },
      { type: 'input', to: 'p1', data: 'x' },
      { type: 'input', to: 'p1', data: 'x', port: 3 },
      { type: 'freeze' },
      { type: 'freeze', frozen: 1 },
    ];
    for (const message of bad)
      assert.equal(parse(message), null, JSON.stringify(message));
  });

  test('enforces the data limits at the boundary', () => {
    const frame = (n: number) =>
      parse({ type: 'frame', to: 'p1', data: 'A'.repeat(n) });
    assert.notEqual(frame(MAX_FRAME_CHARS), null);
    assert.equal(frame(MAX_FRAME_CHARS + 1), null);
    const serial = (n: number, full?: true) =>
      parse({ type: 'serial', data: 'x'.repeat(n), ...(full ? { full } : {}) });
    assert.notEqual(serial(MAX_SERIAL_CHARS), null);
    assert.equal(serial(MAX_SERIAL_CHARS + 1), null);
    assert.notEqual(serial(MAX_SERIAL_HISTORY_CHARS, true), null);
    assert.equal(serial(MAX_SERIAL_HISTORY_CHARS + 1, true), null);
    const input = (n: number) =>
      parse({ type: 'input', to: 'p1', data: 'x'.repeat(n), port: 0 });
    assert.notEqual(input(MAX_INPUT_CHARS), null);
    assert.equal(input(MAX_INPUT_CHARS + 1), null);
  });
});
