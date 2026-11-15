import { Room } from "../net/room.mjs";
import { from_base64 } from "../net/base64.mjs";
import { validate_topology } from "../net/topology.mjs";
import { $, report_errors } from "./common.mjs";
import { show_room_state } from "./room_state.mjs";

const TILE_COLS = 80;
const TILE_ROWS = 24;
const TILE_FONT_SIZE = 7;
const BIG_COLS = 110;
const BIG_ROWS = 30;
const HISTORY_BYTES = 256 * 1024;
const TEACHER_NAME = "викладач";
const STUDENT = "student";
const TEACHER = "teacher";
const ESCAPE_KEY = "Escape";
const TOPOLOGY_FORMAT_PREFIX = "v86-topology/";

const students = new Map();
const shown_reports = new Set();
let room = null;
let big = null;
let current_task = null;
let current_kind = "journal";

report_errors(start_teacher);

async function start_teacher() {
    const room_name = new URLSearchParams(location.search).get("room");
    if(!room_name) return show_login();
    $("login").hidden = true;
    $("room_view").hidden = false;
    $("link").value = `${location.origin}/app/lab.html?room=${encodeURIComponent(room_name)}&name=`;
    room = new Room({ room: room_name, role: TEACHER, name: TEACHER_NAME });
    show_room_state(room, $("room_view"));
    wire_room();
    await room.connect();
}

// First join and every one after a drop or a server restart: tiles, reports and tasks from the server state.
function on_joined() {
    for(const [id, peer] of room.peers) if(peer.role === STUDENT) revive_student(id, peer);
    for(const student of students.values()) if(!room.peers.has(student.id)) mark_gone(student);
    for(const report of room.reports) if(!shown_reports.has(report_key(report))) on_report(report);
    if(room.task) {
        current_task = room.task;
        current_kind = room.task_kind;
    }
    if(current_task && room.task !== current_task) send_task_message();
    if(current_task) $("task_status").textContent = `Роздано: ${$("task_file").files[0]?.name ?? current_task}`;
}

function show_login() {
    $("login_button").onclick = () => report_errors(enter_room);
}

async function enter_room() {
    const room_name = $("login_room").value.trim();
    if(!room_name) throw new Error("Введіть назву кімнати");
    location.search = new URLSearchParams({ room: room_name }).toString();
}

function wire_room() {
    room.on("joined", on_joined);
    room.on("peer-joined", msg => { if(msg.role === STUDENT) revive_student(msg.id, msg); });
    room.on("peer-left", msg => mark_gone_all(msg.id));
    room.on("serial", on_serial);
    room.on("report", on_report);
    $("task_send").onclick = () => report_errors(send_task);
    $("copy").onclick = () => report_errors(copy_link);
    $("big_close").onclick = close_big;
    document.addEventListener("keydown", event => {
        if(event.key === ESCAPE_KEY && big && !$("big_term").contains(event.target)) close_big();
    });
}

// One tile per (student, machine) pair: key `${id}/${machine}`. A student without a machine list has one tile keyed by
// id.
const tile_key = (id, machine) => machine ? `${id}/${machine}` : id;

function ensure_tile(id, name, machine) {
    const key = tile_key(id, machine);
    if(students.has(key)) return students.get(key);
    const student = make_student(id, name, machine);
    students.set(key, student);
    $("grid").append(student.element);
    return student;
}

function make_student(id, name, machine) {
    const element = document.createElement("div");
    element.className = "tile";
    const label = document.createElement("div");
    label.className = "label";
    const title = machine ? `${name || id} / ${machine}` : name || id;
    label.textContent = title;
    const screen = document.createElement("div");
    element.append(label, screen);
    const term = new Terminal({ cols: TILE_COLS, rows: TILE_ROWS, fontSize: TILE_FONT_SIZE, convertEol: false });
    term.open(screen);
    const key = tile_key(id, machine);
    element.onclick = () => open_big(key);
    return { key, id, machine, name: name || id, title, element, label, term, chunks: [], size: 0 };
}

// A student joined (or came back): a tile for each of their machines, or one without a machines list.
// Old-form tiles of the same id (the student moved from lab.html to the topology page and back) are removed.
function revive_student(id, peer) {
    const keys = new Set((peer.machines ?? [undefined]).map(machine => tile_key(id, machine)));
    for(const [key, student] of students) if(student.id === id && !keys.has(key)) remove_tile(key, student);
    for(const machine of peer.machines ?? [undefined]) {
        const student = ensure_tile(id, peer.name, machine);
        student.element.classList.remove("gone");
        student.label.textContent = student.title;
    }
}

