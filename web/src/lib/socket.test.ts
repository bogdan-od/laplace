import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket, type BackoffLike, type WebSocketLike } from "./socket";

class FakeWebSocket implements WebSocketLike {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: unknown[] = [];
  closedByClient = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Doubles from 500 like the real one, without jitter, and counts resets. */
class FixedBackoff implements BackoffLike {
  delay = 500;
  resets = 0;
  next(): number {
    const now = this.delay;
    this.delay = Math.min(this.delay * 2, 10_000);
    return now;
  }
  reset(): void {
    this.delay = 500;
    this.resets++;
  }
}

const PING_MS = 10_000;

function makeSocket() {
  const backoff = new FixedBackoff();
  const socket = new Socket({
    url: "ws://test/ws",
    createWebSocket: (url) => new FakeWebSocket(url),
    backoff,
    pingMs: PING_MS,
    connectTimeoutMs: 10_000,
  });
  return { socket, backoff };
}

function last(): FakeWebSocket {
  const ws = FakeWebSocket.all.at(-1);
  if (!ws) throw new Error("no socket created");
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Socket", () => {
  it("reconnects with a growing delay and resets it after a successful open", () => {
    const { socket, backoff } = makeSocket();
    socket.connect();
    expect(FakeWebSocket.all).toHaveLength(1);

    last().serverClose();
    expect(socket.state).toBe("waiting");
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(2);

    last().serverClose();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(3);

    last().serverClose();
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(4);

    last().open();
    expect(socket.state).toBe("open");
    expect(backoff.resets).toBe(1);
    last().serverClose();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(5);
  });

  it("gives up on a connection that does not open in time and tries again", () => {
    const { socket } = makeSocket();
    socket.connect();
    const first = last();
    vi.advanceTimersByTime(10_000);
    expect(first.closedByClient).toBe(true);
    expect(socket.state).toBe("waiting");
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("pings every WS_PING_MS while open and stops when closed", () => {
    const { socket } = makeSocket();
    socket.connect();
    const ws = last();
    ws.open();
    expect(ws.sent).toEqual([]);
    vi.advanceTimersByTime(PING_MS);
    expect(ws.sent).toEqual([{ type: "ping" }]);
    vi.advanceTimersByTime(PING_MS * 2);
    expect(ws.sent).toHaveLength(3);
    ws.serverClose();
    vi.advanceTimersByTime(PING_MS);
    expect(ws.sent).toHaveLength(3);
  });

  it("repeats the last join after a reconnect, and only the last one", () => {
    const { socket } = makeSocket();
    socket.connect();
    const first = last();
    first.open();
    socket.join(5, ["pc1"]);
    socket.join(7);
    expect(first.sent).toEqual([
      { type: "join", assignment_id: 5, machines: ["pc1"] },
      { type: "join", assignment_id: 7 },
    ]);

    first.serverClose();
    vi.advanceTimersByTime(500);
    const second = last();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent).toEqual([{ type: "join", assignment_id: 7 }]);
  });

  it("sends a join made while disconnected as soon as the connection opens", () => {
    const { socket } = makeSocket();
    socket.connect();
    expect(socket.send({ type: "join", assignment_id: 3 })).toBe(false);
    last().open();
    expect(last().sent).toEqual([{ type: "join", assignment_id: 3 }]);
  });

  it("stops for good on `replaced`: no reconnect, state replaced, handlers called", () => {
    const { socket } = makeSocket();
    const seen = vi.fn();
    socket.on("replaced", seen);
    socket.connect();
    const ws = last();
    ws.open();
    ws.receive({ type: "replaced" });
    expect(socket.state).toBe("replaced");
    expect(seen).toHaveBeenCalledOnce();

    ws.serverClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    socket.connect();
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(ws.sent).toEqual([]);
  });

  it("does not reconnect after a close with 4401 (not logged in)", () => {
    const { socket } = makeSocket();
    socket.connect();
    last().serverClose(4401);
    vi.advanceTimersByTime(60_000);
    expect(socket.state).toBe("unauthorized");
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("calls typed handlers by message type and ignores junk", () => {
    const { socket } = makeSocket();
    const onFrozen = vi.fn();
    const onSerial = vi.fn();
    socket.on("frozen", onFrozen);
    const stopSerial = socket.on("serial", onSerial);
    socket.connect();
    const ws = last();
    ws.open();

    ws.receive({ type: "frozen", frozen: true, by: { id: 1, name: "Т" } });
    ws.receive({ type: "serial", from: "p3", data: "ls\r\n" });
    ws.receive({ type: "nonsense" });
    ws.onmessage?.({ data: "{not json" });
    ws.receive(42);
    expect(onFrozen).toHaveBeenCalledOnce();
    expect(onSerial).toHaveBeenCalledWith({ type: "serial", from: "p3", data: "ls\r\n" });

    stopSerial();
    ws.receive({ type: "serial", from: "p3", data: "x" });
    expect(onSerial).toHaveBeenCalledOnce();
  });

  it("close() stops reconnecting and pings; connect() works again afterwards", () => {
    const { socket } = makeSocket();
    socket.connect();
    const ws = last();
    ws.open();
    socket.close();
    expect(ws.closedByClient).toBe(true);
    expect(socket.state).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(ws.sent).toEqual([]);
    socket.connect();
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("notifies state subscribers", () => {
    const { socket } = makeSocket();
    const listener = vi.fn();
    socket.subscribeState(listener);
    socket.connect();
    last().open();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(socket.getState()).toBe("open");
  });
});
