// Deterministic v86 machine: record (live) and replay of a journal of inputs.
// Machine time = executed instructions at a journaled rate + idle clock ("warp").
// Every input reaches the guest only at a slice boundary identified by
// (instruction count, idle clock); the journal stores those pairs.
// Importing this module replaces realm globals (Math.random, Date, crypto,
// WebAssembly.instantiate), so a realm (Worker, Node process) runs one machine.
// Works in Node and in a Worker: no Node API, no DOM.
import "./v86_release.mjs";
import { v86, V86 } from "../../v86det/src/main.js";
import { Virtio9p } from "../../v86det/lib/9p.js";
import { WASM_TABLE_OFFSET } from "../../v86det/src/const.js";
import { CHUNK, chunk_hashes, digest_of_hashes, hash_bytes } from "./digest.mjs";
import { host_nan } from "./host_nan.mjs";
import { MAX_INSTR_PER_MS, MIN_INSTR_PER_MS, START_INSTR_PER_MS } from "./journal.mjs";

// While live, the rate follows the emulator's real speed so that the guest
// clock stays close to the wall clock under load (QEMU -icount shift=auto).
const RATE_WINDOW_MS = 100;
const MAX_RATE_STEP = 2;
const MIN_IDLE_STEP_MS = 0.1;
// Browser timers are coarse; a lower threshold journals a clock jump on
// almost every idle tick.
const CATCH_UP_MS = 20;
const STATUS_EVERY_MS = 100;
// While the core waits for an image file or a 9p reply, a status with `waiting` goes out once per this interval.
const WAIT_STATUS_EVERY_MS = 1000;
const WAIT_TICK = Symbol("wait_tick");
const REPLAY_SLEEP_CHUNK_MS = 200;
const HOST_RNG_SALT = 0x5bd1e995;
const IMAGE_READ_TIMEOUT_MS = 60000;
// Value of the `m` field of a `check` recorded after restoring from a mid-journal snapshot: the rest of memory is not
// compared there.
export const NO_REST_DIGEST = "0000000000000000";

function step(st) {
    let a = st.a | 0; a = a + 0x6D2B79F5 | 0; st.a = a;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

const S = {
    emulator: null, mode: "replay", paused: false, ended: false, on_journal_end: "pause",
    log: [], next: 0, base: 0, wraps: 0, last: 0, warp: 0, epoch: 0,
    // Instruction time = ms + (instructions - at) / per_ms since the last change.
    rate: { at: 0, ms: 0, per_ms: START_INSTR_PER_MS },
    tick_end: null, busy_c: 0, busy_ms: 0, busy_instr: 0,
    recorded_nan: null, check_every_ms: 0, check_requests: [], last_check_at: null, checks_seen: 0, last_check_event: -1,
    snap_every_ms: 0, last_snap_v: 0, snap_requests: [], event_snaps: [], sent: new Set(),
    // Guest stream (RDRAND, /dev/urandom seeding) and host stream (Math.random:
    // MAC address and other v86 internals) are both part of a snapshot.
    rng: { a: 1 }, host_rng: { a: 1 },
    pending: new Set(), jit_modules: new Map(), net_receive: null,
    serial_queue: [], net_queue: [], out: [[], [], []],
    real0: null, v0: 0, speed: 1, skip_step: false, run_target: null, run_done: null, wake: null,
    last_status: 0, handlers: {}, image_failure: null, image_timeout_ms: IMAGE_READ_TIMEOUT_MS,
};

const emit = (name, value) => { const fn = S.handlers[name]; if(fn) fn(value); };

// Addresses of v86's own views of the counter and the HLT flag, taken once.
// The views are Proxies that build a new typed array on every access (v86det/src/lib.js, `view`), so they do
// not detach when restore grows wasm memory; keeping the addresses only makes the reads here independent of that.
let counter_addr = 0, hlt_addr = 0;
function capture_addresses(cpu) {
    counter_addr = cpu.instruction_counter.byteOffset;
    hlt_addr = cpu.in_hlt.byteOffset;
    if(!counter_addr || !hlt_addr) throw new Error("v86 layout changed: instruction_counter / in_hlt views not found");
}

function raw_instructions() {
    if(!S.emulator || !S.emulator.v86) return 0;
    const cpu = S.emulator.v86.cpu;
    if(!counter_addr) capture_addresses(cpu);
    const now = new Uint32Array(cpu.wasm_memory.buffer, counter_addr, 1)[0];
    if(now < S.last) S.wraps++;
    S.last = now;
    return S.wraps * 2 ** 32 + now;
}
const total_instructions = () => S.base + raw_instructions();
const instruction_time = () => S.rate.ms + (total_instructions() - S.rate.at) / S.rate.per_ms;
const vtime = () => instruction_time() + S.warp;
function set_rate(per_ms) {
    S.rate = { at: total_instructions(), ms: instruction_time(), per_ms };
}
function halted() {
    const cpu = S.emulator.v86.cpu;
    if(!hlt_addr) capture_addresses(cpu);
    return new Uint8Array(cpu.wasm_memory.buffer, hlt_addr, 1)[0] !== 0;
}

Math.random = () => step(S.host_rng);
globalThis.crypto.getRandomValues = arr => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for(let i = 0; i < bytes.length; i++) bytes[i] = step(S.rng) * 256 | 0;
    return arr;
};
v86.microtick = vtime;
// `new Date()` without arguments reads the host clock directly (9p file times
// use it), so the constructor is replaced too, not just Date.now.
const HostDate = Date;
const guest_now = () => S.epoch + Math.floor(vtime());
globalThis.Date = class extends HostDate {
    constructor(...args) { if(args.length === 0) super(guest_now()); else super(...args); }
    static now() { return guest_now(); }
};

