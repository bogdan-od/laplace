// Node driver: snapshot boundaries in the core. A snapshot in the tick of every journal event (S.next/journal already
// past the event), then resume
// from it in engine.node.mjs. Used by engine_boundary.test.mjs.
//   record <profile> <out.json> <start.snap> short|hour   live recording without snapshots (a snapshot in every tick slows recording, and every tick gives a clock event)
//   snap_all <journal.json> <start.snap> <snapdir>         replay from the start; a snapshot in the tick of every event
// hour: the guest is idle, performance.now jumps by an hour -> one clock event with extra ≈ 3 600 000; after it the
// guest answers input.
// The last output line is JSON {ok, snapshots: [{index, next, file}]}; index is the first event after which the
// snapshot was taken.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create_machine } from "../core/engine.mjs";
import { FORMAT, read_journal } from "../core/journal.mjs";
import { host_nan } from "../core/host_nan.mjs";
import { decode_snapshot, encode_snapshot } from "../core/snapfile.mjs";
import { PROFILES } from "../profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const HOUR_MS = 3_600_000;
const SEED = 424242;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host_ms = () => performance.timeOrigin + performance.now();

function done(summary, code = 0) {
    console.log(JSON.stringify(summary));
    process.exit(code);
}

// Guest clock in a live recording: performance.now can be shifted so that the guest sees an hour of idling.
let clock_offset = 0;
const real_now = performance.now.bind(performance);
performance.now = () => real_now() + clock_offset;

async function load_snapshot(file) {
    return decode_snapshot(new Uint8Array(fs.readFileSync(file)));
}

function start(profile, opts) {
    const m = create_machine({ config: PROFILES[profile].config(ROOT), ...opts });
    let text = "";
    const decoder = new TextDecoder();
    m.on("serial", bytes => { text += decoder.decode(bytes, { stream: true }); });
    m.on("error", message => done({ ok: false, error: message, status: m.status() }, 1));
    const wait_for = async (pattern, label, limit_ms = 60000) => {
        for(let waited = 0; !pattern.test(text); waited += 50) {
            if(waited > limit_ms) done({ ok: false, error: `never came ${label}`, tail: text.slice(-200) }, 1);
            await sleep(50);
        }
    };
    return { m, wait_prompt: () => wait_for(new RegExp(`${PROFILES[profile].prompt.replace(/[~%]/g, "\\$&")}$`), "запрошення"), wait_for, output: () => text, clear: () => { text = ""; } };
}

// Snapshots arriving one after another carry only new chunks: the rest is filled in from what has accumulated. One file
// per unique `next`.
function snapshot_writer(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const blobs = new Map();
    const lookup = h => blobs.get(h);
    const written = new Map();
    const list = [];
    let chain = Promise.resolve();
    const handle = (index, snap) => {
        for(const [h, b] of snap.chunks) if(b) blobs.set(h, b);
        for(const [, h, b] of snap.jit) if(b) blobs.set(h, b);
        const next = snap.clock.next;
        if(!written.has(next)) {
            const file = path.join(dir, `next${next}.snap`);
            written.set(next, file);
            chain = chain.then(async () => fs.writeFileSync(file, await encode_snapshot(snap, lookup)));
        }
        list.push({ index, next, file: written.get(next) });
    };
    return { handle, flush: () => chain, list };
}

function write_journal(m, out, snapshot, snap_file) {
    const header = {
        format: FORMAT, profile: "buildroot", machine: "node-test", seed: SEED, epoch: snapshot.clock.epoch,
        recorded_at: new Date(host_ms()).toISOString(), rate0: m.rate0, host_nan: host_nan(),
        start: { snapshot: path.basename(snap_file, ".snap"), digest: snapshot.clock.ram }, parent: null,
    };
    fs.writeFileSync(out, JSON.stringify({ header, events: m.events }));
}

// ≈40 events: words as a whole line (several events in one tick), characters with pauses while the guest idles (events
// at the same c with a larger w),
// check, sleep 1 (clock from idling), three checks in a row while idle.
async function short_session(s) {
    s.m.type("\n");
    await sleep(300);
    await s.wait_prompt();
    s.clear();
    s.m.type("echo one two\n");
    await sleep(300);
    await s.wait_prompt();
    for(const ch of "uname -r\n") { s.m.type(ch); await sleep(60); }
    await sleep(300);
    await s.wait_prompt();
    await s.m.check();
    s.clear();
    s.m.type("sleep 1; echo slept\n");
    await s.wait_for(/slept/, "slept");
    await s.wait_prompt();
    for(const ch of "id\n") { s.m.type(ch); await sleep(120); }
    await sleep(300);
    await s.wait_prompt();
    // The guest is in HLT and nothing executes: check events in neighbouring ticks sit at the same c with a larger w.
    await s.m.check();
    await s.m.check();
    await s.m.check();
}

async function hour_session(s) {
    s.m.type("\n");
    await sleep(500);
    await s.wait_prompt();
    await s.m.check();
    s.clear();
    clock_offset += HOUR_MS;
    const clocks = () => s.m.events.filter(e => e.t === "clock" && e.extra >= HOUR_MS * 0.99);
    for(let waited = 0; !clocks().length; waited += 50) {
        if(waited > 30000) done({ ok: false, error: "no one-hour clock event" }, 1);
        await sleep(50);
    }
    await sleep(300);
    s.m.type("echo alive-$((6*7))\n");
    await s.wait_for(/alive-42/, "guest answer after an hour of idle");
    await s.wait_prompt();
    await s.m.check();
}

async function record(profile, out, snap_file, kind) {
    const snapshot = await load_snapshot(snap_file);
    const s = start(profile, { seed: SEED, epoch: snapshot.clock.epoch, snapshot, reseed: true, on_journal_end: "live", check_every_ms: 0 });
    await s.m.ready;
    await (kind === "hour" ? hour_session : short_session)(s);
    await sleep(300);
    write_journal(s.m, out, snapshot, snap_file);
    done({ ok: true, events: s.m.events.length, vtime: s.m.vtime() });
}

async function snap_all(journal_file, snap_file, dir) {
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(snap_file);
    const { header, events } = journal;
    const s = start(header.profile, { seed: header.seed, reseed: true, epoch: header.epoch, snapshot, events, check_every_ms: 0, recorded_host_nan: header.host_nan });
    const writer = snapshot_writer(dir);
    for(let index = 0; index < events.length; index++) s.m.snapshot_after_event(index).then(snap => writer.handle(index, snap));
    s.m.set_speed(0);
    await s.m.ready;
    while(!s.m.status().ended) await sleep(50);
    await writer.flush();
    done({ ok: writer.list.length === events.length, events: events.length, snapshots: writer.list });
}

const [cmd, ...args] = process.argv.slice(2);
if(cmd === "record") await record(...args);
else if(cmd === "snap_all") await snap_all(...args);
else done({ ok: false, error: "usage: record|snap_all (see the header of this file)" }, 2);
