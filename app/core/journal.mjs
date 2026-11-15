import { hash_text } from "./digest.mjs";
import { MAX_FRAME_LEN, MIN_FRAME_LEN } from "../net/frame.mjs";
import { HOST_NAN_SIGNS } from "./host_nan.mjs";

export const FORMAT = "v86-replay/9";
const OLD_FORMATS = ["v86-replay/7", "v86-replay/8"];
// Serial input ports: 0 is the student console, 1 is the system channel (the agent in the guest), 2 is the teacher
// terminal.
export const SERIAL_PORTS = [0, 1, 2];
export const START_INSTR_PER_MS = 300000;
export const MIN_INSTR_PER_MS = 10000;
export const MAX_INSTR_PER_MS = 4000000;

// Limits of the strict check. Format /8 journals from the tests (16 of them, all four profiles) stay far below them: up
// to 873 events, c up to 8.4e9 (≈5 min of guest time), w up to 2.8e5 ms, extra up to 8.8e3 ms, serial up to 106
// characters. These journals have no frames (network without neighbours); older /7 journals with frames up to 1410
// bytes passed too. The caller can replace any value.
export const JOURNAL_LIMITS = {
    max_events: 500_000,
    max_instructions: 1e13,
    max_warp_ms: 1e8,
    max_extra_ms: 30 * 86_400_000, // a laptop that slept makes the live machine write a clock jump of days
    max_serial_chars: 1 << 20,
};

const CHECK_HASH_RE = /^[0-9a-f]{16}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_GROUP_CHARS = 4;
const BASE64_GROUP_BYTES = 3;
const MAX_NET_CHARS = BASE64_GROUP_CHARS * Math.ceil(MAX_FRAME_LEN / BASE64_GROUP_BYTES);

const EVENT_FIELDS = [["c", "number"], ["w", "number"], ["t", "string"]];
const LINE_ENDS = ["\r", "\n"];
const BACKSPACE_KEYS = ["\x7f", "\b"];
const CANCEL_KEYS = ["\x03", "\x15"];
const CONTROL_KEYS = new Map([["\x01", "H"], ["\x05", "F"]]);
const ESC = "\x1b";
const FIRST_PRINTABLE = 0x20;
const CSI_PARAM_MAX = 0x3f;
const CSI_FINAL_MAX = 0x7e;

export function read_journal(json) {
    const format = json?.header?.format;
    if(OLD_FORMATS.includes(format)) throw new Error(`Журнал старого формату ${format}: запишіть сесію заново (потрібен ${FORMAT})`);
    if(format !== FORMAT) throw new Error(`Журнал іншого формату: ${format}, потрібен ${FORMAT}`);
    if(!Array.isArray(json.events)) throw new Error("Журнал: поле events має бути масивом");
    json.events.forEach(check_event);
    if(!Number.isSafeInteger(json.header.seed)) throw new Error("Журнал: header.seed має бути цілим числом (зерно випадковості сесії)");
    if(json.header.lesson !== undefined) check_lesson(json.header.lesson, json.events.length);
    const { host_nan } = json.header;
    if(host_nan !== undefined && !HOST_NAN_SIGNS.includes(host_nan)) {
        throw new Error(`Журнал: header.host_nan має бути ${HOST_NAN_SIGNS.map(sign => JSON.stringify(sign)).join(" або ")}`);
    }
    return json;
}

// header.lesson: notes {t:"note", at, text} and segments {t:"self", from, to, text}; indexes are event numbers.
export function check_lesson(lesson, total) {
    if(!Array.isArray(lesson)) throw new Error("Урок: header.lesson має бути масивом");
    const index = value => Number.isInteger(value) && value >= 0 && value <= total;
    for(const item of lesson) {
        if(typeof item?.text !== "string") throw new Error("Урок: немає тексту");
        if(item.t === "note" && index(item.at)) continue;
        if(item.t === "self" && index(item.from) && index(item.to) && item.from < item.to) continue;
        throw new Error(`Урок: некоректний запис ${JSON.stringify(item)}`);
    }
    const selfs = lesson.filter(item => item.t === "self").sort((a, b) => a.from - b.from);
    if(selfs.some((item, i) => i > 0 && item.from < selfs[i - 1].to)) throw new Error("Урок: відрізки «тепер сам» перетинаються");
}

// Strict journal check before replaying someone else's recording (read_journal neither replaces it nor changes): fields
// by event type, value bounds, order, sizes. An error names the event number.
export function check_journal_strict(json, limits = {}) {
    const max = { ...JOURNAL_LIMITS, ...limits };
    read_journal(json);
    check_rate0(json.header.rate0);
    const { events } = json;
    if(events.length > max.max_events) throw new Error(`Журнал: подій ${events.length}, ліміт ${max.max_events}`);
    events.forEach((ev, index) => {
        check_event_strict(ev, index, max);
        if(index > 0) check_order(events[index - 1], ev, index);
    });
    return json;
}

