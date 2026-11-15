// Node driver for the deterministic engine (one machine per process).
//   boot   <profile> <out.snap>                      cold boot, start the system channel (ttyS1) and the teacher shell (ttyS2), save a boot snapshot
//   record <profile> <out.json> [start.snap]         type the profile's commands, journal them
//   replay <journal.json> [start.snap] [--mid out.snap]   replay flat out; --mid saves a snapshot halfway
//   resume <journal.json> <mid.snap>                 continue a replay from a mid snapshot
//   utf8   <profile>                                 type "echo привіт", expect "привіт" back (UTF-8 both ways)
//   check  <profile> <out.json> <start.snap>         check() with a busy guest and on a paused machine: the journal ends with `check`
//   check_replay <profile>                           check() on a machine that only replays is rejected
//   channels <profile> <out.json> <start.snap>        fresh session: date via the agent, nothing from the system in the student terminal, system commands
//                                                    while the student's program runs, teacher terminal (ttyS2), killed agent -> timeout error
//   run_binary <profile> <start.snap> <elf32>        upload a static 32-bit binary into the guest, run it, print its stdout in base64
//   image_failure <journal.json> <start.snap> throw|hang   replay with the image file loader failing (or never answering): the error must name the file
//   image_wait <profile> <start.snap> <hang_ms>      live machine, the first image file read hangs for hang_ms: `status` events with `waiting: true` keep coming
//   snapshot_release <profile> <start.snap>          (node --expose-gc) after start from a snapshot the ArrayBuffers in use must not include a second copy of guest memory
//   replay_slow <journal.json> <start.snap>          replay at 1x with on_journal_end "pause"; after `end` set_speed(0) and snapshot() must still arrive within 2 s (the last event may be a huge `clock`)
//   corrupt <journal.json> [start.snap]              replay, flip the top byte of xmm7 halfway: the next check must report a divergence
// Exit code 0 = finished without divergence; the last line is a JSON summary.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create_machine } from "../core/engine.mjs";
import { FORMAT, read_journal, event_times } from "../core/journal.mjs";
import { host_nan } from "../core/host_nan.mjs";
import { encode_snapshot, decode_snapshot } from "../core/snapfile.mjs";
import { AgentChannel } from "../machine/agent_channel.mjs";
import { GUEST_SETUP_LINES, PROFILES, SESSION_ENTROPY_BYTES, fresh_session_input, session_command } from "../profiles.mjs";
import { ServerFileStorageWrapper } from "../../v86det/src/browser/filestorage.js";
import { state_diff } from "./state_diff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
// Card state the guest changed before the snapshot (the MAC) must survive a restore:
// resume compares it with the snapshot.
const SET_MAC = "ifconfig eth0 hw ether 02:00:00:00:00:07 up\n";
const COMMANDS = {
    buildroot: [
        SET_MAC,
        "uname -r\n",
        "sleep 1; cat /proc/uptime\n",
        "i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done; echo $i\n",
        "head -c 8 /dev/urandom | od -x | head -1\n",
    ],
    net: [
        SET_MAC,
        "uname -r\n",
        "ip link add link eth0 name eth0.10 type vlan id 10 && ip link set eth0.10 up && ip -br link show eth0.10\n",
        "sleep 1; cat /proc/uptime\n",
        "head -c 8 /dev/urandom | od -x | head -1\n",
    ],
    alpine: [
        SET_MAC,
        "python3 -c 'import random; print(sum(range(10**5)), random.random())'\n",
        "printf '#include <stdio.h>\\nint main(){puts(\"hi from gcc\");}\\n' > h.c && gcc h.c -o h && ./h\n",
        "head -c 8 /dev/urandom | od -x | head -1; sleep 1; cat /proc/uptime\n",
    ],
    study: [
        SET_MAC,
        "python3 -c 'import random; print(sum(range(10**5)), random.random())'\n",
        "printf '#include <stdio.h>\\nint main(){puts(\"hi from gcc\");}\\n' > h.c && gcc h.c -o h && ./h\n",
        "printf '#include <iostream>\\nint main(){std::cout << \"hi from g++\" << std::endl;}\\n' > h.cpp && g++ h.cpp -o hpp && ./hpp\n",
        "git --version; bash -c 'echo $BASH_VERSION'\n",
        "man ls | head -3\n",
        "head -c 8 /dev/urandom | od -x | head -1; sleep 1; cat /proc/uptime\n",
    ],
};
const host_ms = () => performance.timeOrigin + performance.now();
// Math.random belongs to the guest now; typing delays need a host generator.
let host_seed = Math.floor(host_ms()) % 2147483647;
const host_random = () => (host_seed = host_seed * 48271 % 2147483647) / 2147483647;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function done(summary, code = 0) {
    console.log(JSON.stringify(summary));
    process.exit(code);
}

