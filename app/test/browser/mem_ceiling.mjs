// A measurement, not a test (not part of `node --test`): does the snapshot memory ceiling SNAPSHOT_BYTES_MAX hold on a
// live Alpine.
// A loop in the guest keeps rewriting files in 9p (/root) and in tmpfs; every SAMPLE_S seconds the lab console reports
// machine.bytes and the memory of the tab process (renderer RSS from /proc + JSHeapUsedSize from CDP).
// Then a rollback to the remaining snapshots and a check. Run: node app/test/browser/mem_ceiling.mjs
// Variables: MAX_MIN (25), SAMPLE_S (60), EXTRA_SAMPLES (2, how many samples to take after reaching the ceiling).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start_server } from "../../server.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8103;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const MAX_MIN = Number(process.env.MAX_MIN ?? 25);
const SAMPLE_S = Number(process.env.SAMPLE_S ?? 60);
const EXTRA_SAMPLES = Number(process.env.EXTRA_SAMPLES ?? 2);
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 300;
const MS_PER_S = 1000;
const S_PER_MIN = 60;
const MIB = 2 ** 20;
const KIB = 1024;
const LIMIT_MB = 384;
const NEAR_LIMIT = 0.9;
const GUEST_LOAD = "mkdir -p /dev/shm; (i=0; while :; do i=$((i+1)); n=$((i%20)); "
    + "dd if=/dev/urandom of=/root/w$n bs=64k count=32 2>/dev/null; cp /root/w$n /root/c$n; "
    + "dd if=/dev/urandom of=/dev/shm/m$((i%30)) bs=64k count=16 2>/dev/null; done) &";
const ENTER_KEY_CODE = 13;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, check, limit_ms = WAIT_MS) {
    const deadline = Date.now() + limit_ms;
    while(Date.now() < deadline) {
        const value = await check();
        if(value) return value;
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}`);
}

// window.machine is hooked on assignment: the guest output log and the fit_bytes counters
// (dropped snapshots, peak size before dropping).
const PAGE_HOOKS = `
    let hooked = null;
    Object.defineProperty(window, "machine", { configurable: true, get: () => hooked, set: value => {
        hooked = value;
        window.out = "";
        window.__drops = 0;
        window.__peak = 0;
        value.on("serial", bytes => { window.out = (window.out + new TextDecoder().decode(bytes)).slice(-4000); });
        const fit = value.fit_bytes.bind(value);
        value.fit_bytes = () => {
            const before = value.snaps.length;
            window.__peak = Math.max(window.__peak, value.bytes_size());
            fit();
            window.__drops += Math.max(0, before - value.snaps.length);
        };
    } });
`;

async function open_tab(path) {
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    const pending = new Map();
    let last_id = 0;
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if(message.method === "Runtime.exceptionThrown") console.log("EXC", message.params.exceptionDetails.exception?.description ?? "");
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    };
    const send = (method, params = {}) => new Promise(resolve => {
        last_id += 1;
        pending.set(last_id, resolve);
        ws.send(JSON.stringify({ id: last_id, method, params }));
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Performance.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS });
    await send("Page.navigate", { url: BASE + path });
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${target.id}`);
    const evaluate = async expression => {
        const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if(!reply.result) throw new Error(`eval: ${JSON.stringify(reply.error)}`);
        if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
        return reply.result.result.value;
    };
    return { send, evaluate };
}

async function type_line(tab, text) {
    await tab.evaluate("document.querySelector('.xterm-helper-textarea')?.focus(); true");
    await tab.send("Input.insertText", { text });
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE, text: "\r" };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE });
}

// Sum of the RSS of this Chromium's renderer processes (the Worker with the emulator lives in the same process as the
// tab).
function renderer_rss_mb(profile) {
    let kib = 0;
    for(const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
            if(!cmd.includes(profile) || !cmd.includes("--type=renderer")) continue;
            kib += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
        } catch { /* the process went away between readdir and read */ }
    }
    return Math.round(kib / KIB);
}

async function js_heap_mb(tab) {
    const reply = await tab.send("Performance.getMetrics");
    const metric = reply.result.metrics.find(item => item.name === "JSHeapUsedSize");
    return Math.round((metric?.value ?? 0) / MIB);
}

// The expression to evaluate plus the drop counters and the peak.
const STATS = `(() => { let n = 0; for (const b of machine.bytes.values()) n += b.byteLength;
    return { snaps: machine.snaps.length, chunks: machine.bytes.size, mb: Math.round(n / 2**20),
        peak_mb: Math.round(window.__peak / 2**20), drops: window.__drops, vt: Math.round((machine.status?.vtime ?? 0) / 1000) } })()`;

