import { describe, expect, it, vi } from "vitest";
import { to_base64 } from "@core/net/base64.mjs";
import type { StudentProgress } from "@shared/api";
import type { Peer, ServerMessage } from "@shared/ws";
import { Socket, type WebSocketLike } from "@/lib/socket";
import { screenOf, SERIAL_HISTORY_BYTES, TeacherRoom } from "./teacher-room";

const ASSIGNMENT = 7;

class FakeWebSocket implements WebSocketLike {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: Record<string, unknown>[] = [];

  constructor() {
    FakeWebSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const encode = (text: string) => to_base64(new TextEncoder().encode(text));

function student(user_id: number, patch: Partial<StudentProgress> = {}): StudentProgress {
  return {
    user_id,
    name: `Студент ${user_id}`,
    number: user_id,
    status: "idle",
    attempt_id: null,
    started_at: null,
    last_activity_at: null,
    commands: 0,
    last_command: "",
    rollbacks: 0,
    open_help: null,
    latest_submission: null,
    ...patch,
  };
}

function peer(user_id: number, machines: string[] = ["m1"]): Peer {
  return { id: `p${user_id}`, user_id, role: "student", name: `Студент ${user_id}`, machines };
}

function setup(lists: StudentProgress[][] = [[student(1), student(2), student(3)]]) {
  FakeWebSocket.all = [];
  const socket = new Socket({
    url: "ws://test/ws",
    createWebSocket: () => new FakeWebSocket(),
    backoff: { next: () => 0, reset: () => undefined },
    pingMs: 60_000,
  });
  const fetchStudents = vi.fn(async () => lists[Math.min(fetchStudents.mock.calls.length - 1, lists.length - 1)] ?? []);
  const room = new TeacherRoom({ socket, assignmentId: ASSIGNMENT, fetchStudents });
  room.start();
  socket.connect();
  const ws = () => {
    const current = FakeWebSocket.all.at(-1);
    if (!current) throw new Error("no socket");
    return current;
  };
  const joined = (peers: Peer[], frozen = false) =>
    ws().receive({ type: "joined", id: "t9", role: "teacher", peers, frozen, resumed: false });
  return { socket, room, ws, joined, fetchStudents };
}

const serial = (from: string, text: string, extra: { machine?: string; full?: true } = {}): ServerMessage =>
  ({ type: "serial", from, data: encode(text), ...extra }) as ServerMessage;

describe("TeacherRoom", () => {
  it("joins when the socket opens and again after a reconnect, loading the list each time", async () => {
    const { ws, joined, fetchStudents, room } = setup([[student(1)], [student(1), student(2)]]);
    ws().open();
    expect(ws().sent).toEqual([{ type: "join", assignment_id: ASSIGNMENT }]);
    joined([]);
    await vi.waitFor(() => expect(room.getSnapshot().students).toHaveLength(1));
    expect(room.getSnapshot().joined).toBe(true);

    ws().drop();
    await vi.waitFor(() => expect(FakeWebSocket.all).toHaveLength(2));
    ws().open();
    expect(ws().sent).toEqual([{ type: "join", assignment_id: ASSIGNMENT }]);
    joined([]);
    await vi.waitFor(() => expect(room.getSnapshot().students).toHaveLength(2));
    expect(fetchStudents).toHaveBeenCalledTimes(2);
  });

  it("replaces one student by a tile and ignores tiles of other assignments", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([]);
    await vi.waitFor(() => expect(room.getSnapshot().loaded).toBe(true));
    ws().receive({ type: "tile", assignment_id: ASSIGNMENT, progress: student(2, { status: "work", commands: 4 }) });
    ws().receive({ type: "tile", assignment_id: ASSIGNMENT + 1, progress: student(3, { status: "done" }) });
    const [one, two, three] = room.getSnapshot().students;
    expect([one?.status, two?.status, three?.status]).toEqual(["idle", "work", "idle"]);
    expect(two?.commands).toBe(4);
    ws().receive({ type: "tile", assignment_id: ASSIGNMENT, progress: student(4, { status: "stuck" }) });
    expect(room.getSnapshot().students.map((s) => s.user_id)).toEqual([1, 2, 3, 4]);
  });

  it("puts a tile that arrived during the list request over the list", async () => {
    const { ws, joined, room, fetchStudents } = setup();
    let release: (list: StudentProgress[]) => void = () => undefined;
    fetchStudents.mockImplementationOnce(() => new Promise((done) => (release = done)));
    ws().open();
    joined([]);
    ws().receive({ type: "tile", assignment_id: ASSIGNMENT, progress: student(2, { status: "done" }) });
    release([student(1), student(2)]);
    await vi.waitFor(() => expect(room.getSnapshot().loaded).toBe(true));
    expect(room.getSnapshot().students.map((s) => s.status)).toEqual(["idle", "done"]);
  });

  it("appends serial output, and a full serial replaces the history", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1)]);
    ws().receive(serial("p1", "one\r\n"));
    ws().receive(serial("p1", "two\r\n"));
    await vi.waitFor(() => expect(screenOf(room.getSnapshot(), 1)?.lines).toEqual(["one", "two"]));
    ws().receive(serial("p1", "fresh\r\n$ ", { full: true }));
    await vi.waitFor(() => expect(screenOf(room.getSnapshot(), 1)?.lines).toEqual(["fresh", "$"]));
  });

  it("renders what the shell does to the line: backspace, erase, carriage return", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1)]);
    ws().receive(serial("p1", "$ ex\b\x1b[Kcho a\r\n$ typed\r\x1b[K$ "));
    await vi.waitFor(() => expect(screenOf(room.getSnapshot(), 1)?.lines).toEqual(["$ echo a", "$"]));
  });

  it("keeps the machines of one student apart", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1, ["pc1", "pc2"])]);
    ws().receive(serial("p1", "on pc1\r\n", { machine: "pc1" }));
    ws().receive(serial("p1", "on pc2\r\n", { machine: "pc2" }));
    await vi.waitFor(() => expect(room.getSnapshot().screens[1]?.["pc2"]).toEqual(["on pc2"]));
    expect(room.getSnapshot().screens[1]).toEqual({ pc1: ["on pc1"], pc2: ["on pc2"] });
    expect(screenOf(room.getSnapshot(), 1, "pc2")?.machine).toBe("pc2");
    expect(screenOf(room.getSnapshot(), 1)?.machine).toBe("pc1");
  });

  it("ignores the hidden terminal and peers it does not know", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1)]);
    ws().receive(serial("p1", "secret\r\n", { port: 2 } as { machine?: string }));
    ws().receive(serial("p5", "stranger\r\n"));
    ws().receive(serial("p1", "visible\r\n"));
    await vi.waitFor(() => expect(room.getSnapshot().screens[1]).toBeDefined());
    expect(room.getSnapshot().screens).toEqual({ 1: { "": ["visible"] } });
  });

  it("keeps the raw output of port 2 apart from port 0, per machine", () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1, ["pc1", "pc2"])]);
    ws().receive(serial("p1", "main\r\n", { machine: "pc1" }));
    ws().receive(serial("p1", "root# ", { machine: "pc1", port: 2 } as { machine?: string }));
    ws().receive(serial("p1", "other\r\n", { machine: "pc2" }));
    const text = (machine: string, port: 0 | 2) =>
      new TextDecoder().decode(Buffer.concat(room.serialHistory(1, machine, port)));
    expect(text("pc1", 0)).toBe("main\r\n");
    expect(text("pc1", 2)).toBe("root# ");
    expect(text("pc2", 0)).toBe("other\r\n");
    expect(text("pc2", 2)).toBe("");
  });

  it("replaces the history on a full serial and tells the listener", () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1)]);
    const seen: { text: string; full: boolean }[] = [];
    const off = room.onSerial(1, "", 0, (bytes, full) => seen.push({ text: new TextDecoder().decode(bytes), full }));
    ws().receive(serial("p1", "one\r\n"));
    ws().receive(serial("p1", "fresh", { full: true }));
    expect(new TextDecoder().decode(Buffer.concat(room.serialHistory(1, "", 0)))).toBe("fresh");
    off();
    ws().receive(serial("p1", "later"));
    expect(seen).toEqual([
      { text: "one\r\n", full: false },
      { text: "fresh", full: true },
    ]);
  });

  it("cuts the oldest bytes of a port past 256 KB", () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([peer(1)]);
    const block = "a".repeat(100 * 1024);
    for (let i = 0; i < 3; i++) ws().receive(serial("p1", block));
    ws().receive(serial("p1", "TAIL"));
    const chunks = room.serialHistory(1, "", 0);
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(bytes).toBe(SERIAL_HISTORY_BYTES);
    expect(new TextDecoder().decode(chunks.at(-1))).toBe("TAIL");
  });

  it("sends input to the peer of a student in the room, and to nobody else", () => {
    const { ws, joined, room } = setup();
    ws().open();
    expect(room.sendInput(1, "x", { port: 0 })).toBe(false);
    joined([peer(1)]);
    expect(room.sendInput(1, "ls\r", { port: 0, machine: "m1" })).toBe(true);
    expect(ws().sent.at(-1)).toEqual({ type: "input", to: "p1", data: "ls\r", port: 0, machine: "m1" });
    expect(room.sendInput(1, "id\r", { port: 2 })).toBe(true);
    expect(ws().sent.at(-1)).toEqual({ type: "input", to: "p1", data: "id\r", port: 2 });
    expect(room.sendInput(2, "x", { port: 0 })).toBe(false);
    ws().receive({ type: "peer-left", id: "p1" });
    const sent = ws().sent.length;
    expect(room.sendInput(1, "x", { port: 0 })).toBe(false);
    expect(ws().sent).toHaveLength(sent);
  });

  it("tracks frozen from joined, from frozen, and sends freeze", async () => {
    const { ws, joined, room } = setup();
    ws().open();
    joined([], true);
    expect(room.getSnapshot().frozen).toBe(true);
    expect(room.freeze(false)).toBe(true);
    expect(ws().sent.at(-1)).toEqual({ type: "freeze", frozen: false });
    ws().receive({ type: "frozen", frozen: false, by: { id: 9, name: "Викладач" } });
    expect(room.getSnapshot().frozen).toBe(false);
  });

  it("keeps a student who never came to the room with the data of the list", async () => {
    const { ws, joined, room } = setup([[student(1, { status: "work", commands: 3, last_command: "ls" }), student(2)]]);
    ws().open();
    joined([peer(2)]);
    await vi.waitFor(() => expect(room.getSnapshot().loaded).toBe(true));
    const snapshot = room.getSnapshot();
    expect(snapshot.students[0]).toMatchObject({ user_id: 1, status: "work", commands: 3, last_command: "ls" });
    expect(Object.keys(snapshot.online)).toEqual(["2"]);
    expect(screenOf(snapshot, 1)).toBeNull();
    ws().receive({ type: "peer-left", id: "p2" });
    expect(room.getSnapshot().online).toEqual({});
  });
});
