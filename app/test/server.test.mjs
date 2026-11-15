import assert from "node:assert";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { start_server } from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JOURNAL_DIR = path.join(ROOT, "app", "data", "journals");
const WAIT_MS = 3000;
const POLL_MS = 10;
const LONG_MESSAGE_CHARS = 200_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CONTINUATION = 0x0;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MASK_LENGTH = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, what) {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(POLL_MS);
  }
}

function httpRequest(port, { method = "GET", path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function maskedFrame(opcode, payload, fin = true) {
  const mask = crypto.randomBytes(MASK_LENGTH);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % MASK_LENGTH]));
  const first = (fin ? 0x80 : 0) | opcode;
  const header =
    payload.length < 126
      ? Buffer.from([first, 0x80 | payload.length])
      : Buffer.from([first, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    let length = buffer[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }
    if (offset + headerLength + length > buffer.length) break;
    const payload = buffer.subarray(offset + headerLength, offset + headerLength + length);
    frames.push({ opcode: buffer[offset] & 0x0f, payload });
    offset += headerLength + length;
  }
  return frames;
}

describe("app/server.mjs", () => {
  let server;
  let port;
  const cleanups = [];
  const journalIds = [];

  before(async () => {
    server = await start_server(0);
    port = server.address().port;
  });

  after(() => {
    for (const id of journalIds) fs.rmSync(path.join(JOURNAL_DIR, `${id}.json`), { force: true });
    cleanups.forEach((cleanup) => cleanup());
    server.close();
    server.closeAllConnections();
  });

  describe("static files", () => {
    const file_path = path.join(ROOT, "package.json");

    test("serves a file from the project root", async () => {
      const response = await httpRequest(port, { path: "/package.json" });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body, fs.readFileSync(file_path));
      assert.strictEqual(response.headers["cache-control"], "no-cache");
    });

    test("the root redirects to lab.html", async () => {
      const response = await httpRequest(port, { path: "/" });
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.location, "/app/lab.html");
    });

    test("Range bytes=a-b returns a part with 206", async () => {
      const full = fs.readFileSync(file_path);
      const response = await httpRequest(port, { path: "/package.json", headers: { Range: "bytes=5-14" } });
      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers["content-range"], `bytes 5-14/${full.length}`);
      assert.strictEqual(response.headers["accept-ranges"], "bytes");
      assert.deepStrictEqual(response.body, full.subarray(5, 15));
    });

    test("Range bytes=a- returns the tail of the file", async () => {
      const full = fs.readFileSync(file_path);
      const response = await httpRequest(port, { path: "/package.json", headers: { Range: `bytes=${full.length - 20}-` } });
      assert.strictEqual(response.status, 206);
      assert.deepStrictEqual(response.body, full.subarray(full.length - 20));
    });

    test("going above the root answers 403", async () => {
      for (const urlPath of ["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
        const response = await httpRequest(port, { path: urlPath });
        assert.strictEqual(response.status, 403, urlPath);
      }
    });

    test("a missing file answers 404", async () => {
      const response = await httpRequest(port, { path: "/no-such-file.txt" });
      assert.strictEqual(response.status, 404);
    });
  });

  describe("journals", () => {
    test("POST saves a journal, GET returns it", async () => {
      const journal = JSON.stringify({ format: 1, events: [1, 2, 3] });
      const posted = await httpRequest(port, {
        method: "POST",
        path: "/journals",
        headers: { "Content-Type": "application/json" },
        body: journal,
      });
      assert.strictEqual(posted.status, 200);
      const { id } = JSON.parse(posted.body.toString());
      journalIds.push(id);
      assert.match(id, /^[0-9a-f]{12}$/);
      assert.strictEqual(fs.readFileSync(path.join(JOURNAL_DIR, `${id}.json`), "utf8"), journal);

      const fetched = await httpRequest(port, { path: `/journals/${id}` });
      assert.strictEqual(fetched.status, 200);
      assert.strictEqual(fetched.headers["content-type"], "application/json");
      assert.strictEqual(fetched.body.toString(), journal);
    });

    test("invalid JSON answers 400", async () => {
      const response = await httpRequest(port, { method: "POST", path: "/journals", body: "{not json" });
      assert.strictEqual(response.status, 400);
    });

    test("GET with a bad or unknown id answers 404", async () => {
      for (const urlPath of ["/journals/xyz", "/journals/000000000000"]) {
        const response = await httpRequest(port, { path: urlPath });
        assert.strictEqual(response.status, 404, urlPath);
      }
    });
  });

  describe("WebSocket", () => {
    async function connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const client = { ws, received: [] };
      ws.addEventListener("message", (event) => client.received.push(JSON.parse(event.data)));
      await waitUntil(() => ws.readyState === WebSocket.OPEN, "ws open");
      cleanups.push(() => ws.close());
      return client;
    }

    function send(client, message) {
      client.ws.send(JSON.stringify(message));
    }

    async function next(client, type) {
      await waitUntil(() => client.received.some((message) => message.type === type), `"${type}"`);
      const index = client.received.findIndex((message) => message.type === type);
      return client.received.splice(index, 1)[0];
    }

    async function join(client, room, role, name, extra = {}) {
      send(client, { type: "join", room, role, name, ...extra });
      return next(client, "joined");
    }

    async function openRoom() {
      const room = `room-${crypto.randomUUID()}`;
      const teacher = await connect();
      const teacherJoined = await join(teacher, room, "teacher", "Викладач");
      const student = await connect();
      const studentJoined = await join(student, room, "student", "Студент");
      return { room, teacher, teacherId: teacherJoined.id, student, studentId: studentJoined.id, studentJoined };
    }

    test("join: joined with the member list, peer-joined to the others", async () => {
      const { teacher, teacherId, student, studentId, studentJoined } = await openRoom();
      assert.deepStrictEqual(studentJoined.peers, [{ id: teacherId, role: "teacher", name: "Викладач" }]);
      assert.strictEqual(studentJoined.task, null);
      assert.deepStrictEqual(await next(teacher, "peer-joined"), {
        type: "peer-joined",
        id: studentId,
        role: "student",
        name: "Студент",
      });
    });

    test("signal reaches the addressee", async () => {
      const { teacher, teacherId, student, studentId } = await openRoom();
      send(teacher, { type: "signal", to: studentId, data: { sdp: "offer" } });
      assert.deepStrictEqual(await next(student, "signal"), { type: "signal", from: teacherId, data: { sdp: "offer" } });
    });

    test("serial from a student reaches the teacher", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(student, { type: "serial", data: "ls\r" });
      assert.deepStrictEqual(await next(teacher, "serial"), { type: "serial", from: studentId, data: "ls\r" });
    });

    test("frame reaches the addressed student, but not the teacher and not another room", async () => {
      const { room, teacher, teacherId, student, studentId } = await openRoom();
      const mate = await connect();
      const mateId = (await join(mate, room, "student", "Neighbour")).id;
      const stranger = await connect();
      const strangerId = (await join(stranger, `room-${crypto.randomUUID()}`, "student", "Stranger")).id;
      send(student, { type: "frame", to: mateId, data: "AQID" });
      assert.deepStrictEqual(await next(mate, "frame"), { type: "frame", from: studentId, data: "AQID" });
      send(student, { type: "frame", to: teacherId, data: "AQID" });
      send(student, { type: "frame", to: strangerId, data: "AQID" });
      send(student, { type: "serial", data: "after" });
      await next(teacher, "serial");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(!teacher.received.some((message) => message.type === "frame"));
      assert.ok(!stranger.received.some((message) => message.type === "frame"));
    });

    test("frame from the teacher is not forwarded", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(teacher, { type: "frame", to: studentId, data: "AQID" });
      send(teacher, { type: "input", to: studentId, data: "x" });
      await next(student, "input");
      assert.ok(!student.received.some((message) => message.type === "frame"));
    });

    test("input from the teacher reaches the student", async () => {
      const { teacher, teacherId, student, studentId } = await openRoom();
      send(teacher, { type: "input", to: studentId, data: "pwd\r" });
      assert.deepStrictEqual(await next(student, "input"), { type: "input", from: teacherId, data: "pwd\r" });
    });

    test("task is remembered and reaches a new student in joined", async () => {
      const { room, teacher, teacherId, student } = await openRoom();
      send(teacher, { type: "task", journal_id: "0123456789ab" });
      assert.deepStrictEqual(await next(student, "task"), {
        type: "task",
        from: teacherId,
        journal_id: "0123456789ab",
      });
      const late = await connect();
      const lateJoined = await join(late, room, "student", "Late");
      assert.strictEqual(lateJoined.task, "0123456789ab");
    });

    test("peer-left when the socket closes", async () => {
      const { teacher, teacherId, student } = await openRoom();
      teacher.ws.close();
      assert.deepStrictEqual(await next(student, "peer-left"), { type: "peer-left", id: teacherId });
    });

    test("report with kind submit reaches the teacher with the same kind", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(student, { type: "report", journal_id: "0123456789ab", kind: "submit", note: "" });
      const report = await next(teacher, "report");
      assert.strictEqual(report.from, studentId);
      assert.strictEqual(report.kind, "submit");
    });

    test("report without kind or with an unknown kind arrives as problem", async () => {
      const { teacher, student } = await openRoom();
      send(student, { type: "report", journal_id: "0123456789ab", note: "" });
      assert.strictEqual((await next(teacher, "report")).kind, "problem");
      send(student, { type: "report", journal_id: "0123456789ab", kind: "other", note: "" });
      assert.strictEqual((await next(teacher, "report")).kind, "problem");
    });

    test("a repeated join with the same key gives the same id and name, the others see a leave and a join", async () => {
      const { room, teacher, student, studentId } = await openRoom();
      const key = crypto.randomUUID();
      const first = await join(await connect(), room, "student", "Keyed", { key });
      assert.match(first.id, /^p\d+$/);
      const mate = await connect();
      await join(mate, room, "student", "Neighbour");
      student.ws.close();
      await next(teacher, "peer-left");
      const second = await connect();
      const again = await join(second, room, "student", "Other name", { key });
      assert.strictEqual(again.id, first.id);
      assert.strictEqual(again.resumed, true);
      assert.ok(again.peers.every((peer) => peer.id !== again.id));
      assert.notStrictEqual(again.id, studentId);
      const joined = (await next(mate, "peer-joined"));
      assert.deepStrictEqual(joined, { type: "peer-joined", id: first.id, role: "student", name: "Keyed" });
    });

    test("while the old connection is alive, a repeated join with the key replaces it with a replaced message", async () => {
      const { room } = await openRoom();
      const key = crypto.randomUUID();
      const old = await connect();
      const oldJoined = await join(old, room, "student", "Tab", { key });
      const fresh = await connect();
      const freshJoined = await join(fresh, room, "student", "Tab", { key });
      assert.strictEqual(freshJoined.id, oldJoined.id);
      await next(old, "replaced");
    });

    test("different keys give different numbers, without a key the number is new every time", async () => {
      const { room } = await openRoom();
      const ids = new Set();
      for (const extra of [{ key: "a" }, { key: "b" }, {}, {}]) {
        ids.add((await join(await connect(), room, "student", "X", extra)).id);
      }
      assert.strictEqual(ids.size, 4);
    });

    test("after a server restart the client takes its previous number if it is free", async () => {
      const room = `room-${crypto.randomUUID()}`;
      const claimed = await join(await connect(), room, "student", "Old", { key: "k1", slot: "p7" });
      assert.strictEqual(claimed.id, "p7");
      const taken = await join(await connect(), room, "student", "Impostor", { key: "k2", slot: "p7" });
      assert.notStrictEqual(taken.id, "p7");
      const fresh = await join(await connect(), room, "student", "New", { key: "k3" });
      assert.ok(Number(fresh.id.slice(1)) > 7, fresh.id);
      const bad = await join(await connect(), room, "student", "Garbage", { key: "k4", slot: "t1; drop" });
      assert.match(bad.id, /^p\d+$/);
    });

    test("report is confirmed by report-ack, a repeat with the same ref is not duplicated", async () => {
      const { teacher, student, studentId } = await openRoom();
      const report = { type: "report", ref: "r-1", journal_id: "0123456789ab", kind: "submit", note: "" };
      send(student, report);
      assert.deepStrictEqual(await next(student, "report-ack"), { type: "report-ack", ref: "r-1" });
      const delivered = await next(teacher, "report");
      assert.strictEqual(delivered.from, studentId);
      assert.strictEqual(delivered.ref, "r-1");
      assert.strictEqual(typeof delivered.at, "number");
      send(student, report);
      await next(student, "report-ack");
      send(student, { type: "serial", data: "after" });
      await next(teacher, "serial");
      assert.ok(!teacher.received.some((message) => message.type === "report"));
    });

    test("a teacher who joins gets the room's reports, a student gets an empty list", async () => {
      const { room, student, studentJoined } = await openRoom();
      assert.deepStrictEqual(studentJoined.reports, []);
      send(student, { type: "report", ref: "a", journal_id: "aaaaaaaaaaaa", kind: "problem", note: "" });
      send(student, { type: "report", ref: "b", journal_id: "bbbbbbbbbbbb", kind: "submit", note: "" });
      await next(student, "report-ack");
      await next(student, "report-ack");
      const late = await join(await connect(), room, "teacher", "New teacher");
      assert.deepStrictEqual(late.reports.map((report) => [report.ref, report.kind, report.journal_id]), [
        ["a", "problem", "aaaaaaaaaaaa"],
        ["b", "submit", "bbbbbbbbbbbb"],
      ]);
    });

    test("the room survives everyone leaving: the task, seats and reports stay", async () => {
      const { room, teacher, student } = await openRoom();
      const key = crypto.randomUUID();
      const keyed = await connect();
      const keyedJoined = await join(keyed, room, "student", "Keyed", { key });
      send(teacher, { type: "task", journal_id: "0123456789ab" });
      send(keyed, { type: "report", ref: "z", journal_id: "cccccccccccc", kind: "problem", note: "" });
      await next(keyed, "report-ack");
      for (const client of [teacher, student, keyed]) client.ws.close();
      await sleep(100);
      const back = await join(await connect(), room, "student", "Keyed", { key });
      assert.strictEqual(back.id, keyedJoined.id);
      assert.strictEqual(back.task, "0123456789ab");
      const teacherAgain = await join(await connect(), room, "teacher", "Викладач");
      assert.strictEqual(teacherAgain.reports.length, 1);
    });

    test("join with machines reaches the teacher in peer-joined, and a later joiner in joined.peers", async () => {
      const { room, teacher } = await openRoom();
      await next(teacher, "peer-joined");
      const machines = ["pc1", "router-1"];
      const topo = await connect();
      const topoJoined = await join(topo, room, "student", "Топологія", { machines });
      const peerJoined = await next(teacher, "peer-joined");
      assert.strictEqual(peerJoined.id, topoJoined.id);
      assert.deepStrictEqual(peerJoined.machines, machines);
      const late = await join(await connect(), room, "teacher", "Другий");
      assert.deepStrictEqual(late.peers.find((peer) => peer.id === topoJoined.id).machines, machines);
      assert.ok(late.peers.filter((peer) => peer.id !== topoJoined.id).every((peer) => !("machines" in peer)));
    });

    test("invalid machines in join are dropped, the join goes through", async () => {
      const { room, teacher } = await openRoom();
      await next(teacher, "peer-joined");
      const bad = [["a b"], ["a", "a"], "pc1", [], Array.from({ length: 7 }, (_, i) => `m${i}`)];
      for (const machines of bad) {
        const joined = await join(await connect(), room, "student", "Сміття", { machines });
        const peerJoined = await next(teacher, "peer-joined");
        assert.strictEqual(peerJoined.id, joined.id);
        assert.ok(!("machines" in peerJoined), JSON.stringify(machines));
      }
    });

    test("serial with machine reaches the teacher with the same machine, an invalid machine is dropped", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(student, { type: "serial", data: "ls\r", machine: "pc1", full: true });
      assert.deepStrictEqual(await next(teacher, "serial"), {
        type: "serial", from: studentId, data: "ls\r", full: true, machine: "pc1",
      });
      send(student, { type: "serial", data: "x", machine: "pc 1" });
      assert.deepStrictEqual(await next(teacher, "serial"), { type: "serial", from: studentId, data: "x" });
      send(student, { type: "serial", data: "y", machine: "m".repeat(65) });
      assert.deepStrictEqual(await next(teacher, "serial"), { type: "serial", from: studentId, data: "y" });
    });

    test("input with machine reaches the student with the same machine, an invalid machine is dropped", async () => {
      const { teacher, teacherId, student, studentId } = await openRoom();
      send(teacher, { type: "input", to: studentId, data: "pwd\r", machine: "router-1" });
      assert.deepStrictEqual(await next(student, "input"), {
        type: "input", from: teacherId, data: "pwd\r", machine: "router-1",
      });
      send(teacher, { type: "input", to: studentId, data: "q", machine: 5 });
      assert.deepStrictEqual(await next(student, "input"), { type: "input", from: teacherId, data: "q" });
    });

    test("report with machine and group reaches the teacher and gets into the reports of a later joiner", async () => {
      const { room, teacher, student, studentId } = await openRoom();
      send(student, { type: "report", ref: "m-1", journal_id: "0123456789ab", kind: "submit", note: "", machine: "pc1", group: "g-1" });
      await next(student, "report-ack");
      const delivered = await next(teacher, "report");
      assert.strictEqual(delivered.from, studentId);
      assert.strictEqual(delivered.machine, "pc1");
      assert.strictEqual(delivered.group, "g-1");
      const late = await join(await connect(), room, "teacher", "Пізній");
      assert.strictEqual(late.reports[0].machine, "pc1");
      assert.strictEqual(late.reports[0].group, "g-1");
    });

    test("invalid machine and group in report are dropped, the rest of the report goes through; deduplication by ref as before", async () => {
      const { teacher, student } = await openRoom();
      const base = { type: "report", ref: "m-2", journal_id: "0123456789ab", kind: "submit", note: "n" };
      send(student, { ...base, machine: "a b", group: "x".repeat(65) });
      const delivered = await next(teacher, "report");
      assert.strictEqual(delivered.kind, "submit");
      assert.strictEqual(delivered.journal_id, "0123456789ab");
      assert.ok(!("machine" in delivered) && !("group" in delivered));
      send(student, { ...base, machine: "pc1", group: "g" });
      await next(student, "report-ack");
      await next(student, "report-ack");
      send(student, { type: "serial", data: "after" });
      await next(teacher, "serial");
      assert.ok(!teacher.received.some((message) => message.type === "report"));
    });

    test("report without machine and group does not get these fields", async () => {
      const { teacher, student } = await openRoom();
      send(student, { type: "report", journal_id: "0123456789ab", kind: "problem", note: "" });
      const delivered = await next(teacher, "report");
      assert.ok(!("machine" in delivered) && !("group" in delivered));
    });

    test("task with kind topology is remembered and goes to the student and a new student with the kind", async () => {
      const { room, teacher, teacherId, student } = await openRoom();
      send(teacher, { type: "task", journal_id: "0123456789ab", kind: "topology" });
      assert.deepStrictEqual(await next(student, "task"), {
        type: "task", from: teacherId, journal_id: "0123456789ab", kind: "topology",
      });
      const late = await join(await connect(), room, "student", "Late");
      assert.strictEqual(late.task, "0123456789ab");
      assert.strictEqual(late.kind, "topology");
    });

    test("an unknown kind in task turns into journal, the kind does not go out; a journal after a topology resets kind", async () => {
      const { room, teacher, teacherId, student } = await openRoom();
      send(teacher, { type: "task", journal_id: "0123456789ab", kind: "topology" });
      await next(student, "task");
      send(teacher, { type: "task", journal_id: "ba9876543210", kind: "weird" });
      assert.deepStrictEqual(await next(student, "task"), { type: "task", from: teacherId, journal_id: "ba9876543210" });
      const late = await join(await connect(), room, "student", "Late");
      assert.strictEqual(late.task, "ba9876543210");
      assert.ok(!("kind" in late));
    });

    test("ping answers pong; serial with full arrives with the full flag", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(student, { type: "ping" });
      assert.deepStrictEqual(await next(student, "pong"), { type: "pong" });
      send(student, { type: "serial", data: "AA==", full: true });
      assert.deepStrictEqual(await next(teacher, "serial"), { type: "serial", from: studentId, data: "AA==", full: true });
    });

    test("a 200 KB message arrives whole", async () => {
      const { teacher, student, studentId } = await openRoom();
      send(student, { type: "serial", data: "x".repeat(LONG_MESSAGE_CHARS) });
      const received = await next(teacher, "serial");
      assert.strictEqual(received.from, studentId);
      assert.strictEqual(received.data.length, LONG_MESSAGE_CHARS);
    });

    test("raw socket: join from two fragments in parts, ping → pong, 16-bit lengths", async () => {
      const socket = net.connect(port, "127.0.0.1");
      cleanups.push(() => socket.destroy());
      await once(socket, "connect");
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      let raw = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        raw = Buffer.concat([raw, chunk]);
      });
      await waitUntil(() => raw.includes("\r\n\r\n"), "handshake");
      const headerEnd = raw.indexOf("\r\n\r\n") + 4;
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      const head = raw.subarray(0, headerEnd).toString();
      assert.match(head, /^HTTP\/1\.1 101 /);
      assert.ok(head.includes(`Sec-WebSocket-Accept: ${accept}`), head);

      const join = Buffer.from(JSON.stringify({ type: "join", room: `room-${crypto.randomUUID()}`, role: "teacher", name: "А".repeat(150) }));
      const half = Math.floor(join.length / 2);
      const firstFrame = maskedFrame(OP_TEXT, join.subarray(0, half), false);
      socket.write(firstFrame.subarray(0, 3));
      await sleep(20);
      socket.write(firstFrame.subarray(3));
      socket.write(maskedFrame(OP_CONTINUATION, join.subarray(half)));
      socket.write(maskedFrame(OP_PING, Buffer.from("hi")));

      await waitUntil(() => parseServerFrames(raw.subarray(headerEnd)).length >= 2, "joined and pong");
      const frames = parseServerFrames(raw.subarray(headerEnd));
      assert.strictEqual(JSON.parse(frames[0].payload.toString()).type, "joined");
      assert.strictEqual(frames[1].opcode, OP_PONG);
      assert.strictEqual(frames[1].payload.toString(), "hi");
    });
  });
});
