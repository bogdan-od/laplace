// "На перевірку" (/review) and "Календар" (/calendar) of the teacher in a real browser, plus the topology scheme of
// a task page with two machines and a switch (where the switch label stands) and the width of a student terminal.
// Everything is seeded through the API (recorded buildroot journals, no live machine): a class, task A with two
// submissions
// (two students) and a due date on the 10th of this month, task B with one "не працює" request and a due date on the
// 20th.
// Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9342 (CDP).
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
const CDP_PORT = 9342;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("review-calendar-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const SERVER_WAIT_TRIES = 720; // x 250 ms = 3 min for the server to replay a machine
const SUBMITTED_EVENTS = 120;
const HELP_EVENT_COUNT = 60;
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
        // A screenshot of one element (its box plus a margin), for a close look at a detail.
        shot_of: async (selector, name) => {
            await sleep(500);
            const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 }; })()`);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
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
const TWO_MACHINES = {
    format: "v86-topology/1",
    machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }, { id: "m2", title: "Buildroot 2", profile: "buildroot" }],
    switches: [{ id: "sw1" }],
    links: [{ machine: "m1", switch: "sw1", mode: "access", vlan: 1 }, { machine: "m2", switch: "sw1", mode: "access", vlan: 1 }],
};
const ONE_MACHINE = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
const TITLE_A = "review: перше завдання";
const TITLE_B = "review: друге завдання";
const GUEST_COLS = 80;
const TERMINAL_FONT_PX = 15;

const pad = n => String(n).padStart(2, "0");
const month_key = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const day_key = date => `${month_key(date)}-${pad(date.getDate())}`;

// Task A: two students submit. Task B: one student asks for help. Plus a task with two machines for the scheme.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач review", login: "teacher-review", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-review", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const task = async (title, topology = ONE_MACHINE) => (await call("POST", "/api/library", { kind: "task", title, brief: "Виконайте команди з журналу.", topology }, teacher.cookie)).json.id;
    const today = new Date();
    const due_a = new Date(today.getFullYear(), today.getMonth(), 10, 12, 0);
    const due_b = new Date(today.getFullYear(), today.getMonth(), 20, 18, 30);
    const assign = async (item, due) => (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: due.getTime(), max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const a = await assign(await task(TITLE_A), due_a);
    const b = await assign(await task(TITLE_B), due_b);
    const scheme_item = await task("review: схема з комутатором", TWO_MACHINES);
    const register = async (name, login) => call("POST", "/api/auth/register", { name, login, password: "password-2", role: "student", invite_code: klass.json.invite_code });
    const first = await register("Лисенко Тарас", "lysenko-review");
    const second = await register("Мельник Ірина", "melnyk-review");
    const record = async (student, assignment) => {
        const attempt = (await call("POST", `/api/assignments/${assignment}/attempt`, null, student.cookie)).json;
        const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: JOURNAL.header, make_head: true }, student.cookie)).json;
        await call("PUT", `/api/branches/${branch.id}/events`, { from: 0, events: JOURNAL.events.slice(0, SUBMITTED_EVENTS) }, student.cookie);
        return { attempt, branch };
    };
    const submit = async (student, { attempt, branch }) =>
        (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [{ node: "m1", branch_id: branch.id, event_count: SUBMITTED_EVENTS }] }, student.cookie)).json;
    const sub_first = await submit(first, await record(first, a));
    const sub_second = await submit(second, await record(second, a));
    const asked = await record(first, b);
    const help = (await call("POST", `/api/attempts/${asked.attempt.id}/help`, { node: "m1", branch_id: asked.branch.id, event_count: HELP_EVENT_COUNT, text: "Не працює uptime" }, first.cookie)).json;
    return {
        teacherCookie: teacher.cookie, classId: klass.json.id, a, b, schemeItem: scheme_item, due_a, due_b,
        submissions: [sub_first.id, sub_second.id], helpId: help.id, helpBranch: asked.branch.id,
    };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "review-calendar-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "review-cdp-"));
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
        const cookie = seeded.teacherCookie;
        console.log("seeded: class", seeded.classId, "tasks", seeded.a, seeded.b, "submissions", seeded.submissions.join(","), "help", seeded.helpId);
        for(const id of seeded.submissions) {
            await wait_for(async () => TERMINAL_STATES.includes((await call("GET", `/api/submissions/${id}`, null, cookie)).json.verify_status), SERVER_WAIT_TRIES, 250, `the check of submission ${id}`);
        }

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(cdp);
        const teacher = await page_driver(cdp, "teacher");
        const rows = () => teacher.evaluate(`[...document.querySelectorAll('[data-testid="review-row"]')].map(el => el.dataset.key)`);
        const menu_count = () => teacher.evaluate(`Number((document.querySelector('nav a[href="/review"]')?.innerText.match(/\\d+/) ?? ["0"])[0])`);
        const where = () => teacher.evaluate("location.pathname + location.search");
        const waiting_for = async (what, fn) => wait_for(async () => (await fn()) === true, 60, 250, what);

        await step("1 /review: two submissions and the request, newest first, the menu counts three", async () => {
            await teacher.login_as(cookie);
            await teacher.open(`${BASE}/review`);
            await teacher.wait_selector('[data-testid="review-row"]');
            const keys = await rows();
            const [sub_first, sub_second] = seeded.submissions;
            const expected = [`help-${seeded.helpId}`, `submission-${sub_second}`, `submission-${sub_first}`];
            if(keys.join() !== expected.join()) throw new Error(`rows ${keys.join()}, expected ${expected.join()}`);
            await waiting_for("the menu counter 3", async () => (await menu_count()) === 3);
            const statuses = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="review-verify"]')].map(el => el.dataset.verify + ': ' + el.innerText).join(' | ')`);
            const first_row = (await teacher.text_of('[data-testid="review-row"]')).replace(/\s+/g, " ");
            await teacher.shot("01-review");
            return `rows ${keys.join(", ")}; menu 3; verify ${statuses}; first row '${first_row}'`;
        });

        await step("2 the filter 'Не працює' leaves the request, 'Здачі' the two submissions, 'Усі' all three", async () => {
            await teacher.click('[data-testid="review-tab"][data-kind="help"]');
            await waiting_for("one row", async () => (await rows()).length === 1);
            const only = (await rows())[0];
            await teacher.click('[data-testid="review-tab"][data-kind="submission"]');
            await waiting_for("two rows", async () => (await rows()).length === 2);
            await teacher.click('[data-testid="review-tab"][data-kind="all"]');
            await waiting_for("three rows", async () => (await rows()).length === 3);
            if(only !== `help-${seeded.helpId}`) throw new Error(`the filter kept ${only}`);
            return `help filter: ${only}; submissions 2; all 3`;
        });

        await step("3 the request row opens the player at its moment with the reply (/play/branch-<id>?t=&reply=)", async () => {
            await teacher.click('[data-testid="review-row"][data-kind="help"] [data-testid="review-open"]');
            await wait_for(async () => (await where()).startsWith("/play/"), 80, 250, "the player address");
            const address = await where();
            const expected = new RegExp(`^/play/branch-${seeded.helpBranch}\\?t=\\d+&reply=${seeded.helpId}$`);
            if(!expected.test(address)) throw new Error(`address ${address}`);
            return address;
        });

        const day_a = `[data-testid="calendar-day"][data-day="${day_key(seeded.due_a)}"]`;
        const day_b = `[data-testid="calendar-day"][data-day="${day_key(seeded.due_b)}"]`;
        await step("4 /calendar: the due dates stand in their days, '2 чекають перевірки' at task A only; the entry leads to the class", async () => {
            await teacher.open(`${BASE}/calendar`);
            await teacher.wait_selector(`${day_a} [data-testid="calendar-entry"]`);
            await teacher.wait_selector(`${day_b} [data-testid="calendar-entry"]`);
            const a_text = (await teacher.text_of(`${day_a} [data-testid="calendar-entry"]`)).replace(/\s+/g, " ");
            const b_text = (await teacher.text_of(`${day_b} [data-testid="calendar-entry"]`)).replace(/\s+/g, " ");
            const total = await teacher.count('[data-testid="calendar-entry"]');
            const month = await teacher.attr_of('[data-testid="calendar-month"]', "data-month");
            if(!a_text.includes(TITLE_A) || !a_text.includes("КН-review") || !a_text.includes("12:00") || !a_text.includes("2 чекають перевірки")) throw new Error(`task A: '${a_text}'`);
            if(!b_text.includes(TITLE_B) || !b_text.includes("18:30") || b_text.includes("перевірки")) throw new Error(`task B: '${b_text}'`);
            if(total !== 2) throw new Error(`${total} entries in the month, expected 2`);
            if(month !== month_key(new Date())) throw new Error(`month ${month}`);
            await teacher.shot("02-calendar");
            await teacher.click(`${day_a} [data-testid="calendar-entry"]`);
            await wait_for(async () => (await where()).startsWith(`/classes/${seeded.classId}`), 40, 250, "the class page");
            await wait_for(async () => (await where()).includes(`a=${seeded.a}`), 40, 250, "?a= of the assignment");
            return `A: '${a_text}'; B: '${b_text}'; the entry opened ${await where()}`;
        });

        await step("5 '›' and '‹' change ?m=, 'Сьогодні' returns; the .ics answers 200 with BEGIN:VCALENDAR", async () => {
            const now = new Date();
            const next = month_key(new Date(now.getFullYear(), now.getMonth() + 1, 1));
            const previous = month_key(new Date(now.getFullYear(), now.getMonth() - 1, 1));
            await teacher.open(`${BASE}/calendar`);
            await teacher.wait_selector(`${day_a} [data-testid="calendar-entry"]`);
            await teacher.click('[data-testid="calendar-next"]');
            await waiting_for("?m= of the next month", async () => (await where()) === `/calendar?m=${next}`);
            await waiting_for("the grid of the next month", async () => (await teacher.attr_of('[data-testid="calendar-month"]', "data-month")) === next);
            const next_entries = await teacher.count('[data-testid="calendar-entry"]');
            await teacher.click('[data-testid="calendar-prev"]');
            await waiting_for("the grid of the current month", async () => (await teacher.attr_of('[data-testid="calendar-month"]', "data-month")) === month_key(now));
            await teacher.click('[data-testid="calendar-prev"]');
            await waiting_for("?m= of the previous month", async () => (await where()) === `/calendar?m=${previous}`);
            await teacher.click('[data-testid="calendar-today"]');
            await waiting_for("the current month again", async () => (await teacher.attr_of('[data-testid="calendar-month"]', "data-month")) === month_key(now) && (await where()) === "/calendar");
            await teacher.wait_selector(`${day_a} [data-testid="calendar-entry"]`);
            const href = await teacher.attr_of('[data-testid="calendar-ics"]', "href");
            const res = await fetch(`${BASE}${href}`, { headers: { cookie } });
            const text = await res.text();
            const disposition = res.headers.get("content-disposition");
            if(res.status !== 200 || !text.startsWith("BEGIN:VCALENDAR")) throw new Error(`ics ${res.status} '${text.slice(0, 40)}'`);
            if(!text.includes(TITLE_A)) throw new Error("the .ics has no task A");
            if(next_entries !== 0) throw new Error(`${next_entries} entries in the next month`);
            return `›: ?m=${next} (0 entries); ‹‹: ?m=${previous}; Сьогодні: /calendar; ${href} -> 200 ${res.headers.get("content-type")}, ${disposition}, ${text.split("\r\n").filter(l => l === "BEGIN:VEVENT").length} events`;
        });

        await step("6 the topology block of a task with two machines and a switch: where the switch label stands; the terminal width", async () => {
            await teacher.open(`${BASE}/library/${seeded.schemeItem}`);
            await wait_for(async () => (await teacher.count('[data-testid="diagram-machine"]')) === 2, 80, 250, "two machines on the scheme");
            await teacher.shot_of('[data-testid="topology-scheme"]', "03-topology-block");
            const geometry = await teacher.evaluate(`(() => {
                const group = [...document.querySelectorAll('[data-testid="diagram"] > g')].find(g => !g.dataset.testid && g.querySelector("text"));
                if(!group) return null;
                const rect = group.querySelector("rect").getBoundingClientRect();
                const texts = [...group.querySelectorAll("text")].map(t => { const b = t.getBoundingClientRect(); return { text: t.textContent, dx: Math.round((b.x + b.width / 2) - (rect.x + rect.width / 2)), dy: Math.round((b.y + b.height / 2) - (rect.y + rect.height / 2)) }; });
                return { rect: [Math.round(rect.width), Math.round(rect.height)], texts };
            })()`);
            if(!geometry) throw new Error("no switch box on the scheme");
            const probe = await teacher.evaluate(`(() => {
                const span = document.createElement("span");
                span.className = "font-mono";
                span.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:${TERMINAL_FONT_PX}px";
                span.textContent = "0".repeat(${GUEST_COLS});
                document.body.append(span);
                const width = span.getBoundingClientRect().width;
                span.remove();
                return width;
            })()`);
            notes.push(`switch box ${geometry.rect.join("x")} px; labels relative to the centre of the box (px): ${JSON.stringify(geometry.texts)}`);
            notes.push(`${GUEST_COLS} columns of the terminal font at ${TERMINAL_FONT_PX}px are ${probe.toFixed(1)} px wide (plus 16 px padding and a scrollbar); the student page column is 768 px`);
            return `switch labels ${JSON.stringify(geometry.texts)}; 80 columns = ${probe.toFixed(1)} px`;
        });

        const [graded_id] = seeded.submissions;
        await step("7 a click on a submission row opens the panel of the student", async () => {
            await teacher.open(`${BASE}/review`);
            await teacher.wait_selector('[data-testid="review-row"][data-kind="submission"] [data-testid="review-open"]');
            await waiting_for("the rows", async () => (await rows()).length === 3);
            await teacher.click(`[data-testid="review-row"][data-key="submission-${graded_id}"] [data-testid="review-open"]`);
            await teacher.wait_selector('[data-testid="submission-panel"]', 240);
            const address = await where();
            if(!address.endsWith(`/students/${(await call("GET", `/api/submissions/${graded_id}`, null, cookie)).json.student.id}?submission=${graded_id}`)) throw new Error(`address ${address}`);
            if(!address.startsWith(`/classes/${seeded.classId}/assignments/${seeded.a}/students/`)) throw new Error(`address ${address}`);
            await teacher.shot("04-panel");
            return address;
        });

        await step("8 a grade from the form: back on /review there is one row less and the menu counter dropped by one", async () => {
            await teacher.wait_selector('[data-testid="grade-input"]');
            await teacher.fill('[data-testid="grade-input"]', "7");
            await teacher.click('[data-testid="grade-save"]');
            await wait_for(async () => (await call("GET", `/api/submissions/${graded_id}`, null, cookie)).json.grade === 7, 40, 250, "the grade on the server");
            await teacher.evaluate("history.back()");
            await wait_for(async () => (await where()) === "/review", 40, 250, "the /review address");
            await waiting_for("two rows after the grade", async () => (await rows()).length === 2);
            await waiting_for("the menu counter 2", async () => (await menu_count()) === 2);
            const keys = await rows();
            if(keys.includes(`submission-${graded_id}`)) throw new Error(`the graded row is still there: ${keys.join()}`);
            await teacher.open(`${BASE}/calendar`);
            await teacher.wait_selector(`${day_a} [data-testid="calendar-entry"]`);
            const after = (await teacher.text_of(`${day_a} [data-testid="calendar-entry"]`)).replace(/\s+/g, " ");
            if(!after.includes("1 чекає перевірки")) throw new Error(`calendar after the grade: '${after}'`);
            return `rows ${keys.join(", ")}; menu 2 (no reload: history.back); the calendar says '${after}'`;
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