async function sample(tab, profile, started) {
    const stats = await tab.evaluate(STATS);
    const row = { min: ((Date.now() - started) / MS_PER_S / S_PER_MIN).toFixed(1), ...stats, rss_mb: renderer_rss_mb(profile), js_heap_mb: await js_heap_mb(tab) };
    console.log(`${row.min} min: snaps ${row.snaps}, chunks ${row.chunks}, mb ${row.mb} (peak ${row.peak_mb}), dropped ${row.drops}, vt ${row.vt} s, tab RSS ${row.rss_mb} MB, JS heap ${row.js_heap_mb} МБ`);
    return row;
}

function at_ceiling(rows) {
    const [prev, last] = rows.slice(-2);
    if(!prev || last.drops === 0) return false;
    return last.peak_mb >= LIMIT_MB * NEAR_LIMIT && last.snaps <= prev.snaps;
}

// After the rollback the journal is cut, so the targets for the next one are found again from the snapshots that are
// left.
const rollback_targets = {
    "точно на знімок": snaps => snaps[Math.floor(snaps.length / 2)],
    "між знімками": snaps => Math.round((snaps[0] + snaps[1]) / 2),
};

async function check_rollbacks(tab) {
    const err = () => tab.evaluate("document.getElementById('err').textContent");
    const results = [];
    for(const [label, pick] of Object.entries(rollback_targets)) {
        const snaps = await tab.evaluate("machine.snaps.map(s => s.next)");
        const index = pick(snaps);
        const began = Date.now();
        await tab.evaluate(`machine.rollback(${index})`);
        await wait_for("machine live after the rollback", () => tab.evaluate("document.getElementById('mode').textContent === 'жива'"));
        const before = await tab.evaluate("machine.journal().then(j => j.events.filter(e => e.t === 'check').length)");
        await tab.evaluate("machine.check(); true");
        await wait_for("new check event in the journal", () => tab.evaluate(`machine.journal().then(j => j.events.filter(e => e.t === 'check').length > ${before})`));
        const error = await err();
        if(error) throw new Error(`after the rollback to ${index}: #err «${error}»`);
        if(await tab.evaluate("machine.failed")) throw new Error(`after the rollback to ${index}: machine.failed`);
        const events = await tab.evaluate("machine.journal().then(j => j.events.length)");
        results.push(`відкат ${label} (подія ${index}, snapshots before the rollback ${JSON.stringify(snaps)}): ${(Date.now() - began) / MS_PER_S} s, machine live, check added, no errors, events in the journal ${events}`);
    }
    return results;
}

async function main() {
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "mem-ceiling-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        const tab = await open_tab("lab.html?profile=alpine&relay=off&name=mem");
        await wait_for("machine live", async () => { try { return await tab.evaluate("typeof machine === 'object' && document.getElementById('mode').textContent === 'жива'"); } catch { return false; } });
        await wait_for("prompt", async () => (await tab.evaluate("window.out")).length > 0);
        await type_line(tab, GUEST_LOAD);
        const started = Date.now();
        console.log(`load starts in the guest, limit ${LIMIT_MB} MB, sample every ${SAMPLE_S} s, at most ${MAX_MIN} min`);
        const rows = [await sample(tab, profile, started)];
        let extra = 0;
        while((Date.now() - started) / MS_PER_S / S_PER_MIN < MAX_MIN && extra <= EXTRA_SAMPLES) {
            await sleep(SAMPLE_S * MS_PER_S);
            rows.push(await sample(tab, profile, started));
            if(extra > 0 || at_ceiling(rows)) extra += 1;
        }
        console.log(extra > 0 ? "ceiling reached, snapshots are dropped" : "ceiling NOT reached in the allotted time");
        console.log("| min | snaps | chunks | mb | peak mb | dropped | vt, s | tab RSS, MB | JS heap, MB | |---|---|---|---|---|---|---|---|---|");
        for(const r of rows) console.log(`| ${r.min} | ${r.snaps} | ${r.chunks} | ${r.mb} | ${r.peak_mb} | ${r.drops} | ${r.vt} | ${r.rss_mb} | ${r.js_heap_mb} |`);
        const top = Math.max(...rows.map(r => r.peak_mb));
        console.log(`maximum peak of machine.bytes ${top} MB with the limit ${LIMIT_MB} МБ`);
        for(const line of await check_rollbacks(tab)) console.log(line);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
