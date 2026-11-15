// Main thread: drives one machine in a Worker, its snapshots and seeking.
import { CHUNK, chunk_hashes } from "../core/digest.mjs";
import { FORMAT, duration_ms, event_times, journal_digest } from "../core/journal.mjs";
import { host_nan } from "../core/host_nan.mjs";
import { AgentChannel } from "./agent_channel.mjs";
import { materialize, read_snapshot } from "../core/snapfile.mjs";
import { PROFILES, SESSION_ENTROPY_BYTES, boot_snapshot_path, fresh_session_input, session_command } from "../profiles.mjs";

const SEEK_REUSE_MS = 5000;
// How long to wait for the agent's answer to a system command (real time). The student may have killed the agent.
const SYSTEM_TIMEOUT_MS = 10000;
// The Worker is silent longer than this while not paused: the emulator is waiting for a JIT module to compile (5-10 s
// per ~130 KB module under load), the guest is not running, and waiting for the agent is pointless. A real failure is
// caught by check_silence.
const STALL_SILENCE_MS = 1000;
// Network setup may wait up to ~12 s for DHCP.
const SETUP_TIMEOUT_MS = 30000;
const SESSION_SEED_MAX = 2 ** 30;
const PORT_AGENT = 1;
const PORT_TEACHER = 2;

const SPEED_MAX = 0;
// A live Worker sends a status ~10 times a second; a longer silence means the emulator stopped without a message.
const SILENCE_MS = 15000;
const SILENCE_CHECK_MS = 1000;
// A second failure sooner than this after a recovery counts as a failure in a row.
const RECOVERY_STABLE_MS = 30000;
// The number of snapshots does not bound memory: Alpine under load produces tens of MB of new chunks per snapshot, and
// 60 snapshots took ~1.9 GB (the Firefox tab crashed). All chunks are counted, those of the boot snapshot too.
export const SNAPSHOT_BYTES_MAX = 384 * 2 ** 20;
// Output of a live machine (yes, a build, cat of a big file) does not grow without limit: the server drops messages
// over 16 MB, and after a rollback the whole log goes to the teacher in one message. Replay output is not capped (the
// player needs it).
const SERIAL_LOG_BYTES_MAX = 4 * 2 ** 20;
// Evict with a margin so the array is not cut after every batch.
const SERIAL_LOG_BYTES_KEEP = SERIAL_LOG_BYTES_MAX * 3 / 4;

const concat_bytes = parts => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.data.length, 0));
    let at = 0;
    for(const { data } of parts) { out.set(data, at); at += data.length; }
    return out;
};

// state is {hashes, size}: the device state cut into chunks in this.bytes.
const strip_bytes = (snap, state) => ({
    clock: snap.clock, state, mem_size: snap.mem_size,
    chunks: snap.chunks.map(([h]) => [h, null]),
    jit: snap.jit.map(([index, h]) => [index, h, null]),
});

const record_hashes = ({ snap }) => [...snap.chunks.map(([h]) => h), ...snap.jit.map(([, h]) => h), ...snap.state.hashes];

const join_chunks = ({ hashes, size }, lookup) => {
    const out = new Uint8Array(size);
    hashes.forEach((h, i) => out.set(lookup(h), i * CHUNK));
    return out.buffer;
};

const insert_record = (list, record) =>
    [...list.filter(r => r.vtime !== record.vtime), record].sort((a, b) => a.vtime - b.vtime);

// The boot snapshot (number zero) is always kept: it is first in the list.
const thin_records = (list, limit) => {
    if(list.length <= limit) return list;
    const last = list.length - 1;
    return list.filter((_, i) => i === 0 || i === last || i % 2 === 0);
};

// The snapshot whose neighbours are closest in time: without it the history stays most even. The ends are never
// dropped.
const crowded_index = list => {
    const gap = i => list[i + 1].vtime - list[i - 1].vtime;
    let best = 1;
    for(let i = 2; i < list.length - 1; i++) if(gap(i) < gap(best)) best = i;
    return best;
};

const latest_before = (records, vtime) => records.filter(r => r.vtime <= vtime).pop() ?? null;

