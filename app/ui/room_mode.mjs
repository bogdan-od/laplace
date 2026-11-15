import { Room } from "../net/room.mjs";
import { Mesh } from "../net/mesh.mjs";
import { to_base64 } from "../net/base64.mjs";
import { $, report_errors, show_error } from "./common.mjs";
import { show_room_state } from "./room_state.mjs";

const FLUSH_MS = 100;
const HISTORY_BYTES = 64 * 1024;
const TYPING_MS = 1500;
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63]);
// Network parameters from the teacher's page (relay address, WebRTC, STUN) carry over to the task page.
const CARRIED_PARAMS = ["relay", "rtc", "stun"];

// Mirror of the machine output for the teacher: batches on a timer, the latest history for a full replay after a drop.
// tag is added to every "serial" (a topology passes {machine: id}); state.room is set by whoever creates the Room.
export function mirror_serial(machine, tag = {}) {
    const state = { room: null, tag, sent_at: 0, pending: [], history: new Uint8Array(0) };
    machine.on("serial", bytes => {
        state.pending.push(bytes);
        // The browser slows the timers of a background tab to once a second, so setInterval is not relied on.
        if(performance.now() - state.sent_at >= FLUSH_MS) flush_serial(state);
    });
    // ESC c resets the teacher's terminal; then the machine again sends the output left after the rollback.
    machine.on("reset", () => {
        state.pending = [TERMINAL_RESET];
        state.history = new Uint8Array(0);
        flush_serial(state);
    });
    setInterval(() => flush_serial(state), FLUSH_MS);
    return state;
}

export async function join_room(machine, options) {
    const state = mirror_serial(machine);
    const room = new Room({ room: options.room_name, role: "student", name: options.name });
    state.room = room;
    show_room_state(room, $("bar"));
    room.on("joined", () => on_joined(machine, state, options));
    room.on("peer-joined", msg => msg.role === "teacher" && send_history(state));
    room.on("input", msg => type_teacher_input(machine, msg.data));
    room.on("task", msg => show_task(msg.journal_id, options, msg.kind));
    room.connect();
    return room;
}

// Mesh right after joining: Room does not keep signals without a subscriber, and a neighbour sends an offer as soon as
// we join.
// After a drop: the same id and the same address in the guest; Mesh restores the links to neighbours itself.
function on_joined(machine, state, options) {
    const { room } = state;
    if(state.id !== undefined) return rejoined(state, options);
    state.id = room.id;
    const mesh = new Mesh(room, machine);
    options.router.attach_mesh(mesh);
    send_history(state);
    show_task(room.task, options, room.task_kind);
    report_errors(() => options.network.start(options.ready, { id: room.id, mesh }));
}

function rejoined(state, options) {
    const { room } = state;
    if(room.id !== state.id) show_error(`Кімната: номер змінився з ${state.id} на ${room.id}, адреса гостя застаріла, перезавантажте сторінку`);
    send_history(state);
    if(room.task) show_task(room.task, options, room.task_kind);
}

function take_output(state) {
    const chunk = concat_bytes(state.pending.splice(0));
    state.history = tail_bytes(concat_bytes([state.history, chunk]), HISTORY_BYTES);
    return chunk;
}

function flush_serial(state) {
    const chunk = take_output(state);
    if(chunk.length === 0 || !state.room.is_open) return;
    state.room.send({ type: "serial", ...state.tag, data: to_base64(chunk) });
    state.sent_at = performance.now();
}

// The whole output history: the teacher replaces the tile content with it, so a replay after a drop does not duplicate
// text.
export function send_history(state) {
    take_output(state);
    state.room.send({ type: "serial", ...state.tag, data: to_base64(state.history), full: true });
}

export function type_teacher_input(machine, data) {
    machine.type(data, "teacher");
    $("note").textContent = "Викладач друкує";
    setTimeout(() => { if($("note").textContent === "Викладач друкує") $("note").textContent = ""; }, TYPING_MS);
}

// kind "topology": journal_id is a topology description, "Почати" opens the topology page; otherwise it is a journal
// for lab.html.
export function show_task(journal_id, options, kind = "journal") {
    if(!journal_id) return $("task").replaceChildren();
    const button = document.createElement("button");
    button.textContent = "Почати";
    button.onclick = () => { location.href = task_url(journal_id, options, kind); };
    $("task").replaceChildren("Викладач роздав завдання ", button);
}

function task_url(journal_id, options, kind) {
    const query = new URLSearchParams({ room: options.room_name, name: options.name });
    if(kind === "topology") query.set("topology_url", `/journals/${journal_id}`);
    else {
        query.set("task", `/journals/${journal_id}`);
        query.set("profile", options.profile);
    }
    const current = new URLSearchParams(location.search);
    for(const key of CARRIED_PARAMS) if(current.has(key)) query.set(key, current.get(key));
    return `${kind === "topology" ? "topology.html" : "lab.html"}?${query}`;
}

function concat_bytes(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for(const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function tail_bytes(bytes, limit) {
    return bytes.length > limit ? bytes.slice(bytes.length - limit) : bytes;
}