const STRICT_CHECKS = {
    serial: (ev, index, max) => {
        if(typeof ev.data !== "string" || ev.data.length > max.max_serial_chars) throw bad(index, ev, "data - рядок до ліміту розміру");
        if(ev.by !== undefined && typeof ev.by !== "string") throw bad(index, ev, "by - рядок");
        if(ev.p !== undefined && !SERIAL_PORTS.includes(ev.p)) throw bad(index, ev, `p - порт ${SERIAL_PORTS.join(", ")}`);
    },
    net: (ev, index) => {
        if(typeof ev.data !== "string" || ev.data.length > MAX_NET_CHARS || !BASE64_RE.test(ev.data)) throw bad(index, ev, "data - base64 кадру");
        const padding = ev.data.endsWith("==") ? 2 : ev.data.endsWith("=") ? 1 : 0;
        const length = ev.data.length / BASE64_GROUP_CHARS * BASE64_GROUP_BYTES - padding;
        if(length < MIN_FRAME_LEN || length > MAX_FRAME_LEN) throw bad(index, ev, `кадр ${length} байт, потрібно ${MIN_FRAME_LEN}..${MAX_FRAME_LEN}`);
    },
    clock: (ev, index, max) => check_range(ev, "extra", where_of(index, ev), 0, max.max_extra_ms),
    rate: (ev, index) => check_range(ev, "per_ms", where_of(index, ev), MIN_INSTR_PER_MS, MAX_INSTR_PER_MS),
    check: (ev, index) => {
        for(const key of ["h", "m"]) {
            if(typeof ev[key] !== "string" || !CHECK_HASH_RE.test(ev[key])) throw bad(index, ev, `${key} - 16 шістнадцяткових цифр`);
        }
    },
};

const where_of = (index, ev) => `Подія ${index} (${ev.t})`;
const bad = (index, ev, text) => new Error(`${where_of(index, ev)}: ${text}`);

function check_range(source, key, where, min, max) {
    const value = source[key];
    if(!Number.isFinite(value) || value < min || value > max) throw new Error(`${where}: ${key} = ${value} поза межами ${min}..${max}`);
}

function check_event_strict(ev, index, max) {
    if(!Object.hasOwn(STRICT_CHECKS, ev.t)) throw new Error(`Подія ${index}: невідомий тип ${JSON.stringify(ev.t)}`);
    if(!Number.isSafeInteger(ev.c) || ev.c < 0 || ev.c > max.max_instructions) throw bad(index, ev, `c = ${ev.c} поза межами 0..${max.max_instructions}`);
    check_range(ev, "w", where_of(index, ev), 0, max.max_warp_ms);
    STRICT_CHECKS[ev.t](ev, index, max);
}

function check_order(prev, ev, index) {
    if(ev.c < prev.c || (ev.c === prev.c && ev.w < prev.w)) {
        throw bad(index, ev, `порядок порушено: ${prev.c}/${prev.w} -> ${ev.c}/${ev.w}`);
    }
}

function check_rate0(rate0) {
    if(rate0 === undefined || rate0 === null) return; // Machine.header_now() before the first Worker start
    for(const key of ["at", "ms"]) check_range(rate0, key, "Заголовок rate0", 0, Number.MAX_SAFE_INTEGER);
    check_range(rate0, "per_ms", "Заголовок rate0", MIN_INSTR_PER_MS, MAX_INSTR_PER_MS);
}

function check_event(ev, index) {
    for(const [key, kind] of EVENT_FIELDS) {
        if(typeof ev?.[key] !== kind) throw new Error(`Подія ${index}: немає поля ${key}`);
    }
}

export function event_times(journal) {
    const times = new Float64Array(journal.events.length);
    let rate = journal.header.rate0 ?? { at: 0, ms: 0, per_ms: START_INSTR_PER_MS };
    journal.events.forEach((ev, index) => {
        times[index] = rate.ms + (ev.c - rate.at) / rate.per_ms + ev.w;
        if(ev.t === "rate") rate = next_rate(rate, ev);
    });
    return times;
}

function next_rate(rate, ev) {
    return { at: ev.c, ms: rate.ms + (ev.c - rate.at) / rate.per_ms, per_ms: ev.per_ms };
}

export function duration_ms(journal) {
    const times = event_times(journal);
    return times.length ? times[times.length - 1] : 0;
}

