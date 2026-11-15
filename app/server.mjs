import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clean_group, clean_machine, clean_machines, clean_task_kind } from "./net/room_fields.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL_DIR = path.join(ROOT, "app", "data", "journals");
const DEFAULT_PORT = 8086;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const JOURNAL_ID_RE = /^[0-9a-f]{12}$/;
const RANGE_RE = /^bytes=(\d+)-(\d*)$/;
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR", "ERR_INVALID_ARG_VALUE"]);
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
]);
const TEXT_TYPE = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const FIN_BIT = 0x80;
const MASK_BIT = 0x80;
const LENGTH_MASK = 0x7f;
const MASK_LENGTH = 4;
const LENGTH_16_MARK = 126;
const LENGTH_64_MARK = 127;
const SHORT_LENGTH_LIMIT = 126;
const MAX_16_BIT_LENGTH = 0xffff;

const ROLES = new Set(["student", "teacher"]);
const REPORT_KINDS = new Set(["problem", "submit"]);
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 30000;
const SWEEP_MS = 10000;
const KEY_MAX_CHARS = 100;
const MAX_REPORTS = 1000;
const SLOT_RE = /^p([1-9]\d{0,5})$/;
const rooms = new Map();
let sweepTimer = null;

class PayloadTooLarge extends Error {}

function writeHead(res, status, headers = {}) {
  res.writeHead(status, { ...headers, "Cache-Control": "no-cache" });
}

function send(res, status, contentType, body) {
  writeHead(res, status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function start_server(port) {
  sweepTimer ??= setInterval(dropStaleClients, SWEEP_MS).unref();
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else send(res, 500, TEXT_TYPE, "Internal error");
    });
  });
  server.on("upgrade", handleUpgrade);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function handleHttp(req, res) {
  const urlPath = req.url.split("?")[0];
  if (req.method === "POST" && urlPath === "/journals") return postJournal(req, res);
  if (req.method !== "GET") return send(res, 405, TEXT_TYPE, "Method not allowed");
  if (urlPath.startsWith("/journals/")) return getJournal(res, urlPath.slice("/journals/".length));
  return serveStatic(req, res, urlPath);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else reject(new PayloadTooLarge());
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isJson(body) {
  try {
    JSON.parse(body.toString("utf8"));
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

async function postJournal(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_JOURNAL_BYTES);
  } catch (error) {
    if (!(error instanceof PayloadTooLarge)) throw error;
    writeHead(res, 413, { "Content-Type": TEXT_TYPE, Connection: "close" });
    return res.end("Payload too large");
  }
  if (!isJson(body)) return send(res, 400, TEXT_TYPE, "Invalid JSON");
  const id = crypto.randomBytes(6).toString("hex");
  await fs.promises.mkdir(JOURNAL_DIR, { recursive: true });
  await fs.promises.writeFile(journalPath(id), body);
  return send(res, 200, JSON_TYPE, JSON.stringify({ id }));
}

async function getJournal(res, id) {
  if (!JOURNAL_ID_RE.test(id)) return send(res, 404, TEXT_TYPE, "Not found");
  let body;
  try {
    body = await fs.promises.readFile(journalPath(id));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return send(res, 404, TEXT_TYPE, "Not found");
  }
  return send(res, 200, JSON_TYPE, body);
}

function journalPath(id) {
  return path.join(JOURNAL_DIR, `${id}.json`);
}

async function serveStatic(req, res, urlPath) {
  if (urlPath === "/") {
    writeHead(res, 302, { Location: "/app/lab.html" });
    return res.end();
  }
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return send(res, 400, TEXT_TYPE, "Bad request");
  }
  const file = path.resolve(ROOT, `.${decoded}`);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, TEXT_TYPE, "Forbidden");
  const stat = await statFile(file);
  if (!stat?.isFile()) return send(res, 404, TEXT_TYPE, "Not found");
  return sendFile(req, res, file, stat.size);
}

async function statFile(file) {
  try {
    return await fs.promises.stat(file);
  } catch (error) {
    if (NOT_FOUND_CODES.has(error.code)) return null;
    throw error;
  }
}

