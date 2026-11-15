// Machine on a fake Worker: messages of a killed Worker do not reach the journal copy or the status of the new one,
// and a gap in the journal increments is cured by requesting the whole journal. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "../machine/machine.mjs";
import { read_journal } from "../core/journal.mjs";

const RATE0 = { at: 0, ms: 0, per_ms: 1000 };
const event = n => ({ c: n, w: 0, t: "serial", data: String(n) });
const events_to = n => Array.from({ length: n }, (_, i) => event(i));
const status = (extra = {}) => ({ mode: "live", paused: false, ended: false, vtime: 0, next: 0, total: 0, per_ms: 1000, instructions: 0, ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeWorker {
    static all = [];
    static start_mode = "live";
    constructor() {
        this.sent = [];
        this.terminated = false;
        this.mute = false;
        this.hold = new Set();
        this.held = [];
        this.journal = [];
        FakeWorker.all.push(this);
    }
    postMessage(msg) {
        this.sent.push(msg);
        if(msg.id === undefined || this.mute) return;
        if(this.hold.has(msg.op)) { this.held.push(msg); return; }
        const start_mode = FakeWorker.start_mode;
        const value = msg.op === "start" ? { rate0: RATE0, status: status({ vtime: 1, mode: start_mode }) } : { events: this.journal, rate0: RATE0 };
        queueMicrotask(() => this.onmessage?.({ data: { op: "done", id: msg.id, value } }));
    }
    terminate() { this.terminated = true; }
    deliver(data) { this.onmessage({ data }); }
    release(op) {
        for(const msg of this.held.filter(held => held.op === op)) this.onmessage({ data: { op: "done", id: msg.id, value: 0 } });
        this.held = this.held.filter(held => held.op !== op);
    }
}

function machine(options = {}) {
    FakeWorker.all = [];
    FakeWorker.start_mode = "live";
    globalThis.Worker = FakeWorker;
    const m = new Machine({ profile: "buildroot", root: "../", name: "t", auto_recover: false, ...options });
    m.profile_name = "buildroot";
    m.abs = "file:///x/";
    return m;
}

const quiet = async fn => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try { await fn(); } finally { console.warn = original; }
    return warnings;
};

test("messages of a killed Worker after spawn are ignored: the journal copy and the status stay from the new one", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    const [old] = FakeWorker.all;
    old.deliver({ op: "status", status: status({ vtime: 100 }), log: { from: 0, events: events_to(5) } });
    assert.equal(m.mirror.length, 5);

    m.events = events_to(2);
    await m.spawn({ snapshot: null, next: 0, record: null });
    assert.equal(old.terminated, true);
    assert.deepEqual(m.mirror, events_to(2));

    old.deliver({ op: "status", status: status({ vtime: 999 }), log: { from: 2, events: events_to(9).slice(2) } });
    old.deliver({ op: "error", message: "stale error" });
    old.onerror({ message: "stale crash" });
    assert.deepEqual(m.mirror, events_to(2));
    assert.equal(m.status_now.vtime, 1);
});

test("rollback during frequent statuses: the journal copy after the rollback matches the new Worker's journal", async () => {
    const m = machine();
    const errors = [];
    m.on("error", message => errors.push(message));
    await m.spawn({ snapshot: null, next: 0, record: null });
    const [old] = FakeWorker.all;
    old.journal = events_to(8);
    old.deliver({ op: "status", status: status({ vtime: 80 }), log: { from: 0, events: events_to(8) } });
    m.live = true;

    await m.rollback(3);
    assert.deepEqual(m.mirror, events_to(3));
    // A browser that did not clear the queue of a killed Worker would deliver this.
    old.deliver({ op: "status", status: status({ vtime: 90 }), log: { from: 8, events: [event(8)] } });
    old.deliver({ op: "status", status: status({ vtime: 91 }), log: { from: 3, events: [event(3), event(4)] } });
    assert.deepEqual(m.mirror, events_to(3));
    assert.equal(m.status_now.vtime, 1);
    assert.deepEqual(errors, []);

    const fresh = FakeWorker.all.at(-1);
    fresh.deliver({ op: "status", status: status({ vtime: 2 }), log: { from: 3, events: [event(30)] } });
    assert.deepEqual(m.mirror, [...events_to(3), event(30)]);
});

