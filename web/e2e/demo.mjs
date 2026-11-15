// The product from one command, without Vite. `demo:reset` into a temporary folder, the built server
// serving web/dist on port 8091, headless Chromium over CDP: the teacher's class (14 students), /review, a graded
// submission, a reload by a direct address (SPA fallback), a JSON 404 under /api, the student's "Мої завдання".
// Needs: cd server && npm run build; cd web && npx vite build. Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8091 (server), 9341 (CDP).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_DIST = join(ROOT, "server/dist/server/src");
const PORT = 8091;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = out_dir("demo-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
let failure_hook = null;

async function wait_for(fn, tries, pause_ms, what) {
    for(let i = 0; i < tries; i++) {
        try { const value = await fn(); if(value) return value; } catch { /* not ready yet */ }
        await sleep(pause_ms);
    }
    throw new Error(`timeout waiting for ${what}`);
}

async function api(method, path, body, cookie) {
    const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if(!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return { json: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
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

async function step(name, job) {
    try {
        const detail = await job();
        results.push(`ok   ${name}${detail ? `: ${detail}` : ""}`);
    } catch(error) {
        results.push(`FAIL ${name}: ${error.message}`);
        await failure_hook?.();
        throw error;
    }
}

async function page_driver(cdp) {
    cdp.on(report_page_problems);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
    const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    return {
        evaluate, exists,
        open: url => cdp.send("Page.navigate", { url }),
        wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
        text_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
        value_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ""`),
        count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
        shot: async name => {
            await sleep(700);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        },
        fill: (selector, text) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`),
        click: async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
    };
}

async function main() {
    if(!existsSync(join(SERVER_DIST, "main.js")) || !existsSync(join(ROOT, "web/dist/index.html"))) {
        console.log("Build first: cd server && npm run build; cd web && npx vite build");
        process.exitCode = 1;
        return;
    }
    // E2E_REUSE=<folder with db.sqlite and journals/>: skip the reset and use that data (to debug the page steps quickly).
    const reuse = process.env.E2E_REUSE;
    const dir = reuse ?? mkdtempSync(join(tmpdir(), "demo-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "demo-cdp-"));
    const env = { ...process.env, PORT: String(PORT), LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") };
    let server = null;
    let chrome = null;
    let cdp = null;
    const stop_server = () => { if(server) { try { process.kill(-server.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_server(); process.exit(130); });

    try {
        const reset = reuse ? { status: 0, stdout: "reset skipped (E2E_REUSE)", stderr: "" } : spawnSync("node", [join(SERVER_DIST, "demo/reset.js")], { cwd: ROOT, env, encoding: "utf8" });
        console.log(reset.stdout.split("\n").slice(-6).join("\n"));
        if(reset.status !== 0) throw new Error(`demo:reset failed: ${reset.stderr.slice(-500)}`);
        server = spawn("node", [join(SERVER_DIST, "main.js")], { cwd: ROOT, env, stdio: "ignore", detached: true });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 120, 250, "the server");

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        cdp = await connect(first.webSocketDebuggerUrl);
        const page = await page_driver(cdp);
        failure_hook = async () => {
            await page.shot("99-failure");
            console.log("PAGE", await page.evaluate("location.href"), JSON.stringify((await page.evaluate("document.body.innerText")).slice(0, 600)));
        };
        const sign_in = async (login, password) => {
            await page.open(`${BASE}/login`);
            await page.wait_selector('input[autocomplete="username"]');
            await page.fill('input[autocomplete="username"]', login);
            await page.fill('input[type="password"]', password);
            await page.click('form button[type="submit"]');
            await wait_for(async () => (await page.evaluate("location.pathname")) !== "/login", 80, 250, `leaving /login as ${login}`);
        };

        const teacher_cookie = (await api("POST", "/api/auth/login", { login: "teacher", password: "teacher-demo" })).cookie;
        const klass = (await api("GET", "/api/classes", null, teacher_cookie)).json[0];
        const class_page = `${BASE}/classes/${klass.id}`;
        let class_snapshot = "";

        await step("1 teacher signs in; the class page shows 14 students", async () => {
            await sign_in("teacher", "teacher-demo");
            await page.open(class_page);
            await page.wait_selector('[data-testid="student-tile"]');
            await sleep(500);
            const rows = await page.count('[data-testid="student-tile"]');
            const header = await page.text_of('[data-testid="class-students"]');
            if(rows !== 14 || !header.includes("14")) throw new Error(`rows ${rows}, header '${header}'`);
            class_snapshot = `${rows} rows, header '${header}'`;
            await page.shot("01-class");
            return `${klass.name}: ${class_snapshot}`;
        });

        await step("2 /review is not empty and has submissions and help requests", async () => {
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            await sleep(500);
            const rows = await page.evaluate(`[...document.querySelectorAll('[data-testid="review-row"]')].map(el => el.dataset.kind + ":" + (el.querySelector('[data-testid="review-verify"]')?.dataset.verify ?? "-"))`);
            const kinds = new Set(rows.map(row => row.split(":")[0]));
            if(rows.length < 5 || !kinds.has("help") || !kinds.has("submission")) throw new Error(`rows ${rows.join(",")}`);
            const states = await page.evaluate(`[...document.querySelectorAll('[data-testid="review-verify"]')].map(el => el.textContent.trim())`);
            const results = new Set(states.filter(text => /^Перевірки \d+\/\d+$/.test(text)));
            if(results.size < 2) throw new Error(`the 'Стан' column has fewer than two different 'Перевірки N/M': ${JSON.stringify(states)}`);
            await page.shot("02-review");
            const counts = {};
            for(const row of rows) counts[row] = (counts[row] ?? 0) + 1;
            return `${rows.length} rows: ${JSON.stringify(counts)}; states ${[...results].sort().join(", ")}`;
        });

        await step("3 a graded submission opens with its grade and the check result", async () => {
            const detail = (await api("GET", `/api/classes/${klass.id}`, null, teacher_cookie)).json;
            const task = detail.assignments.find(a => a.title.startsWith("Налаштування"));
            const students = (await api("GET", `/api/assignments/${task.id}/students`, null, teacher_cookie)).json;
            const graded = students.find(s => s.latest_submission?.grade === 9);
            if(!graded) throw new Error("no student with grade 9");
            await page.open(`${class_page}/assignments/${task.id}/students/${graded.user_id}?submission=${graded.latest_submission.id}`);
            await page.wait_selector('[data-testid="grade-input"]');
            await wait_for(async () => (await page.value_of('[data-testid="grade-input"]')) === "9", 40, 250, "the saved grade");
            const note = await page.value_of('[data-testid="grade-note"]');
            const summary = await page.text_of('[data-testid="check-summary"]');
            await page.shot("03-graded");
            return `${graded.name}: grade 9, note '${note}', check summary '${summary}'`;
        });

        await step("4 a direct address /classes/<id> opens the same page after a reload (SPA fallback)", async () => {
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            await page.open(class_page);
            await page.wait_selector('[data-testid="student-tile"]');
            await sleep(500);
            const rows = await page.count('[data-testid="student-tile"]');
            const header = await page.text_of('[data-testid="class-students"]');
            const path = await page.evaluate("location.pathname");
            const now = `${rows} rows, header '${header}'`;
            if(now !== class_snapshot || path !== `/classes/${klass.id}`) throw new Error(`${now} at ${path}, before: ${class_snapshot}`);
            return `${path}: ${now}`;
        });

        await step("5 /api/nope is a JSON 404 and a missing asset is not the page", async () => {
            const nope = await fetch(`${BASE}/api/nope`);
            const type = nope.headers.get("content-type") ?? "";
            const body = await nope.json();
            const asset = await fetch(`${BASE}/assets/none.js`);
            const index = await fetch(BASE);
            const sample = (await index.text()).match(/\/assets\/[^"]+\.js/)?.[0];
            const cache = (await fetch(BASE + sample)).headers.get("cache-control");
            if(nope.status !== 404 || !type.includes("json") || asset.status !== 404 || !cache?.includes("immutable") || index.headers.get("cache-control") !== "no-cache") {
                throw new Error(`api ${nope.status} ${type}, asset ${asset.status}, ${sample} cache '${cache}'`);
            }
            return `/api/nope 404 ${type.split(";")[0]} ${JSON.stringify(body).slice(0, 80)}; ${sample} cache '${cache}'`;
        });

        await step("6 sign out; student01 sees 'Мої завдання' with due dates", async () => {
            await page.click('button[title="Вийти"]');
            await wait_for(async () => (await page.evaluate("location.pathname")) === "/login", 40, 250, "the login page");
            await sign_in("student01", "student-demo");
            await page.wait_selector('[data-testid="assignment-row"]');
            await sleep(500);
            const rows = await page.evaluate(`[...document.querySelectorAll('[data-testid="assignment-row"]')].map(el => el.innerText.replace(/\\s+/g, " "))`);
            if(rows.length < 4 || rows.some(row => row.includes("Без строку"))) throw new Error(`rows ${JSON.stringify(rows)}`);
            await page.shot("04-student-home");
            return rows.join(" | ");
        });
        console.log("RESULT: DONE");
    }
    finally {
        cdp?.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_server();
        await remove_profile(profile);
        if(!reuse) rmSync(dir, { recursive: true, force: true });
        console.log("\nSteps:");
        for(const line of results) console.log(line);
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
