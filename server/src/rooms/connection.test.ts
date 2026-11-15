import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Connection, MAX_BUFFERED_BYTES, Socket } from './connection';

class FakeSocket implements Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
}

const user = { id: 1, login: 'a', name: 'A', role: 'student' as const };

describe('Connection.send', () => {
  test('sends JSON while the buffer is small', () => {
    const socket = new FakeSocket();
    const connection = new Connection(socket, user, 0);
    socket.bufferedAmount = MAX_BUFFERED_BYTES;
    assert.equal(connection.send({ type: 'pong' }), true);
    assert.deepEqual(socket.sent, ['{"type":"pong"}']);
    assert.equal(socket.terminated, false);
  });

  test('drops a client whose buffer is over 4 MiB', () => {
    const socket = new FakeSocket();
    const connection = new Connection(socket, user, 0);
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    assert.equal(connection.send({ type: 'pong' }), false);
    assert.equal(socket.terminated, true);
    assert.deepEqual(socket.sent, []);
  });

  test('does not send to a socket that is not open', () => {
    const socket = new FakeSocket();
    socket.readyState = 2;
    assert.equal(new Connection(socket, user, 0).send({ type: 'pong' }), false);
    assert.deepEqual(socket.sent, []);
  });
});