test("a gap in the journal increment: a warning and the copy replaced by the Worker journal", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    worker.deliver({ op: "status", status: status(), log: { from: 0, events: events_to(3) } });
    worker.journal = events_to(10);

    const warnings = await quiet(async () => {
        worker.deliver({ op: "status", status: status(), log: { from: 6, events: events_to(8).slice(6) } });
        worker.deliver({ op: "status", status: status(), log: { from: 8, events: events_to(10).slice(8) } });
        await tick();
    });
    assert.deepEqual(m.mirror, events_to(10));
    assert.equal(warnings.length, 1, "a second gap while a request is in flight must not cause a second request");
    assert.match(warnings[0], /fell behind/);
    assert.equal(worker.sent.filter(msg => msg.op === "journal").length, 1);
});

test("the reply to a journal request of a killed Worker does not replace the new one's copy", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    const [old] = FakeWorker.all;
    old.journal = events_to(10);
    await quiet(async () => {
        old.deliver({ op: "status", status: status(), log: { from: 5, events: [event(5)] } });
        m.events = events_to(1);
        await m.spawn({ snapshot: null, next: 0, record: null });
        await tick();
    });
    assert.deepEqual(m.mirror, events_to(1));
    assert.equal(m.resyncing, false);
});

test("worker_stalled: Worker silence longer than a second outside a pause means the emulator stands still; a pause or fresh messages do not", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    assert.equal(m.worker_stalled(), false);
    m.last_heard = performance.now() - 5000;
    assert.equal(m.worker_stalled(), true);
    m.status_now = status({ paused: true });
    assert.equal(m.worker_stalled(), false);
    m.status_now = status();
    m.recovering = true;
    assert.equal(m.worker_stalled(), false);
    m.recovering = false;
    FakeWorker.all[0].deliver({ op: "status", status: status(), log: null });
    assert.equal(m.worker_stalled(), false);
});

const journal_of = events => ({ header: { format: "v86-replay/9", profile: "buildroot", seed: 1, epoch: 1, start: null }, events });
const start_params = worker => worker.sent.filter(msg => msg.op === "start").at(-1).params;

test("after auto-recovery the Worker starts with on_journal_end live although the machine was created with pause", async () => {
    const m = machine({ journal: journal_of(events_to(3)), on_journal_end: "pause", auto_recover: true });
    await m.spawn({ snapshot: null, next: 0, record: null });
    assert.equal(start_params(FakeWorker.all[0]).on_journal_end, "pause");
    const recovered = [];
    m.on("recovered", info => recovered.push(info));

    await m.fail("тестовий збій");
    assert.equal(recovered.length, 1);
    assert.equal(start_params(FakeWorker.all.at(-1)).on_journal_end, "live");
    assert.equal(m.on_journal_end, "pause", "the machine field does not change: a player without recovery pauses");
});

test("recovery does not emit end outward: the page does not write \"Кінець запису\" about a live machine", async () => {
    const m = machine({ journal: journal_of(events_to(3)), on_journal_end: "pause", auto_recover: true });
    await m.spawn({ snapshot: null, next: 0, record: null });
    const ends = [];
    m.on("end", info => ends.push(info));
    const recovered = [];
    m.on("recovered", info => recovered.push(info));

    FakeWorker.start_mode = "replay";
    const done = m.fail("тестовий збій");
    await tick();
    assert.equal(FakeWorker.all.length, 2);
    FakeWorker.all[1].deliver({ op: "end", vtime: 5, events: 3 });
    await done;
    assert.equal(recovered.length, 1);
    assert.deepEqual(ends, []);

    FakeWorker.all[1].deliver({ op: "end", vtime: 6, events: 3 });
    assert.equal(ends.length, 1, "after recovery end reaches the pages again");
});

// The header of a new session reads the boot snapshot; a real one is not needed here.
const with_fake_boot = m => {
    m.boot = { vtime: 0, next: 0, snap: { clock: { epoch: 1, ram: "0" } } };
    m.snapshot_of = () => null;
    return m;
};

const race = (promise, ms = 500) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timer")), ms))]);

test("after a final failure the journal comes from the copy, not from the dead Worker", async () => {
    const m = with_fake_boot(machine());
    m.on("error", () => {});
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    worker.deliver({ op: "status", status: status(), log: { from: 0, events: events_to(4) } });
    worker.mute = true;
    m.fail("тестовий збій");

    const checked = await race(m.checked_journal());
    assert.deepEqual(checked.events, events_to(4));
    assert.equal(checked.header.profile, "buildroot");
    assert.deepEqual((await race(m.journal())).events, events_to(4));
    assert.equal(worker.sent.some(msg => msg.op === "check"), false, "no check is sent to a dead Worker");
    await assert.rejects(race(m.request("go_live")), /після збою/);
});