function parseRange(header, size) {
  const match = RANGE_RE.exec(header ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return { start, end };
}

function sendFile(req, res, file, size) {
  const headers = { "Content-Type": mimeOf(file), "Accept-Ranges": "bytes" };
  const range = parseRange(req.headers.range, size);
  if (!range) {
    writeHead(res, 200, { ...headers, "Content-Length": size });
    return pipeFile(file, res, {});
  }
  if (range.start > range.end) {
    writeHead(res, 416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  writeHead(res, 206, {
    ...headers,
    "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    "Content-Length": range.end - range.start + 1,
  });
  return pipeFile(file, res, range);
}

function pipeFile(file, res, bounds) {
  const stream = fs.createReadStream(file, bounds);
  stream.on("error", (error) => {
    console.error(error);
    res.destroy();
  });
  stream.pipe(res);
}

function mimeOf(file) {
  return MIME_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream";
}

function handleUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.url.split("?")[0] !== "/ws" || typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  attachClient(socket, head);
}

function attachClient(socket, head) {
  const client = {
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragmentBytes: 0,
    fragmentOpcode: null,
    id: null,
    room: null,
    role: null,
    name: "",
    closed: false,
    lastSeen: Date.now(),
    pings: false,
  };
  socket.on("data", (chunk) => onData(client, chunk));
  socket.on("close", () => leave(client));
  // 'close' always follows 'error', so the cleanup lives in the close handler
  socket.on("error", () => {});
  onData(client, head);
}

function onData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  let frameRead = true;
  while (frameRead && !client.closed) frameRead = readFrame(client);
}

function parseHeader(buffer) {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & MASK_BIT) !== 0;
  const lengthMark = buffer[1] & LENGTH_MASK;
  let headerLength = 2;
  if (lengthMark === LENGTH_16_MARK) headerLength += 2;
  else if (lengthMark === LENGTH_64_MARK) headerLength += 8;
  if (masked) headerLength += MASK_LENGTH;
  if (buffer.length < headerLength) return null;
  let payloadLength = lengthMark;
  if (lengthMark === LENGTH_16_MARK) payloadLength = buffer.readUInt16BE(2);
  else if (lengthMark === LENGTH_64_MARK) payloadLength = Number(buffer.readBigUInt64BE(2));
  return {
    fin: (buffer[0] & FIN_BIT) !== 0,
    opcode: buffer[0] & 0x0f,
    payloadLength,
    headerLength,
    mask: masked ? buffer.subarray(headerLength - MASK_LENGTH, headerLength) : null,
  };
}

function unmask(payload, mask) {
  if (!mask) return payload;
  const output = Buffer.from(payload);
  for (let index = 0; index < output.length; index++) output[index] ^= mask[index % MASK_LENGTH];
  return output;
}

function readFrame(client) {
  const header = parseHeader(client.buffer);
  if (!header) return false;
  if (header.payloadLength > MAX_MESSAGE_BYTES) {
    dropClient(client);
    return false;
  }
  const frameEnd = header.headerLength + header.payloadLength;
  if (client.buffer.length < frameEnd) return false;
  const payload = unmask(client.buffer.subarray(header.headerLength, frameEnd), header.mask);
  client.buffer = client.buffer.subarray(frameEnd);
  onFrame(client, header, payload);
  return true;
}

function onFrame(client, header, payload) {
  if (header.opcode === OP_PING) sendFrame(client, OP_PONG, payload);
  else if (header.opcode === OP_CLOSE) closeClient(client);
  else if ([OP_TEXT, OP_BINARY, OP_CONTINUATION].includes(header.opcode)) collectMessage(client, header, payload);
}