async function load_snapshot(file) {
    return file ? decode_snapshot(new Uint8Array(fs.readFileSync(file))) : null;
}

function start(profile, opts, on_error = null) {
    const m = create_machine({ config: PROFILES[profile].config(ROOT), ...opts });
    let text = "";
    const decoder = new TextDecoder();
    m.on("serial", bytes => { text += decoder.decode(bytes, { stream: true }); });
    m.on("error", on_error ?? (message => done({ ok: false, error: message, status: m.status() }, 1)));
    // Alpine's shell asks for the cursor position (ESC [6n) after the prompt.
    const at_prompt = () => text.replace(/\x1b\[6n$/, "").endsWith(PROFILES[profile].prompt);
    const wait_prompt = async () => { while(!at_prompt()) await sleep(50); };
    return { m, wait_prompt, output: () => text, clear: () => { text = ""; } };
}

async function save_snapshot(m, file) {
    const snap = await m.snapshot();
    fs.writeFileSync(file, await encode_snapshot(snap));
    return snap.clock;
}

async function boot(profile, out) {
    const { m, wait_prompt, clear } = start(profile, { seed: 1 + Math.floor(host_random() * 2 ** 30), on_journal_end: "live", check_every_ms: 0 });
    await m.ready;
    await wait_prompt();
    for(const line of GUEST_SETUP_LINES) {
        clear();
        m.type(line);
        await sleep(300);
        await wait_prompt();
    }
    await sleep(500);
    const clock = await save_snapshot(m, out);
    done({ ok: true, vtime: clock.vtime, ram: clock.ram, bytes: fs.statSync(out).size });
}

async function type_slowly(m, text) {
    for(const ch of text) { m.type(ch); await sleep(30 + host_random() * 120); }
}

async function record(profile, out, snap_file) {
    const snapshot = await load_snapshot(snap_file);
    const seed = 1 + Math.floor(host_random() * 2 ** 30);
    const epoch = Math.floor(host_ms());
    const s = start(profile, { seed, epoch, snapshot, reseed: !!snapshot, on_journal_end: "live", known_hashes: snapshot ? snapshot.hashes : [] });
    await s.m.ready;
    if(!snapshot) await s.wait_prompt();
    else s.m.type("\n");
    await sleep(500);
    for(const cmd of COMMANDS[profile]) { s.clear(); await type_slowly(s.m, cmd); await sleep(200); await s.wait_prompt(); }
    await s.m.check();
    write_journal(s.m, out, { profile, seed, epoch, snapshot, snap_file });
    const checks = s.m.events.filter(e => e.t === "check").length;
    done({ ok: true, events: s.m.events.length, checks, vtime: s.m.vtime(), tail: s.output().slice(-200) });
}

function write_journal(m, out, { profile, seed, epoch, snapshot, snap_file }) {
    const header = {
        format: FORMAT, profile, machine: "node-test", seed, epoch: snapshot ? snapshot.clock.epoch : epoch,
        recorded_at: new Date(host_ms()).toISOString(), rate0: m.rate0, host_nan: host_nan(),
        start: snapshot ? { snapshot: path.basename(snap_file, ".snap"), digest: snapshot.clock.ram } : null, parent: null,
    };
    fs.writeFileSync(out, JSON.stringify({ header, events: m.events }));
}

const BUSY_COMMAND = "yes > /dev/null\n";
const CTRL_C = "\x03";

function expect_ends_with_check(m, index, label) {
    const last = m.events.length - 1;
    if(index !== last || m.events[last].t !== "check") done({ ok: false, error: `${label}: check returned ${index}, last event ${last}: ${m.events[last].t}` }, 1);
}

// The guest is busy (`yes`), and the machine is also stopped before the next request: in both cases check()
// resolves with the index of the event it recorded, and with `pause` that event stays the last one.
async function check_mode(profile, out, snap_file) {
    const snapshot = await load_snapshot(snap_file);
    const seed = 1 + Math.floor(host_random() * 2 ** 30);
    const epoch = Math.floor(host_ms());
    const s = start(profile, { seed, epoch, snapshot, reseed: !!snapshot, on_journal_end: "live", known_hashes: snapshot ? snapshot.hashes : [] });
    await s.m.ready;
    s.m.type("\n");
    await sleep(500);
    await s.wait_prompt();
    s.m.type(BUSY_COMMAND);
    await sleep(1000);

    expect_ends_with_check(s.m, await s.m.check({ pause: true }), "busy guest");
    const stopped_at = s.m.events.length;
    await sleep(300);
    if(!s.m.status().paused || s.m.events.length !== stopped_at) done({ ok: false, error: "after check({ pause }) the machine is not stopped" }, 1);

    expect_ends_with_check(s.m, await s.m.check(), "machine paused");
    if(!s.m.status().paused) done({ ok: false, error: "check() woke a paused machine" }, 1);

    s.m.resume();
    await sleep(500);
    expect_ends_with_check(s.m, await s.m.check({ pause: true }), "after resume");
    s.m.resume();
    s.m.type(CTRL_C);
    s.clear();
    await sleep(500);
    await s.wait_prompt();
    await s.m.check();
    write_journal(s.m, out, { profile, seed, epoch, snapshot, snap_file });
    done({ ok: true, events: s.m.events.length, checks: s.m.events.filter(e => e.t === "check").length });
}

function check_replay(profile) {
    const m = create_machine({ config: PROFILES[profile].config(ROOT), events: [], on_journal_end: "pause" });
    m.check().then(
        () => done({ ok: false, error: "check() in replay mode was not rejected" }, 1),
        error => done({ ok: /не в живому режимі/.test(error.message), message: error.message }, 0),
    );
}

async function utf8(profile) {
    const s = start(profile, { seed: 1, on_journal_end: "live", check_every_ms: 0 });
    await s.m.ready;
    await s.wait_prompt();
    s.clear();
    s.m.type("echo привіт\n");
    await sleep(500);
    await s.wait_prompt();
    const ok = s.output().includes("\nпривіт\r\n");
    done({ ok, tail: s.output().slice(-100) }, ok ? 0 : 1);
}

async function replay(journal_file, snap_file, mid_file) {
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(snap_file);
    const { header, events } = journal;
    const s = start(header.profile, { seed: header.seed, reseed: !!snapshot, epoch: header.epoch, snapshot, events, check_every_ms: 0, recorded_host_nan: header.host_nan });
    s.m.set_speed(0);
    const t0 = performance.now();
    await s.m.ready;
    let mid = null;
    if(mid_file) {
        const times = event_times(journal);
        await s.m.run_until((times[0] + times[times.length - 1]) / 2);
        if(!process.env.MID_NO_SNAP) mid = await save_snapshot(s.m, mid_file);
        if(process.env.MID_SLEEP) await sleep(Number(process.env.MID_SLEEP));
        s.m.resume();
    }
    while(!s.m.status().ended) await sleep(50);
    const checks = events.filter(e => e.t === "check").length;
    done({ ok: true, events: events.length, checks, vtime: s.m.vtime(), wall_ms: Math.round(performance.now() - t0), mid });
}

async function resume(journal_file, mid_file) {
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(mid_file);
    const s = start(journal.header.profile, { snapshot, events: journal.events, next: snapshot.clock.next, check_every_ms: 0, recorded_host_nan: journal.header.host_nan });
    s.m.set_speed(0);
    // The request is served in the first yield, before the first slice of instructions.
    const taken_again = s.m.snapshot();
    await s.m.ready;
    const restored = s.m.ram_digest();
    if(restored !== snapshot.clock.ram) done({ ok: false, error: `RAM after restore ${restored} != ${snapshot.clock.ram}` }, 1);
    const again = await taken_again;
    const clock_diff = Object.keys(snapshot.clock)
        .filter(key => JSON.stringify(snapshot.clock[key]) !== JSON.stringify(again.clock[key]))
        .map(key => `clock.${key}: ${JSON.stringify(snapshot.clock[key])} != ${JSON.stringify(again.clock[key])}`);
    const lost = [...state_diff(snapshot.state, again.state), ...clock_diff];
    if(lost.length) done({ ok: false, error: `state after the restore does not match the snapshot: ${lost.join("; ")}` }, 1);
    while(!s.m.status().ended) await sleep(50);
    const later = journal.events.slice(snapshot.clock.next).filter(e => e.t === "check").length;
    done({ ok: true, from_event: snapshot.clock.next, checks_after: later, vtime: s.m.vtime() });
}

// The top byte of xmm7 lies in wasm memory at offset reg_xmm32s (v86det/src/cpu.js) + 7 * 16 + 15. The Linux kernel
// does not use SSE, so the corrupted byte never reaches RAM, and only the hash of the rest of memory can see it.
const XMM7_TOP_BYTE = 832 + 7 * 16 + 15;

// wasm memory to flip the byte in: the engine does not expose it, so the driver watches the memory export of the
// modules being instantiated.
function capture_wasm_memory() {
    const instantiate = WebAssembly.instantiate;
    const captured = [];
    WebAssembly.instantiate = async (...args) => {
        const result = await instantiate(...args);
        const memory = (result.instance ?? result).exports?.memory;
        if(memory) captured.push(memory);
        return result;
    };
    return captured;
}

async function corrupt(journal_file, snap_file) {
    const memories = capture_wasm_memory();
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(snap_file);
    const { header, events } = journal;
    const flipped_at = { event: null };
    const on_error = message => {
        const found = /розбіжність стану між перевіркою/.test(message);
        done({ ok: found && flipped_at.event !== null, flipped_at_event: flipped_at.event, message: message.replace(/події між ними:[^;]*;/, "") }, found ? 0 : 1);
    };
    const s = start(header.profile, { seed: header.seed, reseed: !!snapshot, epoch: header.epoch, snapshot, events, check_every_ms: 0, recorded_host_nan: header.host_nan }, on_error);
    s.m.set_speed(0);
    await s.m.ready;
    const times = event_times(journal);
    await s.m.run_until((times[0] + times[times.length - 1]) / 2);
    // The second, small memory export belongs to a helper module: the emulator's memory is the one needed.
    const memory = memories.reduce((big, next) => next.buffer.byteLength > big.buffer.byteLength ? next : big);
    const bytes = new Uint8Array(memory.buffer);
    const before = { ram: s.m.ram_digest(), rest: s.m.state_digest() };
    bytes[XMM7_TOP_BYTE] ^= 0x01;
    const after = { ram: s.m.ram_digest(), rest: s.m.state_digest() };
    if(after.ram !== before.ram || after.rest === before.rest) done({ ok: false, error: "an xmm7 byte must change only the hash of the rest of memory", before, after }, 1);
    // The snapshot and the RAM hash are not needed here; the byte stays corrupted until the next check from the
    // journal.
    flipped_at.event = s.m.status().next;
    s.m.resume();
    while(!s.m.status().ended) await sleep(50);
    done({ ok: false, error: "corrupted xmm7 not noticed until the end of the journal" }, 1);
}

const UPLOAD_CHUNK = 128;
const RESULT_MARK = "RESULT:";
const FILE_END = "EOF_UPLOAD";

async function run_binary(profile, snap_file, elf_file) {
    const snapshot = await load_snapshot(snap_file);
    const s = start(profile, { seed: 1 + Math.floor(host_random() * 2 ** 30), epoch: Math.floor(host_ms()), snapshot, reseed: true, on_journal_end: "live", check_every_ms: 0 });
    await s.m.ready;
    s.m.type("\n");
    await sleep(500);
    await s.wait_prompt();
    s.clear();
    const encoded = fs.readFileSync(elf_file).toString("base64").replace(/(.{76})/g, "$1\n");
    s.m.type(`base64 -d > /tmp/guest_bin << '${FILE_END}'\n`);
    for(let at = 0; at < encoded.length; at += UPLOAD_CHUNK) { s.m.type(encoded.slice(at, at + UPLOAD_CHUNK)); await sleep(150); }
    s.m.type(`\n${FILE_END}\n`);
    await sleep(300);
    s.clear();
    // The marker is split in the command text so that the terminal echo does not look like the result.
    s.m.type("chmod +x /tmp/guest_bin && printf 'RESU''LT:'; /tmp/guest_bin | base64 | tr -d '\\n'; echo\n");
    await sleep(500);
    for(let waited = 0; !new RegExp(`\\n${RESULT_MARK}[A-Za-z0-9+/=]+\\r?\\n`).test(s.output()) && waited < 60000; waited += 100) await sleep(100);
    const found = s.output().match(new RegExp(`\\n${RESULT_MARK}([A-Za-z0-9+/=]+)\\r?\\n`));
    done({ ok: !!found, stdout_base64: found ? found[1] : null, tail: found ? undefined : s.output().slice(-300) }, found ? 0 : 1);
}

const PORT_AGENT = 1;
const PORT_TEACHER = 2;
const DATE_TOLERANCE_S = 120;
const AGENT_TIMEOUT_MS = 30000;
const KILLED_AGENT_TIMEOUT_MS = 3000;
const CTRL_D = "\x04";

function fail(message, details = {}) { done({ ok: false, error: message, ...details }, 1); }

// The same as Machine does: agent requests go to ttyS1 with by "system", the answers come as separate messages.
async function channels(profile, out, snap_file) {
    const snapshot = await load_snapshot(snap_file);
    const seed = 1 + Math.floor(host_random() * 2 ** 30);
    const epoch = Math.floor(host_ms());
    const s = start(profile, { seed, epoch, snapshot, reseed: true, on_journal_end: "live", known_hashes: snapshot.hashes });
    const teacher = { text: "" };
    const agent = new AgentChannel(text => s.m.type(text, "system", PORT_AGENT), { stalled: () => s.m.stalled() });
    s.m.on("serial1", bytes => agent.feed(bytes));
    const decoder = new TextDecoder();
    s.m.on("serial2", bytes => { teacher.text += decoder.decode(bytes, { stream: true }); });
    await s.m.ready;
    const system = command => agent.request(command, AGENT_TIMEOUT_MS);

    // A new session, as in Machine.begin_session: Enter in the student console, the date and the seed through the
    // agent. randomBytes, because the core
    // replaced the process's crypto. /dev/urandom is read at once: before the reseed it is the same in every session
    // from the snapshot.
    s.m.type(fresh_session_input());
    await sleep(500);
    await s.wait_prompt();
    const before_date = s.output();
    const set = await system(session_command(host_ms(), randomBytes(SESSION_ENTROPY_BYTES)));
    if(set.rc !== 0) fail(`session start command: code ${set.rc}, output ${JSON.stringify(set.output)}`);
    const urandom = (await system("head -c 8 /dev/urandom | od -x | head -1")).output.trim();
    const guest_s = Number((await system("date +%s")).output.trim());
    const date_diff_s = Math.abs(guest_s - host_ms() / 1000);
    if(!(date_diff_s < DATE_TOLERANCE_S)) fail(`guest date differs from the host by ${date_diff_s} с`);
    await sleep(300);
    const student_after_date = s.output().slice(before_date.length);
    if(!/^(\r?\n)*$/.test(student_after_date) && student_after_date.replace(PROFILES[profile].prompt, "").replace(/\x1b\[6n/g, "").trim() !== "") {
        fail("the student's terminal has system output", { student_after_date });
    }

    // A system command while the student's program reads stdin.
    s.clear();
    s.m.type("cat > /tmp/student_in\n");
    await sleep(500);
    s.m.type("abc\n");
    await sleep(300);
    const during = await system("echo sys-ok; echo err >&2; head -c 3 /dev/zero | od -An -tx1; exit 5");
    if(during.rc !== 5 || !during.output.includes("sys-ok") || !during.output.includes("err") || !/00 00 00/.test(during.output)) fail("system command while the student's program runs", { during });
    s.m.type(CTRL_D);
    await sleep(300);
    await s.wait_prompt();
    const received = (await system("cat /tmp/student_in")).output;
    if(received !== "abc\n") fail("the student's program got extra", { received });
    if(/sys-ok|@req|@res/.test(s.output())) fail("the student's terminal has system output", { tail: s.output().slice(-300) });

    // Teacher terminal: a command, Ctrl-C after sleep 100.
    s.m.type("touch /tmp/t\n", "teacher", PORT_TEACHER);
    await sleep(800);
    if((await system("test -f /tmp/t")).rc !== 0) fail("input to ttyS2 did not run touch", { teacher: teacher.text });
    s.m.type("sleep 100\n", "teacher", PORT_TEACHER);
    await sleep(800);
    s.m.type(CTRL_C, "teacher", PORT_TEACHER);
    await sleep(300);
    s.m.type("echo after > /tmp/t2\n", "teacher", PORT_TEACHER);
    await sleep(800);
    if((await system("cat /tmp/t2")).output.trim() !== "after") fail("Ctrl-C on ttyS2 did not interrupt sleep 100", { teacher: teacher.text });

    // The agent is killed: a system command fails with a timeout instead of hanging.
    s.clear();
    s.m.type("kill $(ps | grep /dev/ttyS1 | grep -v grep | awk '{print $1}')\n");
    await sleep(800);
    await s.wait_prompt();
    const outcome = await agent.request("true", KILLED_AGENT_TIMEOUT_MS).then(() => "відповів", error => error.message);
    if(!/Агент не відповів/.test(outcome)) fail("with the agent killed, a timeout error was expected", { outcome });
    await s.m.check();
    write_journal(s.m, out, { profile, seed, epoch, snapshot, snap_file });
    done({ ok: true, date_diff_s, urandom, events: s.m.events.length, ports: [...new Set(s.m.events.filter(e => e.t === "serial").map(e => e.p ?? 0))], timeout_message: outcome });
}

const HANG_TIMEOUT_MS = 2000;
const UNHANDLED_QUIET_MS = 1000;

async function image_failure(journal_file, snap_file, how) {
    // The kernel and initrd are read at start; loading is broken only after that, when the guest reads image files.
    const load_from_server = ServerFileStorageWrapper.prototype.load_from_server;
    let broken = false;
    ServerFileStorageWrapper.prototype.load_from_server = function(...args) {
        if(!broken) return load_from_server.apply(this, args);
        return how === "throw" ? Promise.reject(new Error("network unavailable")) : new Promise(() => {});
    };
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(snap_file);
    const { header, events } = journal;
    // KEEP_ALIVE_AFTER_ERROR=1: after an error, do not exit at once but catch unhandled promise rejections (the
    // UNHANDLED line).
    const keep_alive = process.env.KEEP_ALIVE_AFTER_ERROR === "1";
    if(keep_alive) process.on("unhandledRejection", error => console.log(`UNHANDLED ${error?.message ?? error}`));
    const on_error = async message => {
        const named = /не вдалося завантажити файл образу \S+: .*повтор неможливий без мережі/.test(message);
        if(keep_alive) await sleep(UNHANDLED_QUIET_MS);
        done({ ok: named && !/розбіжність/.test(message), message }, named ? 0 : 1);
    };
    const s = start(header.profile, { seed: header.seed, reseed: !!snapshot, epoch: header.epoch, snapshot, events, check_every_ms: 0, recorded_host_nan: header.host_nan, image_timeout_ms: HANG_TIMEOUT_MS }, on_error);
    s.m.set_speed(0);
    await s.m.ready;
    broken = true;
    while(!s.m.status().ended) await sleep(50);
    done({ ok: false, error: "replay reached the end although the image files were not loaded" }, 1);
}

const WAIT_STATUS_GAP_MS = 1500;
const SNAPSHOT_COPY_LIMIT = 1.5;
const SETTLE_MS = 1000;

// A start from a snapshot must not keep the snapshot in the Worker's memory: the extra copy of wasm memory (85-171 MB)
// lives as long as the Worker.
async function snapshot_release(profile, snap_file) {
    if(typeof globalThis.gc !== "function") done({ ok: false, error: "needs node --expose-gc" }, 2);
    const launch = async () => {
        const snapshot = await load_snapshot(snap_file);
        const s = start(profile, { seed: 1, epoch: 1, snapshot, reseed: true, on_journal_end: "live", check_every_ms: 0 });
        await s.m.ready;
        return snapshot.mem.length;
    };
    const mem_size = await launch();
    await sleep(SETTLE_MS);
    globalThis.gc();
    globalThis.gc();
    const array_buffers = process.memoryUsage().arrayBuffers;
    const ratio = array_buffers / mem_size;
    done({ ok: ratio < SNAPSHOT_COPY_LIMIT, mem_size, array_buffers, ratio: Math.round(ratio * 100) / 100 }, ratio < SNAPSHOT_COPY_LIMIT ? 0 : 1);
}

// Live mode: reading an image file hangs for hang_ms. While it hangs, the core must report `status` with `waiting:
// true`
// at least once a second (the page uses it to tell waiting from a hang), and then the command must complete.
async function image_wait(profile, snap_file, hang_ms) {
    const load_from_server = ServerFileStorageWrapper.prototype.load_from_server;
    let delayed = false, armed = false;
    ServerFileStorageWrapper.prototype.load_from_server = function(...args) {
        if(!armed || delayed) return load_from_server.apply(this, args);
        delayed = true;
        return sleep(hang_ms).then(() => load_from_server.apply(this, args));
    };
    const snapshot = await load_snapshot(snap_file);
    const s = start(profile, { seed: 1 + Math.floor(host_random() * 2 ** 30), epoch: Math.floor(host_ms()), snapshot, reseed: true, on_journal_end: "live", check_every_ms: 0 });
    const waiting_at = [];
    s.m.on("status", status => { if(status.waiting === true) waiting_at.push(performance.now()); });
    await s.m.ready;
    s.m.type("\n");
    await sleep(500);
    await s.wait_prompt();
    s.clear();
    armed = true;
    s.m.type("python3 -c 'print(6 * 7)'\n");
    for(let waited = 0; !/\n42\r?\n/.test(s.output()) && waited < 60000; waited += 100) await sleep(100);
    const gaps = waiting_at.slice(1).map((at, i) => Math.round(at - waiting_at[i]));
    const ok = delayed && /\n42\r?\n/.test(s.output()) && waiting_at.length >= Math.floor(hang_ms / 1000) && gaps.every(gap => gap <= WAIT_STATUS_GAP_MS);
    done({ ok, delayed, answered: /\n42\r?\n/.test(s.output()), waiting_statuses: waiting_at.length, gaps }, ok ? 0 : 1);
}

const CONTROL_DEADLINE_MS = 2000;

async function replay_slow(journal_file, snap_file) {
    const journal = read_journal(JSON.parse(fs.readFileSync(journal_file, "utf8")));
    const snapshot = await load_snapshot(snap_file);
    const { header, events } = journal;
    const s = start(header.profile, { seed: header.seed, reseed: !!snapshot, epoch: header.epoch, snapshot, events, on_journal_end: "pause", check_every_ms: 0, recorded_host_nan: header.host_nan });
    s.m.set_speed(1);
    await s.m.ready;
    while(!s.m.status().ended) await sleep(50);
    s.m.set_speed(0);
    const outcome = await Promise.race([s.m.snapshot().then(() => "snapshot"), sleep(CONTROL_DEADLINE_MS).then(() => "stuck")]);
    done({ ok: outcome === "snapshot", outcome, vtime: s.m.vtime() }, outcome === "snapshot" ? 0 : 1);
}

const [cmd, a, b, c, d] = process.argv.slice(2);
if(cmd === "boot") await boot(a, b);
else if(cmd === "record") await record(a, b, c);
else if(cmd === "replay") await replay(a, b && !b.startsWith("--") ? b : null, [b, c, d].includes("--mid") ? [b, c, d][[b, c, d].indexOf("--mid") + 1] : null);
else if(cmd === "resume") await resume(a, b);
else if(cmd === "utf8") await utf8(a);
else if(cmd === "check") await check_mode(a, b, c);
else if(cmd === "check_replay") check_replay(a);
else if(cmd === "run_binary") await run_binary(a, b, c);
else if(cmd === "channels") await channels(a, b, c);
else if(cmd === "image_failure") await image_failure(a, b, c);
else if(cmd === "image_wait") await image_wait(a, b, Number(c));
else if(cmd === "snapshot_release") await snapshot_release(a, b);
else if(cmd === "replay_slow") await replay_slow(a, b);
else if(cmd === "corrupt") await corrupt(a, b);
else done({ ok: false, error: "usage: boot|record|replay|resume|utf8|check|check_replay (see the header of this file)" }, 2);