test("a final failure before the first start reply: the journal is not given out, the message is clear", async () => {
    const m = machine();
    m.on("error", () => {});
    m.fail("тестовий збій");
    await assert.rejects(m.journal(), /ще не запущено/);
});

test("a failure with recovery does not mark the machine dead; a rollback revives a dead one", async () => {
    const m = with_fake_boot(machine({ auto_recover: true }));
    m.on("error", () => {});
    await m.spawn({ snapshot: null, next: 0, record: null });
    await m.fail("перший збій");
    assert.equal(m.dead, false);

    const worker = FakeWorker.all.at(-1);
    worker.deliver({ op: "status", status: status(), log: { from: 0, events: events_to(5) } });
    worker.mute = true;
    m.auto_recover = false;
    m.fail("остаточний збій");
    assert.equal(m.dead, true);

    await race(m.rollback(2));
    assert.equal(m.dead, false);
    assert.deepEqual(m.mirror, events_to(2));
    const fresh = FakeWorker.all.at(-1);
    assert.notEqual(fresh, worker);
    fresh.journal = events_to(2);
    assert.deepEqual((await m.journal()).events, events_to(2));
});

const snap_payload = (clock, byte) => ({
    clock: { vtime: 0, ...clock }, state: new ArrayBuffer(8), mem_size: 4,
    chunks: [[`h${byte}`, new Uint8Array([byte])]], jit: [],
});

test("lesson: a snapshot of the student's live branch does not get into the timeline, the bytes of its chunks are kept", () => {
    const m = machine({ journal: journal_of(events_to(5)), timeline_only: true });
    m.on_snapshot(snap_payload({ vtime: 10, next: 3 }, 1));
    m.on_snapshot(snap_payload({ vtime: 20, next: 3, live: true }, 2));

    assert.deepEqual(m.snapshots, [{ vtime: 10, next: 3 }]);
    assert.equal(m.worker_last.vtime, 20, "the next Worker snapshot will refer to the chunks of the dropped one");
    assert.ok(m.bytes.has("h2"));
});

test("lab: live snapshots are needed for rollback, timeline_only is off", () => {
    const m = machine({ journal: journal_of(events_to(5)) });
    m.on_snapshot(snap_payload({ vtime: 10, next: 3, live: true }, 1));
    assert.deepEqual(m.snapshots, [{ vtime: 10, next: 3 }]);
});

test("worker_stalled: a status with waiting means the core waits for an image file, although messages arrive", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    worker.deliver({ op: "status", status: status({ waiting: true }), log: null });
    assert.equal(m.worker_stalled(), true);
    worker.deliver({ op: "status", status: status(), log: null });
    assert.equal(m.worker_stalled(), false);
});

test("check_silence: the page slept (the watchdog was not called for longer than two periods), the silence does not count as a crash", async () => {
    const m = machine({ silence_ms: 50 });
    const errors = [];
    m.on("error", message => errors.push(message));
    await m.spawn({ snapshot: null, next: 0, record: null });
    m.status_now = status();

    m.last_watch = performance.now() - 5000;
    m.last_heard = performance.now() - 1000;
    m.check_silence();
    assert.deepEqual(errors, []);
    assert.ok(performance.now() - m.last_heard < 100, "after the sleep the Worker was heard just now");

    m.last_watch = performance.now() - 1000;
    m.last_heard = performance.now() - 1000;
    m.check_silence();
    assert.equal(errors.length, 1, "silence with a working watchdog is still a crash");
});

const sent = (worker, op) => worker.sent.filter(msg => msg.op === op).length;

test("checked_journal twice in a row: the second call sees a stale paused status and still removes the pause", async () => {
    const m = with_fake_boot(machine());
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    await m.checked_journal();
    // The status after the first check still says paused: true (it arrives at most once per 100 ms).
    worker.deliver({ op: "status", status: status({ paused: true }), log: null });
    await m.checked_journal();
    assert.equal(sent(worker, "resume"), 2);
});

test("checked_journal: a pause set by the page stays; go_live removes it", async () => {
    const m = with_fake_boot(machine());
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    m.pause();
    await m.checked_journal();
    assert.equal(sent(worker, "resume"), 0);
    await m.go_live();
    assert.equal(m.user_paused, false);
});