// Async work the guest can observe (JIT modules, 9p reads) must land at the
// same point of execution in every run, so the emulator waits for it.
// then(done, done) rather than finally: finally returns a new promise that would stay unhandled if p rejects, and in
// Node 22 that would end the process. The microtask order is the same: the handler is registered before v86's .then and
// Promise.allSettled in yield.
function track(p) {
    S.pending.add(p);
    const done = () => { S.pending.delete(p); };
    p.then(done, done);
    return p;
}
// JIT modules are built synchronously (Node and Worker allow it for any size; v86det has the same path behind
// SYNC_COMPILATION = false): async instantiate takes seconds under load (8-17 s with 8 runs in parallel) and its
// completion order against 9p replies is up to the host. The result is a settled promise, tracked like before so
// that .then(codegen_finalize_finished) still runs before the next slice, but it is not a wait (see waiting()).
const instantiate = WebAssembly.instantiate;
const settled_jit = new WeakSet();
WebAssembly.instantiate = (code, imports) => {
    if(!(code instanceof ArrayBuffer || ArrayBuffer.isView(code))) return track(instantiate(code, imports));
    let built;
    try {
        const module = new WebAssembly.Module(code);
        built = { module, instance: new WebAssembly.Instance(module, imports) };
    }
    catch(e) {
        return track(instantiate(code, imports));
    }
    const p = Promise.resolve(built);
    settled_jit.add(p);
    return track(p);
};
// True if the guest has to wait for something that takes host time (a 9p read, an image file), not just for
// a promise that is already settled.
function waiting() {
    for(const p of S.pending) if(!settled_jit.has(p)) return true;
    return false;
}
// The 9p handler awaits before it even starts reading a file, so the whole
// request is tracked. Requests run one at a time in arrival order: in parallel
// their replies would reach the guest in whatever order the host finished.
const receive_9p = Virtio9p.prototype.ReceiveRequest;
let queue_9p = Promise.resolve();
Virtio9p.prototype.ReceiveRequest = function(...args) {
    const p = queue_9p.then(() => receive_9p.apply(this, args));
    queue_9p = p.catch(() => {});
    return track(p);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// An image file that could not be read in replay (the recording had it): without the network the replay is impossible.
const image_failure_note = () => S.image_failure ? `; ${S.image_failure}` : "";
function watch_image_read(read, timeout_ms) {
    return (sha, ...rest) => {
        const watched = Promise.race([
            read(sha, ...rest),
            sleep(timeout_ms).then(() => { throw new Error(`немає відповіді за ${timeout_ms / 1000} с`); }),
        ]);
        return track(watched.catch(error => {
            if(S.mode === "replay") {
                S.image_failure ??= `не вдалося завантажити файл образу ${sha}: ${error.message || error}; повтор неможливий без мережі`;
            }
            throw error;
        }));
    };
}
const set_immediate = (() => {
    if(typeof setImmediate === "function") return setImmediate;
    // No 4 ms clamp, unlike setTimeout(fn, 0).
    const channel = new MessageChannel();
    const queue = [];
    channel.port1.onmessage = () => queue.shift()();
    return fn => { queue.push(fn); channel.port2.postMessage(0); };
})();

const to_base64 = bytes => { let s = ""; for(const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const from_base64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

export function ram_digest() {
    const cpu = S.emulator.v86.cpu;
    return digest_of_hashes(chunk_hashes(new Uint8Array(cpu.wasm_memory.buffer, cpu.mem8.byteOffset, cpu.mem8.length)));
}

// All of wasm memory except guest RAM: CPU registers (xmm included), JIT tables, device state kept in wasm memory.
// Together with ram_digest it covers the whole memory image that goes into a snapshot.
export function state_digest() {
    const cpu = S.emulator.v86.cpu;
    const memory = new Uint8Array(cpu.wasm_memory.buffer);
    const ram_start = cpu.mem8.byteOffset;
    const ram_end = ram_start + cpu.mem8.length;
    // current_tsc is a buffer that get_state fills when a snapshot is taken; the guest never reads it,
    // and in a run without snapshots it differs, so it is left out of the hash.
    const scratch = new Uint8Array(memory.buffer, cpu.current_tsc.byteOffset, cpu.current_tsc.byteLength);
    const saved = scratch.slice();
    scratch.fill(0);
    try {
        return digest_of_hashes([...chunk_hashes(memory.subarray(0, ram_start)), ...chunk_hashes(memory.subarray(ram_end))]);
    } finally {
        scratch.set(saved);
    }
}

// v86 queues charCodeAt() of each character into the UART as is; a code above
// 0xFF breaks its port assert, so the line discipline gets UTF-8 bytes.
const utf8 = new TextEncoder();
function send_serial(text, port = 0) {
    for(const byte of utf8.encode(text)) S.emulator.bus.send(`serial${port}-input`, byte);
}

function record_event(ev) {
    S.log.push({ c: total_instructions(), w: S.warp, ...ev });
}

// A diverged replay on a host whose NaN sign differs from the recording's is not necessarily a corrupted journal.
function architecture_note() {
    const here = host_nan();
    if(!S.recorded_nan || S.recorded_nan === here) return "";
    return `; запис зроблено на іншій архітектурі процесора (NaN хоста: запис ${S.recorded_nan}, тут ${here}); на цій архітектурі повтор може не збігатися`;
}

function check_state(ev, index) {
    S.checks_seen++;
    const ram = ram_digest();
    const rest = S.compare_rest && ev.m !== NO_REST_DIGEST ? state_digest() : ev.m;
    if(ram === ev.h && rest === ev.m) { S.last_check_event = index; return; }
    const between = S.log.slice(S.last_check_event + 1, index).map((e, k) => `${S.last_check_event + 1 + k}:${e.t}`);
    const where = ram !== ev.h ? `RAM гостя: хеш ${ram} != ${ev.h}` : `решта пам'яті wasm (регістри, стан пристроїв): хеш ${rest} != ${ev.m}`;
    throw new Error(`розбіжність стану між перевіркою #${S.checks_seen - 1} (подія ${S.last_check_event}) і #${S.checks_seen} (подія ${index}); події між ними: ${between.join(" ") || "немає"}; ${where}${architecture_note()}${image_failure_note()}`);
}

function apply_events() {
    const c = total_instructions();
    while(S.next < S.log.length) {
        const ev = S.log[S.next];
        if(ev.c > c || (ev.c === c && ev.w > S.warp)) return;
        if(ev.c !== c || ev.w !== S.warp) throw new Error(`розбіжність: подія ${S.next} на ${ev.c}/${ev.w}, зараз ${c}/${S.warp}${architecture_note()}`);
        const index = S.next++;
        if(ev.t === "clock") S.warp += ev.extra;
        else if(ev.t === "rate") set_rate(ev.per_ms);
        else if(ev.t === "serial") send_serial(ev.data, ev.p ?? 0);
        else if(ev.t === "net") S.net_receive(from_base64(ev.data));
        else if(ev.t === "check") check_state(ev, index);
    }
    finish_journal();
}

function finish_journal() {
    if(S.ended) return;
    S.ended = true;
    if(S.on_journal_end === "live") go_live();
    else S.paused = true;
    finish_run_until();
    emit("end", { vtime: vtime(), events: S.log.length });
}

// Rate = instructions really executed per wall-clock ms while the guest is
// busy (time spent in yield itself, JIT waits and hashing excluded).
function adjust_rate(idle, entered) {
    const c = total_instructions();
    if(S.tick_end !== null && !idle) {
        S.busy_ms += entered - S.tick_end;
        S.busy_instr += c - S.busy_c;
    }
    S.busy_c = c;
    if(S.busy_ms < RATE_WINDOW_MS) return;
    const measured = S.busy_instr / S.busy_ms;
    S.busy_ms = 0; S.busy_instr = 0;
    const limited = Math.min(S.rate.per_ms * MAX_RATE_STEP, Math.max(S.rate.per_ms / MAX_RATE_STEP, measured));
    const per_ms = Math.round(Math.min(MAX_INSTR_PER_MS, Math.max(MIN_INSTR_PER_MS, limited)));
    if(per_ms === S.rate.per_ms) return;
    record_event({ t: "rate", per_ms });
    set_rate(per_ms);
}

async function live_tick(idle, entered) {
    if(S.real0 === null) { S.real0 = performance.now(); S.v0 = vtime(); }
    const lag = (performance.now() - S.real0) - (vtime() - S.v0);
    if(idle && lag > CATCH_UP_MS) {
        // Fell behind the wall clock: jump while idle and journal the jump,
        // since its size depends on the host.
        const extra = Math.floor(lag);
        record_event({ t: "clock", extra });
        S.warp += extra;
    }
    else if(lag < -1) {
        await sleep(-lag);
    }
    adjust_rate(idle, entered);
    // Order of events within a slice: input in arrival order (all ports together), then network frames, then check.
    for(const { data, by, port } of S.serial_queue.splice(0)) {
        record_event({ t: "serial", data, ...(port ? { p: port } : {}), ...(by ? { by } : {}) });
        send_serial(data, port);
    }
    for(const frame of S.net_queue.splice(0)) {
        record_event({ t: "net", data: to_base64(frame) });
        S.net_receive(frame);
    }
    const now = performance.now();
    if(S.last_check_at === null) S.last_check_at = now;
    const requests = S.check_requests.splice(0);
    if(requests.length || (S.check_every_ms && now - S.last_check_at >= S.check_every_ms)) {
        S.last_check_at = now;
        record_event({ t: "check", h: ram_digest(), m: S.compare_rest ? state_digest() : NO_REST_DIGEST });
        for(const { pause, resolve } of requests) {
            if(pause) S.paused = true;
            resolve(S.log.length - 1);
        }
    }
}

async function replay_tick() {
    apply_events();
    if(S.run_target !== null) {
        if(vtime() >= S.run_target) { S.paused = true; finish_run_until(); }
        return;
    }
    if(S.real0 === null || S.speed === 0) { S.real0 = performance.now(); S.v0 = vtime(); return; }
    await pace_replay();
}

// A clock jump in the recording (a laptop asleep) makes a 1x replay sleep for as much real time. The sleep goes in
// pieces so that pause, a speed change, a run_until target and the switch to live mode do not wait for it to end. Guest
// time stands still during the sleep, so determinism is unaffected.
async function pace_replay() {
    for(;;) {
        const ahead = (vtime() - S.v0) / S.speed - (performance.now() - S.real0);
        if(ahead <= 1) return;
        await sleep(Math.min(ahead, REPLAY_SLEEP_CHUNK_MS));
        if(S.paused || S.run_target !== null || S.mode !== "replay" || S.speed === 0 || S.real0 === null) return;
    }
}

function finish_run_until() {
    if(!S.run_done) return;
    const done = S.run_done;
    S.run_target = null; S.run_done = null;
    done(vtime());
}

async function wait_while_paused() {
    if(!S.paused) return;
    emit_status(true);
    while(S.paused) await new Promise(r => { S.wake = r; });
    S.real0 = null;
    S.tick_end = null;
}

function emit_status(force) {
    const now = performance.now();
    if(!force && now - S.last_status < STATUS_EVERY_MS) return;
    S.last_status = now;
    emit("status", status());
}

// Port output is not journaled: ttyS0 goes out as the "serial" event, ttyS1 (system channel) and ttyS2 (teacher
// terminal) as "serial1" and "serial2".
function flush_output() {
    S.out.forEach((bytes, port) => {
        if(!bytes.length) return;
        emit(port === 0 ? "serial" : `serial${port}`, Uint8Array.from(bytes));
        bytes.length = 0;
    });
}

function step_for(t, idle, waited) {
    const step = waited ? 0 : t;
    return idle ? Math.max(step, MIN_IDLE_STEP_MS) : step;
}

// Waiting for the host (image file, 9p reply) can take minutes, and all that time the core sends nothing out. Once a
// second it sends a status with `waiting`, so the page can tell waiting from a hang. Only state reads and an event
// here: no S.warp, no queues, no tracked promises.
async function settle_pending_announcing() {
    const settled = Promise.allSettled([...S.pending]);
    for(;;) {
        let timer;
        const tick = new Promise(resolve => { timer = setTimeout(resolve, WAIT_STATUS_EVERY_MS, WAIT_TICK); });
        const first = await Promise.race([settled, tick]);
        clearTimeout(timer);
        if(first !== WAIT_TICK) return;
        emit("status", { ...status(), waiting: true });
    }
}

v86.prototype.yield = async function(t, tick) {
    // v86 marks the CPU idle before yielding so that an interrupt raised
    // meanwhile (a 9p reply landing while we await pending work, a delivered
    // event) restarts the loop at once via stop_idling -> next_tick: a second,
    // nested yield whose position depends on host timing. Not idle = the CPU
    // takes such an interrupt in the next regular slice.
    this.idle = false;
    const entered = performance.now();
    // Host time spent waiting is not machine time: in virtual time a 9p reply arrives at once. Otherwise every
    // request would cost a halted guest up to one PIT period (about 10 ms; about 0.6 s per command in study with
    // its 58 requests per exec), and in live mode the user pays it too. S.pending at this point depends only on
    // the slice that just ran: tracked promises are created by the guest's slice (9p requests, JIT modules) and by
    // our own awaiting below, never by the host, so record and replay take the same branch.
    const waited = waiting();
    while(S.pending.size) {
        if(waited) await settle_pending_announcing();
        else await Promise.allSettled([...S.pending]);
    }
    const ready = S.emulator && S.emulator.v86;
    try {
        if(S.image_failure && S.mode === "replay") throw new Error(S.image_failure);
        if(ready) await wait_while_paused();
        const idle = ready && halted();
        // A due timer whose IRQ the guest masked keeps returning t = 0; without
        // a minimum step the clock never moves and a halted CPU never wakes.
        // v86.run() yields once before the first slice; after a restore that
        // yield is not part of the recorded run, so it must not move the clock.
        if(ready && S.skip_step) S.skip_step = false;
        else S.warp += step_for(t, idle, waited);
        if(ready) {
            if(S.mode === "live") await live_tick(idle, entered);
            else await replay_tick();
            release_event_snapshots();
            if(S.snap_requests.length || (S.snap_every_ms && vtime() - S.last_snap_v >= S.snap_every_ms)) await serve_snapshots();
            flush_output();
            emit_status(false);
        }
    }
    catch(e) {
        S.paused = true;
        emit("error", e.message || String(e));
        return;
    }
    S.tick_end = performance.now();
    set_immediate(() => this.yield_callback(tick));
};

// Test hook (app/test/engine_boundary.node.mjs): a snapshot in the slice where event `index` has just been applied
// (replay) or recorded (live mode); requests come in increasing index order.
function release_event_snapshots() {
    const reached = S.mode === "live" ? S.log.length : S.next;
    while(S.event_snaps.length && reached > S.event_snaps[0].index) S.snap_requests.push(S.event_snaps.shift().resolve);
}

async function serve_snapshots() {
    const snap = await take_snapshot();
    S.last_snap_v = snap.clock.vtime;
    const requests = S.snap_requests.splice(0);
    if(!requests.length) emit("snapshot", snap);
    for(const resolve of requests) resolve(snap);
}

// Guest RAM goes in the full wasm memory image; v86's own packed copy in
// save_state would only double the size, so it is replaced by an empty one.
async function take_snapshot() {
    const cpu = S.emulator.v86.cpu;
    const pack = cpu.pack_memory;
    const pages = cpu.mem8.length >> 12;
    cpu.pack_memory = () => ({ bitmap: { get_buffer: () => new ArrayBuffer(Math.ceil(pages / 8)) }, packed_memory: new Uint8Array(0) });
    let state;
    try { state = await S.emulator.save_state(); }
    finally { cpu.pack_memory = pack; }
    const mem = new Uint8Array(cpu.wasm_memory.buffer);
    const seen = new Set();
    const ref = bytes => blob_ref(bytes, seen);
    const chunks = [];
    for(let at = 0; at < mem.length; at += CHUNK) chunks.push(ref(mem.subarray(at, at + CHUNK)));
    const jit = [...S.jit_modules].map(([index, code]) => [index, ...ref(code)]);
    S.sent = seen;
    const clock = {
        base: S.base, wraps: S.wraps, last: S.last, warp: S.warp, rate: { ...S.rate }, epoch: S.epoch,
        rng: S.rng.a, host_rng: S.host_rng.a, vtime: vtime(), ram: ram_digest(), rest: state_digest(),
        // In live mode S.next stays put while the events are already in the journal: a replay from such a snapshot
        // starts at the end of the journal.
        next: S.mode === "live" ? S.log.length : S.next,
        // The live branch does not lie on the teacher's recording: a lesson never uses such snapshots as a start point
        // for someone else's events.
        live: S.mode === "live",
    };
    return { clock, state, mem_size: mem.length, chunks, jit };
}

// [hash, null] if the receiver already has the bytes: they were in the previous
// snapshot (or the start snapshot) or earlier in this one. Older hashes are
// sent again, so the receiver may drop blobs of thinned-out snapshots.
function blob_ref(bytes, seen) {
    const h = hash_bytes(bytes);
    const known = S.sent.has(h) || seen.has(h);
    seen.add(h);
    return [h, known ? null : bytes.slice()];
}

function hook_devices() {
    const cpu = S.emulator.v86.cpu;
    const finalize = cpu.codegen_finalize.bind(cpu);
    cpu.codegen_finalize = (index, start, flags, ptr, len) => {
        S.jit_modules.set(index, new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, len >>> 0).slice());
        return finalize(index, start, flags, ptr, len);
    };
    const clear = cpu.jit_clear_func.bind(cpu);
    cpu.jit_clear_func = index => { S.jit_modules.delete(index); return clear(index); };
    const clear_all = cpu.jit_clear_all_funcs.bind(cpu);
    cpu.jit_clear_all_funcs = () => { S.jit_modules.clear(); return clear_all(); };

    const nic = cpu.devices.net;
    if(nic) {
        S.net_receive = nic.receive.bind(nic);
        // Frames reach the guest only through the journal.
        nic.receive = () => {};
        S.emulator.add_listener("net0-send", frame => { if(S.mode === "live") emit("net_out", frame.slice()); });
    }
    const fs9p = S.emulator.fs9p;
    if(fs9p && fs9p.storage) {
        const read = fs9p.storage.read.bind(fs9p.storage);
        fs9p.storage.read = S.mode === "replay" ? watch_image_read(read, S.image_timeout_ms) : (...args) => track(read(...args));
    }
    S.out.forEach((bytes, port) => S.emulator.add_listener(`serial${port}-output-byte`, b => bytes.push(b)));
}

// snapshot: {clock, state: ArrayBuffer, mem: Uint8Array (whole wasm memory), jit: [[index, Uint8Array]]}
function restore_memory(snapshot) {
    const cpu = S.emulator.v86.cpu;
    const { clock, mem, jit } = snapshot;
    if(cpu.wasm_memory.buffer.byteLength < mem.length) {
        cpu.wasm_memory.grow((mem.length - cpu.wasm_memory.buffer.byteLength) / 65536);
    }
    new Uint8Array(cpu.wasm_memory.buffer).set(mem);
    S.jit_modules.clear();
    for(const [index, code] of jit) {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(code), { "e": cpu.jit_imports });
        cpu.wm.wasm_table.set(index + WASM_TABLE_OFFSET, instance.exports["f"]);
        S.jit_modules.set(index, code);
    }
    S.base = clock.base; S.wraps = clock.wraps; S.last = clock.last;
    // Creating the emulator has already taken numbers from the host stream (the network card's MAC).
    S.rng.a = clock.rng; S.host_rng.a = clock.host_rng;
}

function apply_clock(clock) {
    // Devices read the clock while v86 restores its own state, before the
    // memory image with the real counter is written back.
    S.base = clock.base + clock.wraps * 2 ** 32 + clock.last;
    S.warp = clock.warp;
    S.rate = { ...clock.rate };
    S.epoch = clock.epoch;
    S.rng.a = clock.rng;
    S.host_rng.a = clock.host_rng;
    S.last_snap_v = clock.vtime;
}

function status() {
    return {
        mode: S.mode, paused: S.paused, ended: S.ended, vtime: vtime(), next: S.next, total: S.log.length,
        per_ms: S.rate.per_ms, instructions: total_instructions(),
    };
}

function go_live() {
    if(S.mode === "live") return;
    S.mode = "live";
    S.ended = true;
    S.log.length = S.next;
    S.paused = false;
    S.real0 = null; S.tick_end = null; S.busy_ms = 0; S.busy_instr = 0; S.last_check_at = null;
    if(S.wake) S.wake();
}

let created = false;

// events: journal events to replay (replay starts at index `next`, live input
// is ignored until they run out). With a snapshot, epoch is ignored and seed is used only if `reseed` is set
// (a start from the boot snapshot): the guest stream then restarts from it instead of the snapshot's state.
export function create_machine({ config, seed = 1, epoch = HostDate.now(), events = [], next = 0, snapshot = null,
    on_journal_end = "pause", check_every_ms = 10000, snap_every_ms = 0, known_hashes = [], recorded_host_nan = null, reseed = false, image_timeout_ms = IMAGE_READ_TIMEOUT_MS }) {
    if(created) throw new Error("one machine per realm: engine.mjs patches globals");
    created = true;
    // The rest of wasm memory (m) is compared in a replay from the start in every profile, but not after restoring from
    // a mid-journal snapshot: the guest reads the 9p image files read during recording again, and decompressing them
    // (zstd) shifts the Rust heap. The RAM hash is always compared.
    const compare_rest = next === 0;
    Object.assign(S, { compare_rest, log: events, next, on_journal_end, check_every_ms, snap_every_ms, epoch, recorded_nan: recorded_host_nan, image_timeout_ms });
    S.rng.a = seed;
    S.host_rng.a = seed ^ HOST_RNG_SALT;
    S.sent = new Set(known_hashes);
    if(snapshot) { apply_clock(snapshot.clock); S.skip_step = true; }
    // Nothing to replay: live from the first slice, so early input is kept.
    if(on_journal_end === "live" && next >= events.length) { S.mode = "live"; S.ended = true; }
    const rate0 = { ...S.rate };
    S.emulator = new V86({
        ...config, log_level: 0, disable_keyboard: true, disable_mouse: true, autostart: false,
        // Without this, set_state of the network card restores neither its MAC nor its memory with received frames:
        // it keeps the ones the card was just created with.
        preserve_mac_from_state_image: true,
    });
    // The snapshot is restored into a cold-initialised emulator, not passed as
    // initial_state: v86 then skips loading the kernel, its allocations before
    // guest RAM differ, and RAM lands at another offset than in the snapshot.
    const ready = new Promise((resolve, reject) => S.emulator.add_listener("emulator-loaded", async () => {
        try {
            hook_devices();
            if(snapshot) {
                await S.emulator.restore_state(snapshot.state);
                restore_memory(snapshot);
                // The wasm memory image also restores Rust's static pointer to RAM, while the JS handlers (9p, virtio)
                // take RAM from cpu.mem8 at the offset the cold initialisation gave. If the offsets differ (the wasm
                // heap filled in another order), the guest runs but 9p reads zeros, and without a reply the guest
                // hangs. Better to fail at once.
                if(ram_digest() !== snapshot.clock.ram) throw new Error("ОЗУ гостя після відновлення не збігається зі знімком: зміщення ОЗУ в пам'яті wasm інше, ніж у знімку");
                // A session that starts from the boot snapshot gets its own seed (otherwise RDRAND is the same in every
                // session).
                if(reseed) S.rng.a = seed;
                // v86 bus handlers cannot be removed, and this closure lives as long as the Worker: without this the
                // snapshot (all of wasm memory) would stay in memory. The object's fields are left alone, it belongs to
                // the caller.
                snapshot = null;
            }
            S.emulator.run();
            resolve();
        }
        catch(e) { reject(e); }
    }));
    return {
        ready, rate0, events: S.log,
        on: (name, fn) => { S.handlers[name] = fn; },
        type: (data, by, port = 0) => { if(S.mode === "live") S.serial_queue.push({ data, by, port }); },
        net_in: frame => { if(S.mode === "live") S.net_queue.push(new Uint8Array(frame)); },
        set_speed: x => { S.speed = x; S.real0 = null; },
        pause: () => { S.paused = true; },
        resume: () => { if(S.mode === "replay" && S.ended) return; S.paused = false; if(S.wake) S.wake(); },
        go_live,
        run_until: target => new Promise(resolve => {
            if(S.mode !== "replay" || S.ended) { resolve(vtime()); return; }
            S.run_target = target; S.run_done = resolve;
            S.paused = false;
            if(S.wake) S.wake();
        }),
        snapshot: () => new Promise(resolve => {
            S.snap_requests.push(resolve);
            // A paused machine still has to reach a yield to take it.
            if(S.paused) { const was = S.mode; S.paused = false; if(S.wake) S.wake(); S.snap_requests.push(() => { if(S.mode === was) S.paused = true; }); }
        }),
        // The emulator is waiting for async work (JIT module compilation, a 9p read) and is not running the guest.
        stalled: () => S.pending.size > 0,
        snapshot_after_event: index => new Promise(resolve => { S.event_snaps.push({ index, resolve }); }),
        // Resolves with the index of the recorded `check` event. With `pause` the machine stops in the same tick,
        // so that `check` stays the last journal event until it is woken. A paused machine is woken for one tick
        // (as in snapshot()) and stopped again.
        check: ({ pause = false } = {}) => new Promise((resolve, reject) => {
            if(S.mode !== "live") { reject(new Error("Перевірку не можна записати: машина не в живому режимі, журнал лише читається")); return; }
            const was_paused = S.paused;
            S.check_requests.push({ pause: pause || was_paused, resolve });
            if(was_paused) { S.paused = false; if(S.wake) S.wake(); }
        }),
        status, ram_digest, state_digest, vtime,
        instructions: total_instructions,
    };
}
