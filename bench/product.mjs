// C and D on the product: the demo server + Chromium over CDP, student student10. A fresh Chromium (empty profile) for
// each scenario.
// Measures: opening a task -> live terminal -> shell prompt; rollback (last command, middle one, "До початку");
// RSS/PSS of the Chromium process tree on an empty page, on the app page and after the machines start (+3 s and +40 s).
// Run: node bench/product.mjs <out.json> [comma-separated scenarios: spa,config,study,link,net6]
// BENCH_REUSE=<dir with db.sqlite and journals/> skips demo:reset.
import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "server/dist/server/src");
const PORT = 8093;
const CDP_PORT = 9343;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STUDENT = { login: "student10", password: "student-demo" };
const TEACHER = { login: "teacher", password: "teacher-demo" };
const out_path = process.argv[2];
const wanted = (process.argv[3] ?? "spa,config,study,link,net6").split(",");

async function wait_for(fn, limit_ms, pause_ms, what) {
    const began = Date.now();
    for(;;) {
        try { const v = await fn(); if(v) return v; } catch { /* not ready yet */ }
        if(Date.now() - began > limit_ms) throw new Error("timeout: " + what);
        await sleep(pause_ms);
    }
}
async function api(method, path, body, cookie) {
    const res = await fetch(BASE + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if(!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return { json: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}
function connect(url) {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if(msg.id && waiting.has(msg.id)) { const { done, fail } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? fail(new Error("CDP: " + msg.error.message)) : done(msg.result); } };
    return new Promise(r => { ws.onopen = () => r({ send: (method, params = {}) => new Promise((done, fail) => { const n = ++id; waiting.set(n, { done, fail }); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() }); });
}
function rss_tree(root_pid) {
    const rows = execSync("ps -e -o pid=,ppid=,rss=,comm=", { encoding: "utf8" }).trim().split("\n").map(l => l.trim().split(/\s+/));
    const kids = new Map();
    for(const [pid, ppid, rss, comm] of rows) { if(!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push({ pid, rss: Number(rss), comm }); }
    const found = [];
    const walk = pid => { for(const k of kids.get(String(pid)) ?? []) { found.push(k); walk(k.pid); } };
    const self = rows.find(r => r[0] === String(root_pid));
    if(self) found.push({ pid: self[0], rss: Number(self[2]), comm: self[3] });
    walk(root_pid);
    let pss = 0;
    for(const p of found) { try { pss += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8"))?.[1] ?? 0); } catch { /* gone */ } }
    return { rss_mb: Math.round(found.reduce((a, p) => a + p.rss, 0) / 1024), pss_mb: Math.round(pss / 1024), processes: found.length };
}

async function launch_browser() {
    const profile = mkdtempSync(join(tmpdir(), "laplace-bench-cdp-"));
    const child = spawn("chromium-browser", ["--headless=new", "--disable-features=BackForwardCache", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
    const first = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 20000, 250, "chromium");
    const cdp = await connect(first.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    const page = {
        evaluate,
        exists: sel => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`),
        count: sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
        open: url => cdp.send("Page.navigate", { url }),
        console_tail: () => evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '').split("\\n").map(l => l.trim()).filter(Boolean).slice(-3).join("|")`),
        at_prompt: async () => /[#$%]$/.test(((await page.console_tail()).split("|").at(-1)) ?? ""),
        click: async sel => {
            const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!p) throw new Error("no element " + sel);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
        },
        type_line: async text => {
            await evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            for(const ch of text) { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); }
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
    };
    const close = async () => { try { cdp.close(); } catch { /* already closed */ } child.kill("SIGTERM"); await sleep(1500); try { child.kill("SIGKILL"); } catch { /* gone */ } rmSync(profile, { recursive: true, force: true }); };
    return { child, page, close };
}

async function sample_at(child, label, after_ms, since) {
    const wait = since + after_ms - Date.now();
    if(wait > 0) await sleep(wait);
    return { label, ...rss_tree(child.pid) };
}

async function scenario(name, ctx) {
    const { child, page, close } = await launch_browser();
    const result = { name, samples: [] };
    try {
        result.samples.push(await sample_at(child, "about:blank +3s", 3000, Date.now()));
        await page.open(`${BASE}/login`);
        await wait_for(async () => (await page.evaluate("location.origin")) === BASE && (await page.evaluate("document.readyState")) === "complete", 30000, 100, "login page");
        await page.evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ login: ctx.logins[name] ?? STUDENT.login, password: STUDENT.password }))} }).then(r => r.status)`);
        if(name === "spa") {
            const t0 = Date.now();
            await page.open(`${BASE}/`);
            await sleep(500);
            result.samples.push(await sample_at(child, "spa +3s", 3000, t0), await sample_at(child, "spa +40s", 40000, t0));
            return result;
        }
        const assignment = ctx.assignments[name];
        result.assignment = assignment.title;
        result.machines = ctx.machines[name];
        const t0 = Date.now();
        await page.open(`${BASE}/assignments/${assignment.id}`);
        const tiles = result.machines;
        if(tiles > 1) {
            await wait_for(async () => (await page.count('[data-testid="machine-tile"][data-state="live"]')) === tiles, 240000, 50, "live tiles");
            result.tiles_live_ms = Date.now() - t0;
        }
        await wait_for(() => page.exists('[data-testid="terminal"][data-state="live"]'), 240000, 50, "live terminal");
        result.terminal_live_ms = Date.now() - t0;
        await wait_for(() => page.at_prompt(), 240000, 50, "prompt");
        result.prompt_ms = Date.now() - t0;
        const t_prompt = Date.now();
        result.samples.push(await sample_at(child, "prompt +3s", 3000, t_prompt));
        if(ctx.rollback.includes(name)) result.rollback = await rollback_run(page, result);
        result.samples.push(await sample_at(child, "prompt +40s", 40000, t_prompt));
    }
    catch(e) { result.error = String(e.message ?? e); try { result.tail = await page.console_tail(); } catch { /* the page is gone */ } }
    finally { await close(); }
    return result;
}

// Three commands (the second one long, so that 15 s snapshots pile up), then a rollback to the last command, the middle
// one and "До початку".
async function rollback_run(page, result) {
    const log = [];
    const run = async text => {
        const before = await page.console_tail();
        await page.type_line(text);
        await wait_for(async () => (await page.at_prompt()) && (await page.console_tail()) !== before, 240000, 50, "prompt after " + text);
        await sleep(300);
    };
    await run("echo first");
    await run("seq 1 200000 | sort -n | md5sum");
    await sleep(17000);
    await run("echo last");
    await sleep(1000);
    await page.click('[data-testid="rollback-open"]');
    await wait_for(() => page.exists('[data-testid="rollback-option"]'), 10000, 100, "rollback options");
    const options = await page.evaluate(`[...document.querySelectorAll('[data-testid="rollback-option"]')].map(el => ({ index: el.getAttribute("data-index"), text: el.textContent }))`);
    result.rollback_options = options;
    const pick = [["last command", options.at(-1)], ["middle command", options[Math.floor(options.length / 2)]], ["start", options[0]]];
    for(const [label, option] of pick) {
        if(!(await page.exists('[data-testid="rollback-option"]'))) { await page.click('[data-testid="rollback-open"]'); await wait_for(() => page.exists('[data-testid="rollback-option"]'), 10000, 100, "rollback options"); }
        const t0 = Date.now();
        await page.click(`[data-testid="rollback-option"][data-index="${option.index}"]`);
        let busy_seen = null;
        for(let i = 0; i < 400 && busy_seen === null; i++) { if(await page.exists('[data-testid="rollback-open"][aria-busy="true"]')) busy_seen = Date.now() - t0; else await sleep(10); }
        await wait_for(async () => !(await page.exists('[data-testid="rollback-open"][aria-busy="true"]')), 240000, 25, "rollback busy to end");
        const branch_ms = busy_seen === null ? null : Date.now() - t0;
        await wait_for(() => page.at_prompt(), 240000, 25, "prompt after rollback");
        log.push({ label, index: option.index, text: option.text, busy_seen_ms: busy_seen, busy_end_ms: branch_ms, prompt_ms: Date.now() - t0 });
        await sleep(500);
    }
    return log;
}

const reuse = process.env.BENCH_REUSE;
const dir = reuse ?? mkdtempSync(join(tmpdir(), "laplace-bench-demo-"));
const env = { ...process.env, PORT: String(PORT), LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") };
let server = null;
const stop_server = () => { if(server) { try { process.kill(-server.pid); } catch { /* gone */ } } };
process.on("SIGINT", () => { stop_server(); process.exit(130); });
const all = { started: new Date().toISOString(), dir, uptime: execSync("uptime").toString().trim(), scenarios: [] };
try {
    if(!reuse) {
        const t = Date.now();
        const reset = spawnSync("node", [join(DIST, "demo/reset.js")], { cwd: ROOT, env, encoding: "utf8" });
        all.reset_ms = Date.now() - t;
        if(reset.status !== 0) throw new Error("demo:reset: " + reset.stderr.slice(-500));
    }
    server = spawn("node", [join(DIST, "main.js")], { cwd: ROOT, env, stdio: "ignore", detached: true });
    await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 60000, 250, "server");
    const teacher = (await api("POST", "/api/auth/login", TEACHER)).cookie;
    const classes = (await api("GET", "/api/classes", null, teacher)).json;
    const details = [];
    for(const k of classes) details.push((await api("GET", `/api/classes/${k.id}`, null, teacher)).json);
    all.assignment_titles = details.flatMap(d => d.assignments.map(a => `${d.name}: ${a.title}`));
    const by_title = prefix => details.flatMap(d => d.assignments.map(a => ({ ...a, class_id: d.id }))).find(a => a.title.startsWith(prefix));
    const assignments = { config: by_title("Налаштування"), study: by_title("Програма на C"), link: by_title("Зв"), net6: by_title("Мережа") };
    const machines = { config: 1, study: 1, link: 2, net6: 6 };
    for(const [k, a] of Object.entries(assignments)) if(!a) all.missing = [...(all.missing ?? []), k];
    const logins = {};
    all.student_progress = {};
    for(const [k, a] of Object.entries(assignments)) {
        if(!a) continue;
        const rows = (await api("GET", `/api/assignments/${a.id}/students`, null, teacher)).json;
        const idle = rows.find(r => r.status === "idle");
        const member = details.find(d => d.id === a.class_id).members.find(m => m.user_id === idle?.user_id);
        logins[k] = member?.login;
        all.student_progress[k] = idle ? { login: member?.login, user_id: idle.user_id, status: idle.status } : null;
    }
    const ctx = { assignments, machines, logins, rollback: process.env.NOROLLBACK ? [] : ["config", "study", "link"] };
    for(const name of wanted) {
        if(name !== "spa" && !assignments[name]) { all.scenarios.push({ name, error: "no such assignment in the demo database" }); continue; }
        console.log("scenario", name, new Date().toISOString());
        all.scenarios.push(await scenario(name, ctx));
        writeFileSync(out_path, JSON.stringify(all, null, 1));
    }
}
catch(e) { all.error = String(e.message ?? e); console.log("FAIL", all.error); }
finally { stop_server(); writeFileSync(out_path, JSON.stringify(all, null, 1)); }
