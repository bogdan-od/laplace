// The submission panel on the teacher's page of one student (/classes/:cid/assignments/:aid/students/:uid
// ?submission=<id>) in a real browser. The submission is made through the API (a recorded buildroot journal in two
// chunks),
// so no browser machine is needed; the server replays it for the check and for "Запустити перевірку".
// Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const JOURNAL = JSON.parse(readFileSync(join(ROOT, "app/test/out/buildroot-1.json"), "utf8"));
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("submission-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const SERVER_WAIT_TRIES = 720; // x 250 ms = 3 min for the server to replay a machine
const DAY_MS = 86_400_000;
const FIRST_CHUNK_EVENTS = 120;
const CHUNK_PAUSE_MS = 1200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
const notes = [];

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

function report_page_problems(who) {
    return msg => {
        if(msg.method === "Runtime.exceptionThrown") {
            console.log(`EXCEPTION[${who}]`, msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
        } else if(msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
            console.log(`CONSOLE.${msg.params.type}[${who}]`, msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 400));
        } else if(msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
            console.log(`LOG.error[${who}]`, msg.params.entry.text, msg.params.entry.url ?? "");
        }
    };
}

// One line per step: ok / FAIL and what was checked. A failed step stops the run (the next ones depend on it).
async function step(name, job) {
    try {
        const detail = await job();
        results.push(`ok   ${name}${detail ? `: ${detail}` : ""}`);
    } catch(error) {
        results.push(`FAIL ${name}: ${error.message}`);
        throw error;
    }
}

// Everything one browser tab needs, over its own CDP connection.
async function page_driver(cdp, who) {
    cdp.on(report_page_problems(who));
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
    const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    const driver = {
        evaluate, exists,
        login_as: async cookie => {
            const [name, ...value] = cookie.split("=");
            await cdp.send("Network.setCookie", { name, value: value.join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        },
        open: url => cdp.send("Page.navigate", { url }),
        wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
        wait_gone: (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`),
        text_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
        value_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ""`),
        attr_of: (selector, name) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`),
        count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
        shot: async name => {
            await sleep(500);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        },
        // React tracks the value of a controlled field, so the native setter is used and then an `input` event.
        fill: (selector, text) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`),
        // A real mouse click on the element's centre.
        click: async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
    };
    return driver;
}

const TERMINAL_STATES = ["ok", "failed", "tail_unchecked", "timeout"];

// A class with a task of one buildroot machine and two check commands, one student who handed in a recorded session.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач sub", login: "teacher-sub", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-sub", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = (await call("POST", "/api/library", { kind: "task", title: "sub: виконайте echo", brief: "Виконайте команди з журналу.", topology }, teacher.cookie)).json.id;
    const checks = [{ node: "m1", title: "Привіт", command: "echo hi" }, { node: "m1", title: "Помилка", command: "false" }];
    await call("PATCH", `/api/library/${item}`, { checks }, teacher.cookie);
    const a1 = (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: Date.now() + 3 * DAY_MS, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: "Лисенко Тарас", login: "lysenko-sub", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    const attempt = (await call("POST", `/api/assignments/${a1}/attempt`, null, student.cookie)).json;
    const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: JOURNAL.header, make_head: true }, student.cookie)).json;
    // Two chunks with a pause between them: the server stamps each with its arrival time, which the growth chart draws.
    await call("PUT", `/api/branches/${branch.id}/events`, { from: 0, events: JOURNAL.events.slice(0, FIRST_CHUNK_EVENTS) }, student.cookie);
    await sleep(CHUNK_PAUSE_MS);
    await call("PUT", `/api/branches/${branch.id}/events`, { from: FIRST_CHUNK_EVENTS, events: JOURNAL.events.slice(FIRST_CHUNK_EVENTS) }, student.cookie);
    const head = { node: "m1", branch_id: branch.id, event_count: JOURNAL.events.length };
    const submission = (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [head] }, student.cookie)).json;
    return { teacherCookie: teacher.cookie, classId: klass.json.id, a1, studentId: student.json.id, submissionId: submission.id };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "submission-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "sub-cdp-"));
    const children = [];
    const spawn_child = (cmd, args, options) => { const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...options }); children.push(child); return child; };
    let chrome = null;
    const cdps = [];
    const stop_children = () => { for(const child of children) { try { process.kill(-child.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_children(); process.exit(130); });

    try {
        spawn_child("node", [SERVER_MAIN], {
            cwd: ROOT, env: { ...process.env, LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") },
        });
        spawn_child("node", [join(ROOT, "web/node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web") });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 80, 250, "server behind the vite proxy");

        const seeded = await seed();
        console.log("seeded: class", seeded.classId, "assignment", seeded.a1, "student", seeded.studentId, "submission", seeded.submissionId);
        const verified = await wait_for(async () => {
            const sub = (await call("GET", `/api/submissions/${seeded.submissionId}`, null, seeded.teacherCookie)).json;
            return TERMINAL_STATES.includes(sub.verify_status) ? sub : null;
        }, SERVER_WAIT_TRIES, 250, "the server's check of the journal");
        console.log("verify:", verified.verify_status, verified.verify_message ?? "", "commands", verified.commands_count);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(cdp);
        const teacher = await page_driver(cdp, "teacher");
        const student_page = `${BASE}/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}`;
        const panel_url = `${student_page}?submission=${seeded.submissionId}`;
        const PANEL = '[data-testid="submission-panel"]';

        await step("1 the panel opens: the check status, the growth chart, the row stays selected", async () => {
            await teacher.login_as(seeded.teacherCookie);
            await teacher.open(panel_url);
            await teacher.wait_selector(`${PANEL} [data-testid="growth-chart"]`);
            const status = await teacher.attr_of('[data-testid="verify-status"]', "data-verify");
            const text = await teacher.text_of('[data-testid="verify-status"]');
            const chunks = Number(await teacher.attr_of('[data-testid="growth-chart"]', "data-chunks"));
            const selected = await teacher.evaluate(`document.querySelector('[data-testid="submission-row"][data-submission="${seeded.submissionId}"]')?.className.includes("bg-primary")`);
            const note = await teacher.text_of('[data-testid="submission-players"]');
            if(status !== verified.verify_status) throw new Error(`status ${status}, server says ${verified.verify_status}`);
            if(chunks !== 2) throw new Error(`${chunks} chunks in the chart, expected 2`);
            if(!selected) throw new Error("the submission row is not highlighted");
            if(!note.includes("Відкрити запис")) throw new Error(`player links '${note}'`);
            await teacher.shot("01-panel");
            return `status ${status} (${JSON.stringify(text.split("\n")[0])}), ${chunks} chunks in the chart, row selected`;
        });

        await step("2 'Запустити перевірку': output of the commands arrives, then 'Пройдено 1 з 2'", async () => {
            const seen = new Set();
            let outputs = 0;
            const poll = setInterval(() => {
                teacher.evaluate(`[document.querySelector('[data-testid="check-section"]')?.dataset.runStatus ?? "", document.querySelectorAll('[data-testid="check-output"]').length]`)
                    .then(([status, count]) => { if(status) seen.add(status); outputs = Math.max(outputs, count); }, () => {});
            }, 100);
            try {
                await teacher.click('[data-testid="check-start"]');
                await wait_for(async () => (await teacher.attr_of('[data-testid="check-section"]', "data-run-status")) === "done", SERVER_WAIT_TRIES, 250, "the check run to finish");
            } finally { clearInterval(poll); }
            const summary = await teacher.text_of('[data-testid="check-summary"]');
            const items = await teacher.count('[data-testid="check-item"]');
            const body = await teacher.text_of('[data-testid="check-list"]');
            const label = await teacher.text_of('[data-testid="check-start"]');
            if(summary !== "Пройдено 1 з 2") throw new Error(`summary '${summary}'`);
            if(items !== 2 || !/\bhi\b/.test(body)) throw new Error(`items ${items}, list ${JSON.stringify(body)}`);
            if(!label.includes("ще раз")) throw new Error(`button '${label}'`);
            await teacher.shot("02-check-run");
            return `summary '${summary}'; statuses seen on the page: ${[...seen].join(" > ")}; button now '${label.trim()}'`;
        });

        await step("3 grade: errors, 'Прийняти', save 8 with a note, reload keeps both, the list shows 8/10", async () => {
            const suggested = (await teacher.text_of('[data-testid="grade-suggested"]')).replace(/\D+/g, "");
            await teacher.fill('[data-testid="grade-input"]', "11");
            await teacher.click('[data-testid="grade-save"]');
            await teacher.wait_selector('[data-testid="grade-error"]');
            const over = await teacher.text_of('[data-testid="grade-error"]');
            await teacher.fill('[data-testid="grade-input"]', "7,5");
            await teacher.click('[data-testid="grade-save"]');
            await wait_for(async () => (await teacher.text_of('[data-testid="grade-error"]')) === "Оцінка має бути цілим числом", 20, 100, "the fraction error");
            await teacher.click('[data-testid="grade-accept"]');
            const accepted = await teacher.value_of('[data-testid="grade-input"]');
            await teacher.wait_gone('[data-testid="grade-error"]', 3).catch(() => {});
            await teacher.fill('[data-testid="grade-input"]', "8");
            await teacher.fill('[data-testid="grade-note"]', "Добре, але команда false мала б пройти.\nДруга лінія.");
            await teacher.click('[data-testid="grade-save"]');
            await wait_for(async () => (await call("GET", `/api/submissions/${seeded.submissionId}`, null, seeded.teacherCookie)).json.grade === 8, 40, 250, "the grade on the server");
            await wait_for(async () => (await teacher.text_of(`[data-testid="submission-row"][data-submission="${seeded.submissionId}"]`)).includes("8/10"), 40, 250, "8/10 in the list");
            await teacher.open(panel_url);
            await teacher.wait_selector('[data-testid="grade-input"]');
            await wait_for(async () => (await teacher.value_of('[data-testid="grade-input"]')) === "8", 40, 250, "the saved grade after reload");
            const note = await teacher.value_of('[data-testid="grade-note"]');
            const row = await teacher.text_of(`[data-testid="submission-row"][data-submission="${seeded.submissionId}"]`);
            if(over !== "Оцінка не може перевищувати 10") throw new Error(`over-limit text '${over}'`);
            if(accepted !== suggested) throw new Error(`accepted '${accepted}', suggested '${suggested}'`);
            if(note !== "Добре, але команда false мала б пройти.\nДруга лінія.") throw new Error(`note ${JSON.stringify(note)}`);
            if(!row.includes("8/10")) throw new Error(`row '${row}'`);
            await teacher.shot("03-graded");
            return `over-limit text ok; 'Прийняти' put ${accepted} (suggested ${suggested}); after reload grade 8, 2-line note, list row '${row.replace(/\n/g, " ")}'`;
        });

        await step("4 'Зробити урок': the notice with a library link, the item is a lesson", async () => {
            await teacher.click('[data-testid="make-lesson"]');
            await teacher.wait_selector('[data-testid="lesson-created"]');
            const text = await teacher.text_of('[data-testid="lesson-created"]');
            const href = await teacher.evaluate(`document.querySelector('[data-testid="lesson-created"] a')?.getAttribute("href")`);
            const id = Number(href?.split("/").at(-1));
            const created = (await call("GET", `/api/library/${id}`, null, seeded.teacherCookie)).json;
            if(created.kind !== "lesson") throw new Error(`item ${id} is '${created.kind}'`);
            await teacher.shot("04-lesson");
            return `notice '${text}', link ${href}, library item kind ${created.kind}`;
        });

        await step("5 the page has no top bar and no menu; the × closes the panel; other pages keep the top bar", async () => {
            const bar = await teacher.exists(".h-screen > header");
            const menu = await teacher.evaluate(`document.querySelector(".h-screen main")?.previousElementSibling !== null`);
            if(bar || menu) throw new Error(`top bar ${bar}, menu ${menu}`);
            await teacher.shot("05-no-menu");
            await teacher.click('[data-testid="submission-close"]');
            await teacher.wait_gone(PANEL);
            const search = await teacher.evaluate("location.search");
            const rows = await teacher.count('[data-testid="submission-row"]');
            if(search !== "" || rows !== 1) throw new Error(`search '${search}', rows ${rows}`);
            await teacher.open(`${BASE}/classes/${seeded.classId}`);
            await teacher.wait_selector(".h-screen > header");
            return `no shell <header> and no sidebar on the student page; × removed ?submission (search '${search}'), the row stays; /classes/:id has <header>`;
        });
        console.log("RESULT: DONE");
    }
    finally {
        for(const cdp of cdps) cdp.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_children();
        await remove_profile(profile);
        rmSync(dir, { recursive: true, force: true });
        console.log("\nSteps:");
        for(const line of results) console.log(line);
        if(notes.length) { console.log("\nNotes:"); for(const line of notes) console.log(line); }
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