function collectMessage(client, header, payload) {
  if (header.opcode !== OP_CONTINUATION) {
    client.fragmentOpcode = header.opcode;
    client.fragments = [];
    client.fragmentBytes = 0;
  } else if (client.fragmentOpcode === null) {
    return;
  }
  client.fragments.push(payload);
  client.fragmentBytes += payload.length;
  if (client.fragmentBytes > MAX_MESSAGE_BYTES) {
    dropClient(client);
    return;
  }
  if (!header.fin) return;
  const message = Buffer.concat(client.fragments);
  const opcode = client.fragmentOpcode;
  client.fragments = [];
  client.fragmentBytes = 0;
  client.fragmentOpcode = null;
  if (opcode === OP_TEXT) handleText(client, message.toString("utf8"));
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function handleText(client, text) {
  const message = parseObject(text);
  if (!message) return;
  client.lastSeen = Date.now();
  if (!client.room) {
    if (message.type === "join") join(client, message);
    return;
  }
  const handler = HANDLERS.get(message.type);
  if (handler) handler(client, message);
}

function newRoom() {
  return {
    task: null,
    taskKind: "journal",
    peers: new Map(),
    slots: new Map(),
    studentCounter: 0,
    teacherCounter: 0,
    reports: [],
    expiry: null,
  };
}

function join(client, message) {
  if (typeof message.room !== "string" || message.room === "" || !ROLES.has(message.role)) return;
  const room = rooms.get(message.room) ?? newRoom();
  rooms.set(message.room, room);
  const seat = takeSeat(room, message);
  clearTimeout(room.expiry);
  client.id = seat.id;
  client.room = message.room;
  client.role = message.role;
  client.name = seat.name;
  client.machines = clean_machines(message.machines);
  const others = [...room.peers.values()];
  room.peers.set(client.id, client);
  sendMessage(client, {
    type: "joined",
    id: client.id,
    peers: others.map(describePeer),
    task: room.task,
    ...taskKindField(room.taskKind),
    resumed: seat.resumed,
    reports: isTeacher(client) ? room.reports : [],
  });
  broadcast(others, { type: "peer-joined", ...describePeer(client) });
}

// A student keeps the same id (and so the same 10.0.0.N in the guest) for the same key; after a server
// restart the page's own last id (message.slot) is claimed if nobody holds it.
function takeSeat(room, message) {
  const name = String(message.name ?? "");
  if (message.role === "teacher") return { id: `t${++room.teacherCounter}`, name, resumed: false };
  const key = typeof message.key === "string" && message.key.length <= KEY_MAX_CHARS ? message.key : "";
  const known = room.slots.get(key);
  if (known) {
    evict(room.peers.get(known.id));
    return { id: known.id, name: known.name, resumed: true };
  }
  const id = claimId(room, message.slot);
  if (key) room.slots.set(key, { id, name });
  return { id, name, resumed: false };
}

function claimId(room, wanted) {
  const match = SLOT_RE.exec(wanted ?? "");
  const held = [...room.slots.values()].some((slot) => slot.id === wanted) || room.peers.has(wanted);
  if (!match || held) return `p${++room.studentCounter}`;
  room.studentCounter = Math.max(room.studentCounter, Number(match[1]));
  return wanted;
}

// The same page opened twice (a duplicated tab copies sessionStorage) must not fight for the seat.
function evict(old) {
  if (!old) return;
  sendMessage(old, { type: "replaced" });
  closeClient(old);
}

function describePeer(peer) {
  const described = { id: peer.id, role: peer.role, name: peer.name };
  if (peer.machines) described.machines = peer.machines;
  return described;
}

// Optional fields are added only when set: messages without them stay as they were.
function optionalFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

function taskKindField(kind) {
  return kind === "journal" ? {} : { kind };
}

function leave(client) {
  if (!client.room) return;
  const roomName = client.room;
  const room = rooms.get(roomName);
  client.room = null;
  room.peers.delete(client.id);
  broadcast([...room.peers.values()], { type: "peer-left", id: client.id });
  if (room.peers.size === 0) room.expiry = setTimeout(() => expireRoom(roomName, room), ROOM_TTL_MS).unref();
}

function expireRoom(roomName, room) {
  if (room.peers.size === 0 && rooms.get(roomName) === room) rooms.delete(roomName);
}

function dropStaleClients() {
  const limit = Date.now() - STALE_MS;
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.pings && peer.lastSeen < limit) dropClient(peer);
    }
  }
}

function roomPeers(client) {
  return [...rooms.get(client.room).peers.values()];
}