test("a pause before the Worker starts is also remembered as a page pause", () => {
    const m = machine();
    m.pause();
    assert.equal(m.user_paused, true);
    m.resume();
    assert.equal(m.user_paused, false);
});

test("run_to sets a page pause, a cancelled seek does not", async () => {
    const m = machine();
    await m.spawn({ snapshot: null, next: 0, record: null });
    assert.equal(await m.run_to(10, m.seek_seq + 1), null);
    assert.equal(m.user_paused, false);
    await m.run_to(10, m.seek_seq);
    assert.equal(m.user_paused, true);
});

test("continued lesson: replay_header does not carry header.lesson over, the journal is readable", () => {
    const lesson = [{ t: "self", from: 6, to: 9, text: "x" }];
    const journal = journal_of(events_to(10));
    journal.header.lesson = lesson;
    const m = machine({ journal });
    m.live = true;
    m.live_from = 3;
    const header = m.replay_header();
    assert.equal("lesson" in header, false);
    assert.deepEqual(journal.header.lesson, lesson, "the source header does not change");
    assert.doesNotThrow(() => read_journal({ header, events: journal.events.slice(0, 3) }));
});

test("a plain replay without going live keeps header.lesson", () => {
    const journal = journal_of(events_to(10));
    journal.header.lesson = [{ t: "self", from: 6, to: 9, text: "x" }];
    const header = machine({ journal }).replay_header();
    assert.deepEqual(header.lesson, journal.header.lesson);
});

const log_bytes = m => m.log.reduce((sum, entry) => sum + entry.data.length, 0);
const MB = 1 << 20;

test("live machine output in Machine.log is capped at 4 MB, old entries go whole", () => {
    const m = machine();
    m.live = true;
    for(let i = 0; i < 100; i++) m.on_serial({ data: new Uint8Array(MB), vtime: i });
    assert.ok(log_bytes(m) <= 4 * MB, `у журналі ${log_bytes(m)} bytes`);
    assert.equal(m.log.at(-1).vtime, 99, "the newest entry stays");
    assert.ok(m.log.every(entry => entry.data.length === MB), "entries are not cut");
});

test("machine output in replay mode is not evicted: the player needs the screen of any moment", () => {
    const m = machine({ journal: journal_of(events_to(3)) });
    for(let i = 0; i < 10; i++) m.on_serial({ data: new Uint8Array(MB), vtime: i });
    assert.equal(log_bytes(m), 10 * MB);
});

test("the log byte counter agrees with the content after restart_at and eviction", async () => {
    const m = machine();
    m.live = true;
    for(let i = 0; i < 6; i++) m.on_serial({ data: new Uint8Array(MB), vtime: i });
    m.snapshot_of = () => null;
    await m.restart_at({ vtime: 3, next: 0, snap: null });
    assert.deepEqual(m.log.map(entry => entry.vtime), [2, 3], "output up to the fifth MB evicted entries 0 and 1, the seek cut off 4 and 5");
    for(let i = 4; i < 10; i++) m.on_serial({ data: new Uint8Array(MB), vtime: i });
    assert.ok(log_bytes(m) <= 4 * MB);
    assert.equal(m.log.at(-1).vtime, 9);
});

test("go_live during a seek: an unfinished seek does not pause the live machine", async () => {
    const m = with_fake_boot(machine({ journal: journal_of(events_to(3)) }));
    await m.spawn({ snapshot: null, next: 0, record: null });
    const worker = FakeWorker.all[0];
    worker.hold = new Set(["run_until"]);
    const seeking = m.seek(1000);
    await tick();
    assert.equal(worker.held.length, 1);

    await m.go_live();
    worker.release("run_until");
    assert.equal(await seeking, null);
    assert.equal(sent(worker, "pause"), 0);
    assert.equal(m.live, true);
});

test("a failed start (the boot snapshot did not load): started is rejected, system() does not hang", async () => {
    const m = machine();
    globalThis.location = { href: "http://localhost/app/x.html" };
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
        await assert.rejects(m.start(), /не вдалося завантажити знімок/);
        await assert.rejects(race(m.started), /не вдалося завантажити знімок/);
        await assert.rejects(race(m.system("true")), /не вдалося завантажити знімок/);
    } finally { globalThis.fetch = original; delete globalThis.location; clearInterval(m.silence_timer); }
});

test("check() before the Worker starts is rejected with a Ukrainian message", async () => {
    await assert.rejects(machine().check(), /Перевірку не можна записати: машину ще не запущено/);
});
