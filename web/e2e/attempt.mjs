// A student's attempt in a real browser. Built server (temporary DB) + dev `vite` + one headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Scenario: the teacher makes a subject with one buildroot machine and gives it to a class; a student joins and opens
// /dev/attempt/<id>: live terminal -> `echo attempt-ok` -> autosave -> reload -> restore -> rollback "До початку" -> submit.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE_PORT = 5175;
const CDP_PORT = 9336;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("attempt-shots");
const WIDTH = 1280;
const HEIGHT = 1000;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot or replay
const FINAL_VERIFY = ["queued", "running", "ok", "failed", "tail_unchecked", "timeout"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wait_for(fn, tries, pause_ms, what) {
    for(let i = 0; i < tries; i++) {
        try { const value = await fn(); if(value) return value; } catch { /* not ready yet */ }
        await sleep(pause_ms);
    }
    throw new Error(`timeout waiting for ${what}`);
}

async function call(method, path, body, cookie) {
    const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if(!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    const set = res.headers.get("set-cookie");
    return { json: text ? JSON.parse(text) : null, cookie: set ? set.split(";")[0] : null };
}

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач ATT", login: "teacher-attempt", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-ATT", subject: "Операційні системи" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = await call("POST", "/api/library", { kind: "task", title: "ATT: echo", brief: "echo attempt-ok", topology }, teacher.cookie);
    const assignment = await call("POST", `/api/library/${item.json.id}/assign`, { class_id: klass.json.id, due_at: null, max_grade: 100, shared_lan: false }, teacher.cookie);
    const student = await call("POST", "/api/auth/register", { name: "Студент ATT", login: "student-attempt", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    return { assignmentId: assignment.json.id, studentCookie: student.cookie };
}

function connect(url) {
    const ws = new WebSocket(url);
    const waiting = new Map();
    const listeners = [];
    let id = 0;
    ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if(msg.id && waiting.has(msg.id)) {
            const { done, fail } = waiting.get(msg.id);
            waiting.delete(msg.id);
            if(msg.error) fail(new Error(`CDP: ${msg.error.message}`)); else done(msg.result);
        } else for(const fn of listeners) fn(msg);
    };
    return new Promise(r => { ws.onopen = () => r({
        send: (method, params = {}) => new Promise((done, fail) => { const n = ++id; waiting.set(n, { done, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
        on: fn => listeners.push(fn),
        close: () => ws.close(),
    }); });
}

function report_page_problems(msg) {
    if(msg.method === "Runtime.exceptionThrown") {
        console.log("EXCEPTION", msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
    } else if(msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
        console.log(`CONSOLE.${msg.params.type}`, msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 400));
    } else if(msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        console.log("LOG.error", msg.params.entry.text, msg.params.entry.url ?? "");
    }
}

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "attempt-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "attempt-cdp-"));
    const children = [];
    const spawn_child = (cmd, args, options) => { const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...options }); children.push(child); return child; };
    let chrome = null;
    let cdp = null;
    const stop_children = () => { for(const child of children) { try { process.kill(-child.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_children(); process.exit(130); });

    try {
        spawn_child("node", ["server/dist/server/src/main.js"], {
            cwd: ROOT, env: { ...process.env, LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") },
        });
        spawn_child("node", [join(ROOT, "web/node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web") });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 80, 250, "server behind the vite proxy");

        const { assignmentId, studentCookie } = await seed();
        console.log("seeded: assignment", assignmentId);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const target = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 80, 250, "chromium");
        cdp = await connect(target.webSocketDebuggerUrl);
        cdp.on(report_page_problems);
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Page.enable");
        await cdp.send("Network.enable");
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

        const sid = studentCookie.split("=");
        await cdp.send("Network.setCookie", { name: sid[0], value: sid.slice(1).join("="), url: BASE, httpOnly: true, sameSite: "Lax" });

        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
        const wait_selector = (selector, tries = 120) => wait_for(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), tries, 250, `selector ${selector}`);
        // Console text as xterm draws it (the DOM renderer keeps the rows in .xterm-rows).
        const console_lines = async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim());
        const wait_state = state => wait_selector(`[data-testid="machine-state"][data-state="${state}"]`, BOOT_TRIES);
        const wait_prompt = () => wait_for(async () => { const lines = (await console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
        const shot = async name => {
            await sleep(400);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
            console.log("saved", join(OUT, `${name}.png`));
        };
        const type_line = async text => {
            await evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            for(const ch of text) {
                await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
                await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
            }
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        };
        const attempt_now = async () => (await call("GET", `/api/assignments/${assignmentId}/attempt`, undefined, studentCookie)).json;
        const has_line = async text => (await console_lines()).includes(text);

        // 1. a new attempt: the terminal gets live, the command is typed and answered
        await cdp.send("Page.navigate", { url: `${BASE}/dev/attempt/${assignmentId}` });
        await wait_selector('[data-testid="terminal"]');
        await shot("1-starting");
        await wait_state("live");
        await wait_prompt();
        await type_line("echo attempt-ok");
        await wait_for(() => has_line("attempt-ok"), 120, 250, "the answer attempt-ok in the console");
        console.log("typed: attempt-ok is in the console");

        // 2. autosave
        const saved = await wait_for(async () => {
            const attempt = await attempt_now();
            return attempt.branches.some(branch => branch.event_count > 0) ? attempt : null;
        }, 60, 500, "autosave (event_count > 0)");
        console.log("autosaved: branches", saved.branches.map(b => `${b.id}:${b.kind}:${b.event_count}`).join(" "));
        await wait_for(async () => (await evaluate(`document.querySelector('[data-testid="save-status"]')?.dataset.status`)) === "saved", 40, 250, "save status saved");
        await shot("2-before-reload");

        // 3. reload: restore from the head journal, attempt-ok comes back
        await cdp.send("Page.reload");
        await wait_selector('[data-testid="machine-state"]', 240);
        await shot("3-restoring");
        await wait_state("live");
        await wait_for(() => has_line("attempt-ok"), 120, 250, "attempt-ok after the restore");
        const restored = await attempt_now();
        if(restored.branches.length !== saved.branches.length) throw new Error(`restore opened a branch: ${saved.branches.length} -> ${restored.branches.length}`);
        console.log("restored: attempt-ok is back, no new branch");
        await shot("4-after-reload");

        // 4. rollback to the start
        await evaluate(`document.querySelector('[data-testid="rollback-open"]').click()`);
        await wait_selector('[data-testid="rollback-option"][data-index="0"]');
        await evaluate(`document.querySelector('[data-testid="rollback-option"][data-index="0"]').click()`);
        await wait_selector('[data-testid="branch"][data-kind="rollback"]', 240);
        await wait_state("live");
        await wait_for(async () => !(await evaluate(`!!document.querySelector('[data-testid="busy"]')`)), 120, 250, "rollback to finish");
        if(await has_line("attempt-ok")) throw new Error("attempt-ok is still in the console after the rollback to the start");
        console.log("rolled back: tree has a rollback branch, console is clean");
        await shot("5-after-rollback");

        // 5. submit
        await evaluate(`document.querySelector('[data-testid="submit"]').click()`);
        await wait_selector('[data-testid="submitted"]', 240);
        const status = await evaluate(`document.querySelector('[data-testid="submitted"]').dataset.status`);
        if(!FINAL_VERIFY.includes(status)) throw new Error(`unexpected verify status ${status}`);
        console.log("submitted: verify_status =", status);
        await shot("6-submitted");
        console.log("RESULT: DONE");
    }
    finally {
        cdp?.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_children();
        await remove_profile(profile);
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch(error => { console.log("RESULT: FAIL", error); process.exitCode = 1; });
