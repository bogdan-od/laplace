// Browser test of machine.mjs: headless Chromium through CDP, static files served by python3 -m http.server.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env.PORT || 8731);
const CDP_PORT = 9333;
const PAGE_URL = `http://127.0.0.1:${PORT}/app/test/browser/machine.html`;
const STEPS = [
    ["1. replay br1.json to end", "step1"],
    ["2. seek(5000), then end", "step2"],
    ["3. new session: echo hello, check, journal", "step3"],
    ["4. replay of the journal from step 3", "step4"],
    ["5. br1 with snap_every_ms 1000 and MAX_SNAPSHOTS 4: to end, seek(3000), to end again", "step5"],
];

const STEP_TIMEOUT_MS = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wait_for(fn, tries, pause_ms) {
    for(let i = 0; i < tries; i++) {
        try { const value = await fn(); if(value) return value; }
        catch {}
        await sleep(pause_ms);
    }
    throw new Error("readiness never came");
}

function connect(url) {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if(msg.id && waiting.has(msg.id)) {
            const { done, fail } = waiting.get(msg.id);
            waiting.delete(msg.id);
            if(msg.error) fail(new Error(`CDP: ${msg.error.message}`)); else done(msg.result);
            return;
        }
        if(msg.method === "Log.entryAdded") console.log("LOG", msg.params.entry.level, msg.params.entry.text?.slice(0, 300));
        if(msg.method === "Inspector.targetCrashed") console.log("CRASH tab crashed");
        if(msg.method === "Runtime.exceptionThrown") console.log("EXC", msg.params.exceptionDetails.exception?.description?.slice(0, 300));
        if(msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
            console.log("ERR", JSON.stringify(msg.params.args.map(a => a.value ?? a.description)).slice(0, 300));
    };
    return new Promise(r => { ws.onopen = () => r({
        send: (method, params = {}) => new Promise((done, fail) => { const n = ++id; waiting.set(n, { done, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
        close: () => ws.close(),
    }); });
}

async function run_step(cdp, title, fn) {
    const began = Date.now();
    let timer;
    const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`step did not finish within ${STEP_TIMEOUT_MS / 1000} с`)), STEP_TIMEOUT_MS); });
    const reply = await Promise.race([cdp.send("Runtime.evaluate", { expression: `h.${fn}()`, awaitPromise: true, returnByValue: true }), timeout])
        .catch(e => ({ result: { value: { ok: false, error: e.message } } }))
        .finally(() => clearTimeout(timer));
    if(!reply.result?.value?.ok) console.log("STAGE", (await cdp.send("Runtime.evaluate", { expression: "h.stage + ' errors=' + JSON.stringify(h.errors)", returnByValue: true }).catch(e => e.message))?.result?.value);
    const wall = Date.now() - began;
    const value = reply.result?.value ?? { ok: false, error: reply.exceptionDetails?.exception?.description ?? "evaluate" };
    console.log(`${value.ok ? "PASS" : "FAIL"} ${title} (${wall} ms)`, JSON.stringify(value));
    return value.ok;
}

async function main() {
    const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
    const profile = mkdtempSync(join(tmpdir(), "machine-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    let all_ok = true;
    try {
        await wait_for(async () => (await fetch(PAGE_URL)).ok, 50, 200);
        const target = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 50, 200);
        const cdp = await connect(target.webSocketDebuggerUrl);
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Page.navigate", { url: PAGE_URL });
        await wait_for(async () => (await cdp.send("Runtime.evaluate", { expression: "typeof h" })).result.value === "object", 100, 200);
        for(const [title, fn] of STEPS) all_ok = (await run_step(cdp, title, fn)) && all_ok;
        cdp.close();
    }
    finally {
        await close_browser(chrome, CDP_PORT);
        server.kill();
        await remove_profile(profile);
    }
    console.log(all_ok ? "RESULT: all steps PASS" : "RESULT: there is a FAIL");
    process.exitCode = all_ok ? 0 : 1;
}

main();