function peerInRoom(client, id) {
  return rooms.get(client.room).peers.get(id);
}

function isTeacher(peer) {
  return peer.role === "teacher";
}

function isStudent(peer) {
  return peer.role === "student";
}

function relaySignal(client, message) {
  const target = peerInRoom(client, message.to);
  if (target) sendMessage(target, { type: "signal", from: client.id, data: message.data });
}

function relayFrame(client, message) {
  const target = peerInRoom(client, message.to);
  if (client.role === "student" && target?.role === "student") {
    sendMessage(target, { type: "frame", from: client.id, data: message.data });
  }
}

function relaySerial(client, message) {
  if (client.role !== "student") return;
  const serial = { type: "serial", from: client.id, data: message.data };
  Object.assign(serial, optionalFields({ machine: clean_machine(message.machine) }));
  if (message.full === true) serial.full = true;
  broadcast(roomPeers(client).filter(isTeacher), serial);
}

function relayInput(client, message) {
  const target = peerInRoom(client, message.to);
  if (client.role === "teacher" && target?.role === "student") {
    sendMessage(target, {
      type: "input",
      from: client.id,
      data: message.data,
      ...optionalFields({ machine: clean_machine(message.machine) }),
    });
  }
}

function setTask(client, message) {
  if (client.role !== "teacher") return;
  const room = rooms.get(client.room);
  room.task = message.journal_id ?? null;
  room.taskKind = room.task === null ? "journal" : clean_task_kind(message.kind);
  broadcast(roomPeers(client).filter(isStudent), {
    type: "task",
    from: client.id,
    journal_id: room.task,
    ...taskKindField(room.taskKind),
  });
}

function relayReport(client, message) {
  if (client.role !== "student") return;
  const room = rooms.get(client.room);
  const ref = typeof message.ref === "string" ? message.ref.slice(0, KEY_MAX_CHARS) : null;
  if (ref) sendMessage(client, { type: "report-ack", ref });
  if (ref && room.reports.some((report) => report.ref === ref)) return;
  const report = {
    from: client.id,
    name: client.name,
    kind: REPORT_KINDS.has(message.kind) ? message.kind : "problem",
    journal_id: message.journal_id,
    note: message.note,
    ref,
    at: Date.now(),
    ...optionalFields({ machine: clean_machine(message.machine), group: clean_group(message.group) }),
  };
  room.reports.push(report);
  if (room.reports.length > MAX_REPORTS) room.reports.shift();
  broadcast(roomPeers(client).filter(isTeacher), { type: "report", ...report });
}

function answerPing(client) {
  client.pings = true;
  sendMessage(client, { type: "pong" });
}

const HANDLERS = new Map([
  ["signal", relaySignal],
  ["frame", relayFrame],
  ["serial", relaySerial],
  ["input", relayInput],
  ["task", setTask],
  ["report", relayReport],
  ["ping", answerPing],
]);

function broadcast(peers, message) {
  for (const peer of peers) sendMessage(peer, message);
}

function sendMessage(client, message) {
  sendFrame(client, OP_TEXT, Buffer.from(JSON.stringify(message)));
}

function sendFrame(client, opcode, payload) {
  if (!client.closed) client.socket.write(encodeFrame(opcode, payload));
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < SHORT_LENGTH_LIMIT) {
    header = Buffer.from([FIN_BIT | opcode, length]);
  } else if (length <= MAX_16_BIT_LENGTH) {
    header = Buffer.alloc(4);
    header[0] = FIN_BIT | opcode;
    header[1] = LENGTH_16_MARK;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = FIN_BIT | opcode;
    header[1] = LENGTH_64_MARK;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closeClient(client) {
  if (client.closed) return;
  client.closed = true;
  leave(client);
  client.socket.end(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
}

function dropClient(client) {
  client.closed = true;
  leave(client);
  client.socket.destroy();
}

function main() {
  const port = Number(process.argv[2] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Bad port: ${process.argv[2]}`);
    process.exitCode = 1;
    return;
  }
  start_server(port)
    .then(() => console.log(`http://localhost:${port}/app/lab.html`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