export class Machine {
    constructor({ profile, root, journal = null, on_journal_end = "pause", snap_every_ms = 0, check_every_ms = 10000, name, MAX_SNAPSHOTS = 60, max_bytes = SNAPSHOT_BYTES_MAX, timeline_only = false, auto_recover = true, silence_ms = SILENCE_MS }) {
        Object.assign(this, { profile, root, source: journal, on_journal_end, snap_every_ms, check_every_ms, name, MAX_SNAPSHOTS, max_bytes, timeline_only, auto_recover, silence_ms });
        this.duration_ms = journal ? duration_ms(journal) : 0;
        this.events = journal ? journal.events : [];
        this.live = journal === null;
        this.listeners = new Map();
        this.pending = new Map();
        this.seq = 0;
        this.seek_seq = 0;
        this.bytes = new Map();
        this.snaps = [];
        this.log = [];
        this.log_bytes = 0;
        this.status_now = null;
        this.worker = null;
        this.boot = null;
        this.live_from = null;
        this.speed = null;
        this.early_paused = null;
        // The page set the pause (button, seek); the Worker status is no good for this: it lags by up to 100 ms.
        this.user_paused = false;
        this.start_record = null;
        this.worker_last = null;
        this.early_input = [];
        this.stopped = false;
        this.session_rate0 = null;
        this.end_resolve = null;
        // Copy of the Worker journal on the main thread: the Worker sends new events with its status, so after a crash
        // there is something to restore the machine from, and the page can save the journal without asking the Worker.
        this.mirror = [];
        this.resyncing = false;
        this.last_heard = 0;
        this.last_watch = null;
        this.silence_timer = null;
        this.recovering = false;
        this.last_recovery = null;
        this.last_failure = null;
        this.failed = false;
        // The core is not running and will not be restored: the Worker thread is alive, but requests to it stay
        // unanswered.
        this.dead = false;
        this.agent = new AgentChannel(text => this.type(text, "system", PORT_AGENT), { stalled: () => this.worker_stalled() });
        // Random seed of a new session (a session from a journal takes the journal's seed).
        this.session_seed = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % SESSION_SEED_MAX);
        this.started = new Promise((resolve, reject) => { this.started_settle = { resolve, reject }; });
        this.started.catch(() => {});
    }

    get status() { return this.status_now; }
    get snapshots() { return this.snaps.map(({ vtime, next }) => ({ vtime, next })); }

    on(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
    emit(name, value) { for(const fn of this.listeners.get(name) ?? []) fn(value); }

    async start() {
        try {
            const source = this.source;
            this.profile_name = source ? source.header.profile : this.profile;
            this.abs = new URL(this.root, location.href).href;
            if(!source || source.header.start) await this.load_boot(source?.header.start);
            const record = this.boot;
            if(record) this.snaps = [record];
            this.silence_timer ??= setInterval(() => this.check_silence(), SILENCE_CHECK_MS);
            const reply = await this.spawn({ snapshot: record ? this.snapshot_of(record) : null, next: record?.next ?? 0, record });
            this.started_settle.resolve();
            return reply;
        }
        catch(error) {
            // Without this system() and run_setup() would wait for started forever.
            this.started_settle.reject(error);
            throw error;
        }
    }

    // The boot snapshot is kept only as chunks in this.bytes: the assembled memory (171 MB for Alpine) is needed only
    // when a Worker starts.
    async load_boot(start_info) {
        const snap = await this.fetch_boot();
        if(start_info && start_info.digest !== snap.clock.ram)
            throw new Error("Знімок завантаження не той, з якого записано журнал");
        for(const [h, b] of snap.chunks) this.bytes.set(h, b);
        for(const [, h, b] of snap.jit) this.bytes.set(h, b);
        // `next` of the boot snapshot is the index of the journal event it was taken at (12 in net, 834 in study);
        // a journal that starts from it is replayed from the first event.
        this.boot = { vtime: snap.clock.vtime, next: 0, snap: strip_bytes(snap, this.keep_state(snap.state)) };
    }

    // Device state (Alpine: ≈10 MB, 8 MB of it video memory, plus the full contents of files written to 9p) belongs to
    // each
    // snapshot; kept whole, it was multiplied by the number of snapshots and escaped the limit.
    keep_state(buffer) {
        const bytes = new Uint8Array(buffer);
        const hashes = chunk_hashes(bytes);
        hashes.forEach((h, i) => { if(!this.bytes.has(h)) this.bytes.set(h, bytes.slice(i * CHUNK, (i + 1) * CHUNK)); });
        return { hashes, size: bytes.length };
    }

    async fetch_boot() {
        const res = await fetch(boot_snapshot_path(this.abs, this.profile_name));
        if(!res.ok) throw new Error(`не вдалося завантажити знімок: ${res.status}`);
        return read_snapshot(new Uint8Array(await res.arrayBuffer()));
    }

    // mem and state are assembled anew and can be handed to the Worker; jit is shared with this.bytes, so it is copied.
    snapshot_of(record) {
        const lookup = h => this.bytes.get(h);
        const full = materialize(record.snap, lookup);
        return {
            clock: full.clock, state: join_chunks(record.snap.state, lookup), mem: full.mem,
            jit: full.jit.map(([index, bytes]) => [index, bytes.slice()]),
        };
    }

    // end: what to do at the end of the journal; by default the machine decides (the boundary for restarting a live
    // machine is set by rewind).
    start_params(snapshot, next, end = this.source ? this.on_journal_end : "live") {
        const source = this.source;
        return {
            config: PROFILES[this.profile_name].config(this.abs),
            seed: source?.header.seed ?? this.session_seed, epoch: source?.header.epoch,
            reseed: snapshot !== null && this.start_record === this.boot,
            events: this.events, next, snapshot,
            on_journal_end: end,
            check_every_ms: this.check_every_ms, snap_every_ms: this.snap_every_ms,
            known_hashes: [...this.bytes.keys()],
            recorded_host_nan: source?.header.host_nan ?? null,
        };
    }

    async spawn({ snapshot, next, record, end }) {
        this.worker?.terminate();
        this.dead = false;
        this.reject_pending(new Error("Worker перезапущено"));
        this.agent.reject_all(new Error("Worker перезапущено"));
        this.start_record = record ?? null;
        this.worker_last = null;
        this.mirror = this.events.slice();
        this.last_heard = performance.now();
        const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
        this.worker = worker;
        // A message from a killed Worker may still sit in the main thread queue: it must not spoil the journal copy
        // or the status of the new one. Chromium 156 and Firefox 159 deliver nothing after terminate()
        // (app/test/browser/worker_terminate.mjs),
        // but the spec does not promise it.
        worker.onmessage = ({ data }) => { if(this.worker === worker) this.on_message(data); };
        worker.onerror = e => { if(this.worker === worker) this.fail(e.message || "помилка Worker"); };
        const transfer = snapshot ? [snapshot.state, snapshot.mem.buffer, ...snapshot.jit.map(([, b]) => b.buffer)] : [];
        const started = this.request("start", { params: this.start_params(snapshot, next, end) }, transfer);
        // Input that arrives before the Worker exists is not lost: it goes right after "start".
        for(const msg of this.early_input.splice(0)) this.worker.postMessage(msg);
        const reply = await started;
        this.session_rate0 ??= reply.rate0;
        this.status_now = reply.status;
        if(this.speed !== null) this.send("speed", { x: this.speed });
        if(this.early_paused !== null) this.send(this.early_paused ? "pause" : "resume");
        this.early_paused = null;
        return reply;
    }

    on_message(msg) {
        this.last_heard = performance.now();
        if(msg.log) this.absorb_log(msg.log);
        if(msg.id !== undefined) return this.settle(msg);
        if(msg.op === "serial") return this.on_serial(msg);
        if(msg.op === "serial1") return this.agent.feed(msg.data);
        if(msg.op === "serial2") return this.emit("teacher_output", msg.data);
        if(msg.op === "snapshot") return this.on_snapshot(msg.snap);
        if(msg.op === "status") return this.on_status(msg.status);
        if(msg.op === "end") return this.on_end(msg);
        if(msg.op === "error") return this.fail(msg.message);
        if(msg.op === "net_out") return this.emit("net_out", msg.frame);
    }

    on_end(msg) {
        this.end_resolve?.();
        this.end_resolve = null;
        // The end of a replay while restoring a live machine is not the end of the recording: pages do not know about
        // it.
        if(!this.recovering) this.emit("end", msg);
    }

    // A journal increment that starts past the end of the copy means the copy fell behind: take the Worker journal
    // whole.
    absorb_log({ from, events }) {
        if(from > this.mirror.length) { this.resync_mirror(from); return; }
        this.mirror.length = from;
        for(const event of events) this.mirror.push(event);
    }

    // The Worker's answer to "journal" comes after all increments sent earlier, so it already contains the missed ones.
    async resync_mirror(from) {
        if(this.resyncing || !this.worker) return;
        const worker = this.worker;
        console.warn(`Worker journal copy fell behind: increment from ${from}, copy has ${this.mirror.length}; taking the whole journal`);
        this.resyncing = true;
        try {
            const { events } = await this.request("journal");
            if(this.worker === worker) this.mirror = events;
        }
        catch(e) { console.warn(`Could not get the Worker journal: ${e.message}`); }
        finally { this.resyncing = false; }
    }

    // The core waits for the host (a status with waiting once a second) or is silent: either way the guest is not
    // running.
    worker_stalled() {
        if(this.worker === null || this.recovering || this.status_now?.paused) return false;
        return this.status_now?.waiting === true || performance.now() - this.last_heard > STALL_SILENCE_MS;
    }

    check_silence() {
        // The page itself slept (frozen tab, laptop sleep): the Worker's silence during that time means nothing.
        const now = performance.now();
        const slept = this.last_watch !== null && now - this.last_watch > 2 * SILENCE_CHECK_MS;
        this.last_watch = now;
        if(slept) { this.last_heard = now; return; }
        const status = this.status_now;
        if(!this.worker || this.recovering || this.failed || status?.mode !== "live" || status.paused) return;
        if(performance.now() - this.last_heard > this.silence_ms) this.fail(`Worker мовчить понад ${this.silence_ms / 1000} с`);
    }

    // After an error the core stands still, so requests in flight (run_until from seek) would never get an answer.
    // A live machine is restored from the last snapshot and the journal copy; a divergence during replay
    // (a determinism bug) and a second failure in a row are only shown.
    fail(message) {
        this.reject_pending(new Error(message));
        if(this.recovering) this.abort_recovery();
        else if(this.can_recover()) return this.recover(message);
        this.dead = true;
        this.emit("error", message);
    }

    can_recover() {
        return this.auto_recover && !this.stopped && !this.failed && this.status_now?.mode === "live";
    }

    abort_recovery() {
        this.recovering = false;
        this.end_resolve?.();
        this.end_resolve = null;
    }

    // An emulator crash is deterministic: the same error at the same journal position is not cured by replaying.
    give_up(message) {
        this.failed = true;
        this.dead = true;
        this.emit("error", message);
    }

    async recover(reason) {
        const at = this.mirror.length;
        const recent = this.last_recovery !== null && performance.now() - this.last_recovery < RECOVERY_STABLE_MS;
        const same = this.last_failure?.at === at && this.last_failure.reason === reason;
        this.last_failure = { at, reason };
        if(recent || same) return this.give_up(`Машина впала вдруге поспіль: ${reason}`);
        this.recovering = true;
        this.emit("recovering", reason);
        try { await this.rewind(this.mirror.slice()); }
        catch(e) {
            if(!this.recovering) return;
            this.abort_recovery();
            return this.give_up(e.message);
        }
        if(!this.recovering) return;
        this.recovering = false;
        this.last_recovery = performance.now();
        this.emit("recovered", { events: this.events.length });
    }

    settle(msg) {
        const waiter = this.pending.get(msg.id);
        if(!waiter) return;
        this.pending.delete(msg.id);
        if(msg.op === "error") waiter.reject(new Error(msg.message));
        else waiter.resolve(msg.value);
    }

    request(op, extra = {}, transfer = []) {
        if(this.dead) return Promise.reject(new Error("Машина зупинилась після збою, запит не виконується"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ op, id, ...extra }, transfer);
        });
    }

    reject_pending(error) {
        for(const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
    }

    // Control commands before start or after stop() are meaningless: the speed is remembered
    // and applied in spawn(), the pause is handled in set_paused(), the rest is dropped.
    send(op, extra = {}) { this.worker?.postMessage({ op, ...extra }); }

    on_serial({ data, vtime }) {
        this.log.push({ vtime, data });
        this.log_bytes += data.length;
        if(this.live && this.log_bytes > SERIAL_LOG_BYTES_MAX) this.evict_log();
        this.emit("serial", data);
    }

    // Old entries go whole: a batch may contain a terminal control sequence or a multibyte character.
    evict_log() {
        let drop = 0;
        while(drop < this.log.length - 1 && this.log_bytes > SERIAL_LOG_BYTES_KEEP) this.log_bytes -= this.log[drop++].data.length;
        this.log.splice(0, drop);
    }

    on_status(status) {
        this.status_now = status;
        if(status.mode === "live") this.live = true;
        this.emit("status", status);
    }

    on_snapshot(snap) {
        for(const [h, b] of snap.chunks) if(b) this.bytes.set(h, b);
        for(const [, h, b] of snap.jit) if(b) this.bytes.set(h, b);
        const record = { vtime: snap.clock.vtime, next: snap.clock.next, snap: strip_bytes(snap, this.keep_state(snap.state)) };
        // The bytes stay even for a dropped snapshot: the next Worker snapshot refers to them by hash.
        this.worker_last = record;
        // A live branch snapshot (clock.live) lies after the source's event `next` even without input: it does not fit
        // the source's timeline. After stopping at `stop`, student input is appended to the Worker journal too (next >
        // stop).
        const off_timeline = this.timeline_only && (snap.clock.live === true || record.next > this.events.length);
        if(!off_timeline) this.snaps = thin_records(insert_record(this.snaps, record), this.MAX_SNAPSHOTS);
        this.drop_unused_bytes();
        this.fit_bytes();
    }

    fit_bytes() {
        while(this.snaps.length > 2 && this.bytes_size() > this.max_bytes) {
            const drop = crowded_index(this.snaps);
            this.snaps = this.snaps.filter((_, i) => i !== drop);
            this.drop_unused_bytes();
        }
    }

    bytes_size() {
        let size = 0;
        for(const b of this.bytes.values()) size += b.byteLength;
        return size;
    }

    drop_unused_bytes() {
        const pinned = [this.worker_last, this.start_record, this.boot];
        const used = new Set([...this.snaps, ...pinned].filter(Boolean).flatMap(record_hashes));
        for(const h of this.bytes.keys()) if(!used.has(h)) this.bytes.delete(h);
    }

    // User input is not lost: before the Worker starts it waits in a queue. After stop() there is no machine.
    // port: 0 is the student console, 1 the system channel, 2 the teacher terminal.
    type(data, by, port = 0) {
        if(this.worker) this.send("type", { data, by, port });
        else if(!this.stopped) this.early_input.push({ op: "type", data, by, port });
    }

    // Input to the teacher terminal (ttyS2); journaled with by "teacher". Output arrives as the "teacher_output" event.
    teacher_input(data) { this.type(data, "teacher", PORT_TEACHER); }

    // A shell command in the guest through the system channel (ttyS1), without touching the student console. Returns
    // {rc, output}; without an agent answer within timeout_ms (the student may have killed it) it fails. Works only in
    // live mode:
    // in replay the agent's answers come from the guest itself, and there is nobody to run the command.
    async system(command, { timeout_ms = SYSTEM_TIMEOUT_MS } = {}) {
        await this.started;
        if(this.status_now?.mode !== "live") throw new Error("Системну команду не можна виконати: машина не в живому режимі, журнал тільки читається");
        return this.agent.request(command, timeout_ms);
    }

    // A session setup system command: a failure (silent agent) goes to the "error" event instead of getting lost in a
    // promise.
    run_setup(command, { timeout_ms = SETUP_TIMEOUT_MS } = {}) {
        return this.system(command, { timeout_ms }).catch(error => { this.emit("error", error.message); return null; });
    }

    // Start of a new live session: an empty line in the console (the prompt), the host date and the guest generator's
    // own seed
    // through the system channel. Machine lives on the main thread, so crypto here is the real one.
    begin_session() {
        this.type(fresh_session_input(), "system");
        return this.run_setup(session_command(Date.now(), crypto.getRandomValues(new Uint8Array(SESSION_ENTROPY_BYTES))));
    }

    // A network frame that arrives while the Worker is not ready is dropped, like one lost in the network.
    net_in(frame) { this.send("net_in", { frame }); }
    set_speed(x) { this.speed = x; this.send("speed", { x }); }
    pause() { this.set_paused(true); }
    resume() { this.set_paused(false); }
    // The boot snapshot loads before the first Worker is created (seconds for Alpine), while the Pause button in the
    // player
    // is already available: the last command waits for the start and is applied in spawn().
    set_paused(paused) {
        this.user_paused = paused;
        if(this.worker) this.send(paused ? "pause" : "resume");
        else if(!this.stopped) this.early_paused = paused;
    }
    // The promise resolves with the index of the recorded `check` event; `pause` leaves the machine paused, and then
    // `check` is the last journal event until the machine is woken. Before the Worker starts there is nowhere to
    // record: rejected.
    check({ pause = false } = {}) {
        if(!this.worker) return Promise.reject(new Error("Перевірку не можна записати: машину ще не запущено"));
        return this.request("check", { pause });
    }

    // Journal ending with a check. A machine that was paused stays paused.
    async checked_journal() {
        if(this.dead) return this.journal();
        const was_paused = this.user_paused;
        await this.check({ pause: true });
        try { return await this.journal(); }
        finally { if(!was_paused) this.resume(); }
    }

    async go_live() {
        // An unfinished seek must not reach the pause of a live machine (run_to and seek_to compare the counter).
        this.seek_seq++;
        await this.request("go_live");
        this.user_paused = false;
        this.live = true;
        if(this.source) this.live_from = (await this.request("journal")).events.length;
    }

    async seek(target) {
        if(this.live) throw new Error("Після go_live перемотка недоступна");
        const token = ++this.seek_seq;
        try { return await this.seek_to(target, token); }
        catch(e) { if(token === this.seek_seq) throw e; return null; }
    }

    async seek_to(target, token) {
        const current = this.status_now?.vtime ?? 0;
        const base = latest_before(this.snaps, target) ?? this.earliest_start();
        if(target >= current && (!base || base.vtime <= current + SEEK_REUSE_MS)) return this.run_to(target, token);
        this.emit("reset");
        await this.restart_at(base);
        if(token !== this.seek_seq) return null;
        return this.run_to(target, token);
    }

    // A journal recorded from the boot snapshot cannot start from zero: when the target
    // is earlier than any snapshot, start from the boot snapshot (the seek stops there).
    earliest_start() { return this.boot; }

    async restart_at(record, end) {
        const snapshot = record ? this.snapshot_of(record) : null;
        const reply = await this.spawn({ snapshot, next: record?.next ?? 0, record, end });
        this.log = this.log.filter(e => e.vtime <= (record?.vtime ?? 0));
        this.log_bytes = this.log.reduce((sum, e) => sum + e.data.length, 0);
        if(this.log.length) this.emit("serial", concat_bytes(this.log));
        return reply;
    }

    // Rollback of a live machine to the moment before event `index` of its journal. The journal after a rollback
    // is self-contained: events before `index` plus new ones, so it can be replayed, submitted and opened by link.
    async rollback(index) {
        if(!this.live) throw new Error("Відкат можливий лише в живій машині");
        const { events } = await this.worker_journal();
        if(!Number.isInteger(index) || index < 0 || index > events.length) throw new Error(`Відкат: немає події ${index}`);
        if(this.live_from !== null) this.live_from = Math.min(this.live_from, index);
        this.mirror.length = Math.min(this.mirror.length, index);
        this.emit("truncated", index);
        await this.rewind(events.slice(0, index));
    }

    // New live machine: a Worker from a snapshot no later than the end of `events`, a fast replay to the end, then
    // live.
    async rewind(events) {
        this.events = events;
        this.snaps = this.snaps.filter(record => record.next <= events.length);
        const base = this.snaps.at(-1) ?? this.earliest_start();
        this.speed = SPEED_MAX;
        const ended = new Promise(resolve => { this.end_resolve = resolve; });
        this.emit("reset");
        const reply = await this.restart_at(base, "live");
        if(reply.status.mode === "live") this.end_resolve = null;
        else await ended;
    }

    // Lesson: replay of the source journal so that the Worker sees only events before `stop`. It runs fast to event
    // `from`,
    // then at 1x. After event `stop - 1` the machine becomes live (live_at_stop) or stays paused.
    // Returns when the Worker has reached `stop`; arrival is reported by the "end" event.
    async play_segment({ from, stop, live_at_stop }) {
        this.limit(stop, live_at_stop);
        const token = ++this.seek_seq;
        const base = this.snaps.filter(record => record.next <= from).at(-1) ?? this.earliest_start();
        const fast = from > (base?.next ?? 0) && from < stop;
        this.speed = fast || stop === from ? SPEED_MAX : 1;
        this.emit("reset");
        const reply = await this.restart_at(base);
        if(reply.status.mode === "live") return this.emit("end", {});
        if(!fast) return;
        await this.run_to(event_times(this.source)[from], token);
        if(token !== this.seek_seq) return;
        this.set_speed(1);
        this.resume();
    }

    // Cuts the Worker's event list: after event `stop - 1` the replay ends (with a live machine or a pause).
    limit(stop, live_at_stop) {
        this.events = this.source.events.slice(0, stop);
        this.on_journal_end = live_at_stop ? "live" : "pause";
    }

    async run_to(target, token) {
        const vtime = await this.request("run_until", { target });
        if(token !== this.seek_seq) return null;
        await this.request("pause");
        this.user_paused = true;
        this.status_now = { ...this.status_now, vtime };
        return vtime;
    }

    // A dead core will not hand over its journal; the copy on the main thread lags behind the Worker by at most the
    // status interval.
    // A journal taken from the copy does not end with a `check`.
    async worker_journal() {
        if(!this.dead) return this.request("journal");
        return { events: this.mirror.slice(), rate0: this.session_rate0 };
    }

    async journal() {
        const { events, rate0 } = await this.worker_journal();
        if(this.dead && !this.source && rate0 === null) throw new Error("Журнал недоступний: машину ще не запущено");
        this.session_rate0 ??= rate0;
        return { header: this.header_now(), events };
    }

    header_now() {
        return this.source ? this.replay_header() : this.session_header(this.session_rate0);
    }

    replay_header() {
        const header = { ...this.source.header, recorded_at: new Date().toISOString(), machine: this.name };
        // A lesson marks up the teacher's recording; a journal continued by a live machine is shorter than the
        // recording, and the lesson's indexes are wrong for it.
        if(this.live) delete header.lesson;
        if(this.live_from !== null) {
            header.parent = { digest: journal_digest(this.source), event: this.live_from };
            // The replay up to go_live matched on this host, and the events after it were recorded here.
            header.host_nan = host_nan();
        }
        return header;
    }

    session_header(rate0) {
        const boot = this.boot.snap.clock;
        return {
            format: FORMAT, profile: this.profile_name, machine: this.name, seed: this.session_seed, epoch: boot.epoch,
            recorded_at: new Date().toISOString(), rate0, host_nan: host_nan(),
            start: { snapshot: `${this.profile_name}-boot`, digest: boot.ram }, parent: null,
        };
    }

    stop() {
        this.stopped = true;
        clearInterval(this.silence_timer);
        this.silence_timer = null;
        this.early_input = [];
        this.worker?.terminate();
        this.worker = null;
        this.reject_pending(new Error("зупинено"));
        this.agent.reject_all(new Error("зупинено"));
    }
}