// Commands from console input (port 0) and the teacher terminal (port 2, by "teacher"); system channel requests (port
// 1) are not shell commands. The line is tracked separately per port and author, the arrow-key history per port (it is
// one shell).
export function commands(events) {
    const lines = new Map();
    const histories = new Map();
    const found = [];
    events.forEach((ev, index) => {
        if(ev.t !== "serial" || ev.p === 1) return;
        const by = ev.by ?? "student";
        const key = `${ev.p ?? 0}:${by}`;
        if(!lines.has(key)) lines.set(key, new_line());
        const port = ev.p ?? 0;
        if(!histories.has(port)) histories.set(port, []);
        const where = { index, by, port, found, history: histories.get(port) };
        for(const ch of ev.data) feed(lines.get(key), ch, where);
    });
    return found;
}

function new_line() {
    return { chars: [], cursor: 0, uncertain: false, esc: null, hist: null, start: null };
}

function feed(line, ch, where) {
    line.start ??= where.index;
    if(line.esc) return feed_escape(line, ch, where);
    const code = ch.codePointAt(0);
    if(ch === ESC) line.esc = { stage: "start", params: "" };
    else if(LINE_ENDS.includes(ch)) submit(line, where);
    else if(BACKSPACE_KEYS.includes(ch)) backspace(line);
    else if(CANCEL_KEYS.includes(ch)) clear(line);
    else if(CONTROL_KEYS.has(ch)) run_key(line, CONTROL_KEYS.get(ch), where);
    else if(ch === "\t") line.uncertain = true;
    else if(code >= FIRST_PRINTABLE) insert(line, ch);
}

function feed_escape(line, ch, where) {
    if(line.esc.stage === "start") return start_escape(line, ch, where);
    if(line.esc.stage === "ss3") return ss3_final(line, ch, where);
    return csi_byte(line, ch, where);
}

function start_escape(line, ch, where) {
    if(ch === "[") { line.esc.stage = "csi"; return; }
    if(ch === "O") { line.esc.stage = "ss3"; return; }
    if(is_seq_byte(ch)) { line.esc = null; line.uncertain = true; return; }
    cancel_escape(line, ch, where);
}

function ss3_final(line, ch, where) {
    if(!is_seq_byte(ch)) return cancel_escape(line, ch, where);
    line.esc = null;
    run_key(line, ch, where);
}

function csi_byte(line, ch, where) {
    if(!is_seq_byte(ch)) return cancel_escape(line, ch, where);
    if(ch.codePointAt(0) <= CSI_PARAM_MAX) { line.esc.params += ch; return; }
    const name = line.esc.params + ch;
    line.esc = null;
    run_key(line, name, where);
}

function is_seq_byte(ch) {
    const code = ch.codePointAt(0);
    return code >= FIRST_PRINTABLE && code <= CSI_FINAL_MAX;
}

function cancel_escape(line, ch, where) {
    line.esc = null;
    line.uncertain = true;
    feed(line, ch, where);
}

const KEY_ACTIONS = new Map([
    ["D", move_left], ["C", move_right], ["H", move_home], ["1~", move_home],
    ["F", move_end], ["4~", move_end], ["3~", delete_under],
    ["A", history_older], ["B", history_newer],
]);

function run_key(line, name, where) {
    const action = KEY_ACTIONS.get(name);
    if(!action) { line.uncertain = true; return; }
    action(line, where);
}

function move_left(line) {
    line.cursor = Math.max(0, line.cursor - 1);
}

function move_right(line) {
    line.cursor = Math.min(line.chars.length, line.cursor + 1);
}

function move_home(line) {
    line.cursor = 0;
}

function move_end(line) {
    line.cursor = line.chars.length;
}

function delete_under(line) {
    line.chars.splice(line.cursor, 1);
}

function backspace(line) {
    if(line.cursor === 0) return;
    line.chars.splice(line.cursor - 1, 1);
    line.cursor -= 1;
}

function insert(line, ch) {
    line.chars.splice(line.cursor, 0, ch);
    line.cursor += 1;
}

function history_older(line, where) {
    const older = line.hist === null ? where.history.length - 1 : line.hist - 1;
    if(older < 0) { line.uncertain = true; return; }
    show_history(line, where.history, older);
}

function history_newer(line, where) {
    if(line.hist === null) return;
    const newer = line.hist + 1;
    if(newer < where.history.length) return show_history(line, where.history, newer);
    line.hist = null;
    line.chars = [];
    line.cursor = 0;
}

function show_history(line, history, index) {
    line.hist = index;
    line.chars = Array.from(history[index]);
    line.cursor = line.chars.length;
}

function submit(line, where) {
    const raw = line.chars.join("");
    const text = raw.trim();
    if(text) {
        where.found.push({ text, index: where.index, start: line.start, by: where.by, port: where.port, uncertain: line.uncertain });
        if(where.history.at(-1) !== raw) where.history.push(raw);
    }
    clear(line);
}

function clear(line) {
    line.chars = [];
    line.cursor = 0;
    line.uncertain = false;
    line.hist = null;
    line.start = null;
}

export function journal_digest(journal) {
    return hash_text(JSON.stringify(journal.events));
}
