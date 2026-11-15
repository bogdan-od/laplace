// node bench/speed.mjs <cfg> [--probe]
// cfg: npm | ours | ours-snap | replay | tcg | kvm | host
//   npm       v86 from npm (libv86.mjs), as the baseline
//   ours      our core app/core/engine.mjs in record mode, starting from buildroot-boot.snap, a check every 10 s, no rollback snapshots
//   ours-snap the same + rollback snapshots every 15 s (the product's parameters: web/src/machine/attempt-session.ts)
//   replay    replay of the journal recorded by ours (out/bench/ours.journal.json) at full speed; replay-snap - the same for ours-snap
//   tcg/kvm   qemu-system-i386 -accel tcg|kvm; host - sh/bash on the host
// Output: out/bench/<cfg>[-probe].json (override with BENCH_OUT). Time is host wall clock, ms, from sending the command to the DONE_N marker in the
// output.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BENCH_DIR, "..") + "/";
const IMAGES = ROOT + "images/";
const BZIMAGE = IMAGES + "buildroot-bzimage68.bin";
const V86_NPM = ROOT + "node_modules/v86/build/libv86.mjs";
const OUT_DIR = process.env.BENCH_OUT ?? ROOT + "out/bench";
const PROMPT_RE = /~% $/;
const WINDOW_CHARS = 4096;
const RUNS = 3;
const BOOT_TIMEOUT_MS = 15 * 60 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const TESTS = [
    ["T1", "i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done"],
    ["T2", "dd if=/dev/zero bs=1M count=64 2>/dev/null | md5sum"],
    ["T3", "seq 1 200000 | sort -n | md5sum"],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createSerial() {
    let tail = "", total = 0;
    const waiters = new Set();
    const check = w => { const span = Math.min(total - w.from, WINDOW_CHARS); return span > 0 && w.re.test(tail.slice(-span)); };
    return {
        total: () => total, tail: () => tail,
        feed(chunk) {
            total += chunk.length; tail = (tail + chunk).slice(-WINDOW_CHARS);
            for(const w of [...waiters]) if(check(w)) { waiters.delete(w); w.resolve(performance.now()); }
        },
        wait(re, from, timeoutMs) {
            return new Promise((resolve, reject) => {
                const w = { re, from, resolve: t => { clearTimeout(timer); resolve(t); } };
                const timer = setTimeout(() => { waiters.delete(w); reject(new Error(`timeout ${timeoutMs} ms, tail: ${JSON.stringify(tail.slice(-300))}`)); }, timeoutMs);
                waiters.add(w);
                if(check(w)) { waiters.delete(w); w.resolve(performance.now()); }
            });
        },
    };
}

async function timedRun(io, send, cmd, seq) {
    const from = io.total();
    const sentAt = performance.now();
    const seen = io.wait(new RegExp(`\\nDONE_${seq}\\r?\\n`), from, RUN_TIMEOUT_MS);
    send(`${cmd}; echo DONE_${seq}\n`);
    const seenAt = await seen;
    await io.wait(PROMPT_RE, from, RUN_TIMEOUT_MS);
    return seenAt - sentAt;
}

async function runGuestTests(io, send, runs) {
    let seq = 0;
    for(const [name, cmd] of TESTS) for(let run = 1; run <= RUNS; run++) {
        seq += 1;
        runs.push({ test: name, run, ms: Math.round(await timedRun(io, send, cmd, seq)) });
    }
}

function runHostTests() {
    const runs = [];
    for(const [name, cmd] of TESTS) {
        const shell = name === "T1" ? "sh" : "bash";
        for(let run = 1; run <= RUNS; run++) {
            const started = performance.now();
            const done = spawnSync(shell, ["-c", cmd], { stdio: "ignore", timeout: RUN_TIMEOUT_MS });
            runs.push({ test: name, run, ms: Math.round(performance.now() - started), shell, status: done.status });
        }
    }
    return runs;
}

async function bootNpm(io) {
    const { V86 } = await import(pathToFileURL(V86_NPM).href);
    const emulator = new V86({
        wasm_path: ROOT + "node_modules/v86/build/v86.wasm", memory_size: 64 << 20, bios: { url: IMAGES + "seabios.bin" }, vga_bios: { url: IMAGES + "vgabios.bin" },
        bzimage: { url: BZIMAGE, async: false }, filesystem: {}, cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
        autostart: true, disable_keyboard: true,
    });
    emulator.add_listener("serial0-output-byte", byte => io.feed(String.fromCharCode(byte)));
    return { send: text => emulator.serial0_send(text), close: () => {} };
}

function bootQemu(accel, io) {
    const child = spawn("qemu-system-i386", ["-accel", accel, "-m", "64", "-kernel", BZIMAGE, "-append", "console=ttyS0 tsc=reliable", "-nographic", "-no-reboot", "-net", "none"], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];
    child.stdout.on("data", chunk => io.feed(chunk.toString("latin1")));
    child.stderr.on("data", chunk => stderr.push(chunk.toString()));
    child.stdin.on("error", err => stderr.push(`stdin: ${err.message}`));
    child.on("exit", code => stderr.push(`exit ${code}`));
    return { send: text => child.stdin.write(text), close: () => child.kill(), stderr: () => stderr.join("").slice(-2000) };
}

// Our core: create_machine in record mode from the boot snapshot; input as one line, as in the npm variant.
async function bootOurs(io, report, snap_every_ms, cfg) {
    const { create_machine } = await import(ROOT + "app/core/engine.mjs");
    const { decode_snapshot } = await import(ROOT + "app/core/snapfile.mjs");
    const { host_nan } = await import(ROOT + "app/core/host_nan.mjs");
    const { FORMAT } = await import(ROOT + "app/core/journal.mjs");
    const { PROFILES, boot_snapshot_path, fresh_session_input } = await import(ROOT + "app/profiles.mjs");
    const snapshot = await decode_snapshot(new Uint8Array(fs.readFileSync(boot_snapshot_path(ROOT, "buildroot"))));
    const seed = 123456789, epoch = Math.floor(performance.timeOrigin + performance.now());
    const m = create_machine({ config: PROFILES.buildroot.config(ROOT), seed, epoch, snapshot, reseed: true, on_journal_end: "live", known_hashes: snapshot.hashes, check_every_ms: 10000, snap_every_ms });
    const decoder = new TextDecoder();
    m.on("serial", bytes => io.feed(decoder.decode(bytes, { stream: true })));
    m.on("snapshot", () => { report.snapshots_taken = (report.snapshots_taken ?? 0) + 1; });
    m.on("error", message => { report.error = message; });
    await m.ready;
    m.type(fresh_session_input());
    report.engine = m;
    report.write_journal = () => {
        const header = { format: FORMAT, profile: "buildroot", machine: "bench", seed, epoch: snapshot.clock.epoch, recorded_at: new Date().toISOString(), rate0: m.rate0, host_nan: host_nan(),
            start: { snapshot: "buildroot-boot", digest: snapshot.clock.ram }, parent: null };
        fs.writeFileSync(`${OUT_DIR}/${cfg}.journal.json`, JSON.stringify({ header, events: m.events }));
    };
    return { send: text => m.type(text), close: () => {}, counters: () => ({ instr: m.instructions(), vtime: m.vtime() }) };
}

async function runReplay(report, source) {
    const file = `${OUT_DIR}/${source}.journal.json`;
    const out = spawnSync("node", [BENCH_DIR + "/replay-node.mjs", file], { encoding: "utf8" });
    const r = JSON.parse(out.stdout.trim().split("\n").pop());
    Object.assign(report, { replay: r });
}

async function main() {
    const [cfg, flag] = process.argv.slice(2);
    const probe = flag === "--probe";
    const report = { config: cfg, probe, uptime_before: execSync("uptime").toString().trim(), runs: [] };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if(cfg === "host") report.runs = runHostTests();
    else if(cfg === "replay" || cfg === "replay-snap") await runReplay(report, cfg === "replay" ? "ours" : "ours-snap");
    else {
        const io = createSerial();
        const bootStart = performance.now();
        const driver = cfg === "npm" ? await bootNpm(io) : cfg === "tcg" || cfg === "kvm" ? bootQemu(cfg, io) : await bootOurs(io, report, cfg === "ours-snap" ? 15000 : 0, cfg);
        try {
            await io.wait(PROMPT_RE, 0, BOOT_TIMEOUT_MS);
            report.boot_ms = Math.round(performance.now() - bootStart);
            const before = driver.counters?.();
            const runStart = performance.now();
            await runGuestTests(io, driver.send, report.runs);
            if(probe) report.runs = report.runs.slice(0, 1);
            report.run_wall_ms = Math.round(performance.now() - runStart);
            if(before) {
                const after = driver.counters();
                report.instructions = after.instr - before.instr;
                report.vtime_ms = Math.round(after.vtime - before.vtime);
                report.instr_per_ms = Math.round(report.instructions / report.run_wall_ms);
            }
            if(report.engine) {
                await report.engine.check();
                report.events = report.engine.events.length;
                report.write_journal();
            }
        } catch(err) { report.error = err.message; }
        finally { if(driver.stderr) report.qemu_stderr = driver.stderr(); driver.close(); }
        delete report.engine; delete report.write_journal;
    }
    fs.writeFileSync(`${OUT_DIR}/${cfg}${probe ? "-probe" : ""}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exit(report.error ? 1 : 0);
}
main();