function remove_tile(key, student) {
    if(big?.key === key) close_big();
    student.term.dispose();
    student.element.remove();
    students.delete(key);
}

function mark_gone_all(id) {
    for(const student of students.values()) if(student.id === id) mark_gone(student);
}

function mark_gone(student) {
    student.element.classList.add("gone");
    student.label.textContent = `${student.title}: вийшов`;
}

function on_serial(msg) {
    const student = ensure_tile(msg.from, room.peers.get(msg.from)?.name, msg.machine);
    const bytes = from_base64(msg.data);
    if(msg.full) reset_history(student);
    student.term.write(bytes);
    append_history(student, bytes);
    if(big?.key === student.key) big.term.write(bytes);
}

// The student sent the whole output history (after a drop or the teacher joining): it replaces what was there.
function reset_history(student) {
    student.term.reset();
    student.chunks = [];
    student.size = 0;
    if(big?.key === student.key) big.term.reset();
}

function append_history(student, bytes) {
    student.chunks.push(bytes);
    student.size += bytes.length;
    while(student.size > HISTORY_BYTES) {
        const excess = student.size - HISTORY_BYTES;
        const first = student.chunks[0];
        if(first.length <= excess) {
            student.chunks.shift();
            student.size -= first.length;
        } else {
            student.chunks[0] = first.subarray(excess);
            student.size -= excess;
        }
    }
}

function history_bytes(student) {
    const out = new Uint8Array(student.size);
    let offset = 0;
    for(const chunk of student.chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function open_big(key) {
    const student = students.get(key);
    if(!student) return;
    student.element.classList.remove("alert");
    close_big();
    $("big_title").textContent = student.machine
        ? `Ви друкуєте в машині ${student.machine} студента ${student.name}`
        : `Ви друкуєте в машині студента ${student.name}`;
    $("big").hidden = false;
    const term = new Terminal({ cols: BIG_COLS, rows: BIG_ROWS, convertEol: false });
    term.open($("big_term"));
    term.write(history_bytes(student));
    const target = student.machine ? { to: student.id, machine: student.machine } : { to: student.id };
    term.onData(data => room.send({ type: "input", ...target, data }));
    big = { key, term };
    term.focus();
}

function close_big() {
    if(!big) return;
    big.term.dispose();
    big = null;
    $("big_term").replaceChildren();
    $("big").hidden = true;
}

function report_key(msg) {
    return `${msg.from}:${msg.kind}:${msg.journal_id}`;
}

function on_report(msg) {
    shown_reports.add(report_key(msg));
    const student = ensure_tile(msg.from, msg.name, msg.machine);
    student.element.classList.add("alert");
    $(msg.kind === "submit" ? "submits" : "reports").prepend(report_item(msg));
}

function report_item(msg) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `player.html?j=/journals/${encodeURIComponent(msg.journal_id)}`;
    link.target = "_blank";
    link.textContent = `${msg.machine ? `${msg.name} / ${msg.machine}` : msg.name}, ${new Date(msg.at ?? Date.now()).toLocaleTimeString("uk-UA")}`;
    item.append(link);
    if(msg.group) item.dataset.group = msg.group;
    if(msg.machine) item.dataset.machine = msg.machine;
    if(msg.note) item.append(` ${msg.note}`);
    return item;
}

function send_task_message() {
    room.send({ type: "task", journal_id: current_task, ...(current_kind === "journal" ? {} : { kind: current_kind }) });
}

// A file with a format field "v86-topology/…" is a topology description, students open it with the topology page;
// any other JSON is stored by the server as a journal.
async function send_task() {
    const file = $("task_file").files[0];
    if(!file) throw new Error("Оберіть файл журналу");
    const text = await file.text();
    const kind = task_kind_of(text);
    const journal_id = await upload_journal(text);
    current_task = journal_id;
    current_kind = kind;
    send_task_message();
    $("task_status").textContent = `Роздано: ${file.name}`;
}

function task_kind_of(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        if(!(error instanceof SyntaxError)) throw error;
        return "journal";
    }
    if(typeof parsed?.format !== "string" || !parsed.format.startsWith(TOPOLOGY_FORMAT_PREFIX)) return "journal";
    const problems = validate_topology(parsed);
    if(problems.length > 0) throw new Error(`Опис топології містить помилки: ${problems.join("; ")}`);
    return "topology";
}

async function upload_journal(text) {
    const response = await fetch("/journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
    });
    if(!response.ok) throw new Error(`Журнал не прийнято (${response.status})`);
    return (await response.json()).id;
}

async function copy_link() {
    await navigator.clipboard.writeText($("link").value);
}
