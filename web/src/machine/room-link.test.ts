import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@shared/ws";
import { FLUSH_MS, RoomLink, type OutputEvent, type RoomEndpoint, type RoomSocket } from "./room-link";

type Handlers = Map<string, Set<(message: never) => void>>;

class FakeSocket {
  readonly handlers: Handlers = new Map();
  readonly sent: ClientMessage[] = [];
  joined: { id: number; machines?: string[] } | null = null;
  left = 0;

  on = (type: string, handler: (message: never) => void): (() => void) => {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  };
  send = (message: ClientMessage): boolean => {
    this.sent.push(message);
    return true;
  };
  join = (id: number, machines?: string[]): void => {
    this.joined = machines ? { id, machines } : { id };
  };
  leave = (): void => {
    this.left++;
  };

  receive(message: { type: string }): void {
    for (const handler of this.handlers.get(message.type) ?? []) handler(message as never);
  }
}

class FakeEndpoint implements RoomEndpoint {
  readonly node = "m1";
  readonly listeners = new Set<(event: OutputEvent) => void>();
  readonly received: [number, string][] = [];
  histories = new Map<number, Uint8Array>();

  subscribe(listener: (event: OutputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  history(port: number): Uint8Array {
    return this.histories.get(port) ?? new Uint8Array();
  }
  teacherInput(port: number, data: string): void {
    this.received.push([port, data]);
  }
  emit(event: OutputEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const joined = (role: "student" | "teacher", frozen = false) => ({
  type: "joined",
  id: role === "student" ? "p1" : "t1",
  role,
  peers: [],
  frozen,
  resumed: false,
});

function setup() {
  const socket = new FakeSocket();
  const endpoint = new FakeEndpoint();
  const frozen: boolean[] = [];
  let clock = 0;
  const link = new RoomLink({
    socket: socket as unknown as RoomSocket,
    assignmentId: 7,
    endpoints: [endpoint],
    onFrozen: (value) => frozen.push(value),
    now: () => clock,
  });
  link.start();
  return { socket, endpoint, frozen, link, advance: (ms: number) => void (clock += ms) };
}

describe("RoomLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins the room with the machine ids", () => {
    const { socket } = setup();
    expect(socket.joined).toEqual({ id: 7, machines: ["m1"] });
  });

  it("sends the full history after joined, then the output at once", () => {
    const { socket, endpoint, advance } = setup();
    endpoint.histories.set(0, bytes("boot\r\n"));

    socket.receive(joined("student"));
    advance(FLUSH_MS);
    endpoint.emit({ kind: "data", port: 0, bytes: bytes("$ ") });

    expect(socket.sent).toEqual([
      { type: "serial", data: btoa("boot\r\n"), machine: "m1", full: true },
      { type: "serial", data: btoa("$ "), machine: "m1" },
    ]);
  });

  it("keeps output that comes within the throttle window for the timer", () => {
    const { socket, endpoint, advance } = setup();
    socket.receive(joined("student"));
    advance(FLUSH_MS);
    endpoint.emit({ kind: "data", port: 0, bytes: bytes("a") });
    endpoint.emit({ kind: "data", port: 0, bytes: bytes("b") });
    endpoint.emit({ kind: "data", port: 0, bytes: bytes("c") });
    expect(socket.sent).toHaveLength(1);

    advance(FLUSH_MS);
    vi.advanceTimersByTime(FLUSH_MS);

    expect(socket.sent.map((message) => (message.type === "serial" ? atob(message.data) : ""))).toEqual(["a", "bc"]);
  });

  it("mirrors the hidden terminal as port 2", () => {
    const { socket, endpoint } = setup();
    socket.receive(joined("student"));
    endpoint.emit({ kind: "data", port: 2, bytes: bytes("#") });

    expect(socket.sent.at(-1)).toEqual({ type: "serial", data: btoa("#"), machine: "m1", port: 2 });
  });

  it("sends the history again when a teacher arrives", () => {
    const { socket, endpoint } = setup();
    endpoint.histories.set(0, bytes("hello"));
    socket.receive(joined("student"));
    socket.sent.length = 0;

    socket.receive({ type: "peer-joined", id: "t2", role: "teacher", name: "T" } as never);

    expect(socket.sent).toEqual([{ type: "serial", data: btoa("hello"), machine: "m1", full: true }]);
  });

  it("routes the teacher's input by port and ignores it before the join", () => {
    const { socket, endpoint } = setup();
    socket.receive({ type: "input", port: 0, data: "x" } as never);
    expect(endpoint.received).toEqual([]);

    socket.receive(joined("student"));
    socket.receive({ type: "input", port: 0, data: "ls\r" } as never);
    socket.receive({ type: "input", port: 2, data: "id\r" } as never);

    expect(endpoint.received).toEqual([
      [0, "ls\r"],
      [2, "id\r"],
    ]);
  });

  it("reports frozen from the join and from the message", () => {
    const { socket, frozen } = setup();
    socket.receive(joined("student", true));
    socket.receive({ type: "frozen", frozen: false } as never);

    expect(frozen).toEqual([true, false]);
  });

  it("clears the teacher's terminal on a reset and leaves the room on dispose", () => {
    const { socket, endpoint, link } = setup();
    socket.receive(joined("student"));
    endpoint.emit({ kind: "reset" });

    expect(socket.sent.at(-1)).toEqual({ type: "serial", data: btoa("\x1bc"), machine: "m1" });
    link.dispose();
    expect(socket.left).toBe(1);
    expect(endpoint.listeners.size).toBe(0);
  });
});
