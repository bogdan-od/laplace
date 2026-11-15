// The class sections on /classes/:id (students, activity log, grades, analytics view) in a real browser.
// All states are seeded through the API (no v86 machines); the browser is the teacher's only.
// Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5180 (vite), 9341 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { read_journal } from "../../app/core/journal.mjs";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const VITE_PORT = 5180;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("class-tabs-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const DAY_MS = 86_400_000;
const ACTIVITY_PAGE = 50;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];

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
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
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
        count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
        shot: async name => {
            await sleep(500);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        },
        // Radix opens menus on pointerdown, so a real mouse click is needed (element.click() is not enough).
        click: async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
        // Sets the value of a React-controlled input/textarea the way a user typing would.
        fill: (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`),
        press: async (key, code, vk) => {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
        },
    };
    return driver;
}

// A journal header the server accepts for a buildroot machine (the same recording the lesson check uses).
const START_HEADER = read_journal(JSON.parse(readFileSync(fileURLToPath(new URL("../../app/test/out/br1.json", import.meta.url)), "utf8"))).header;
delete START_HEADER.lesson;

const STUDENT_COUNT = 18;
const NAMES = ["Ткачук", "Бондаренко", "Шевченко", "Коваленко", "Мельник", "Олійник", "Лисенко", "Кравченко", "Бойко"];

// i % 4: 0 graded (both assignments are submitted, the first one graded), 1 submitted without a grade,
// 2 opened and working, 3 never opened.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач tabs", login: "teacher-tabs", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-tabs", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const subject = async title =>
        (await call("POST", "/api/library", { kind: "task", title, brief: "Виконайте echo.", topology }, teacher.cookie)).json.id;
    const assign = async (itemId, due_at) =>
        (await call("POST", `/api/library/${itemId}/assign`, { class_id: klass.json.id, due_at, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const a1 = await assign(await subject("tabs: перше завдання"), Date.now() + 3 * DAY_MS);
    const a2 = await assign(await subject("tabs: друге завдання"), Date.now() + 10 * DAY_MS);

    const open_and_submit = async (cookie, assignment, submit) => {
        const attempt = (await call("POST", `/api/assignments/${assignment}/attempt`, null, cookie)).json;
        const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: START_HEADER, make_head: true }, cookie)).json;
        if(!submit) return null;
        const heads = [{ node: "m1", branch_id: branch.id, event_count: 0 }];
        return (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads }, cookie)).json;
    };
    for(let i = 0; i < STUDENT_COUNT; i++) {
        const name = `${NAMES[i % NAMES.length]} ${String.fromCharCode(1040 + i)}.`;
        const registered = await call("POST", "/api/auth/register", { name, login: `st${i}-tabs`, password: "password-2", role: "student", invite_code: klass.json.invite_code });
        const state = i % 4;
        if(state === 3) continue;
        const first = await open_and_submit(registered.cookie, a1, state !== 2);
        if(state === 0) {
            await open_and_submit(registered.cookie, a2, true);
            await call("PUT", `/api/submissions/${first.id}/grade`, { grade: 5 + (i % 6), note: "" }, teacher.cookie);
        }
    }
    await call("POST", "/api/auth/register", { name: "Асистент Петренко", login: "assistant-tabs", password: "password-3", role: "teacher" });
    return { teacherCookie: teacher.cookie, classId: klass.json.id, a1, a2, assistantLogin: "assistant-tabs" };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "class-tabs-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "tabs-cdp-"));
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
        const seeded_activity = (await call("GET", `/api/classes/${seeded.classId}/activity`, null, seeded.teacherCookie)).json.length;
        console.log("seeded: class", seeded.classId, "assignments", seeded.a1, seeded.a2, "first activity page", seeded_activity);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(cdp);
        const teacher = await page_driver(cdp, "teacher");
        const browser = await connect((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl);
        cdps.push(browser);
        await browser.send("Browser.grantPermissions", { origin: BASE, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

        const students_label = () => teacher.text_of('[data-testid="class-students"]');
        const students_count = async () => Number.parseInt(await students_label(), 10);
        const member_logins = () => teacher.evaluate(`[...document.querySelectorAll('[data-testid="member-row"]')].map(el => el.children[2].innerText)`);
        const tab_url = tab => `${BASE}/classes/${seeded.classId}?a=${seeded.a1}&tab=${tab}`;
        let imported = [];
        let before_import = 0;

        await step("0 the seed: more than one page of the journal", async () => {
            if(seeded_activity !== ACTIVITY_PAGE) throw new Error(`the first page has ${seeded_activity} rows, expected ${ACTIVITY_PAGE}`);
            return `first page ${seeded_activity} rows`;
        });

        await step("1 'Імпорт з CSV': a file fills the field; three students are imported, passwords are shown once", async () => {
            await teacher.login_as(seeded.teacherCookie);
            await teacher.open(tab_url("students"));
            await teacher.wait_selector('[data-testid="member-row"]');
            await wait_for(async () => (await teacher.count('[data-testid="member-row"]')) === STUDENT_COUNT, 40, 250, `${STUDENT_COUNT} member rows`);
            before_import = await students_count();
            if(before_import !== STUDENT_COUNT) throw new Error(`header shows ${before_import}`);
            await teacher.click('[data-testid="import-open"]');
            await teacher.wait_selector('[data-testid="import-text"]');
            const csv_path = join(dir, "students.csv");
            writeFileSync(csv_path, "ПІБ;логін\n");
            const { root } = await cdp.send("DOM.getDocument");
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="import-file"]' });
            await cdp.send("DOM.setFileInputFiles", { files: [csv_path], nodeId });
            await wait_for(async () => (await teacher.evaluate(`document.querySelector('[data-testid="import-text"]').value`)).startsWith("ПІБ;логін"), 40, 250, "the file text in the field");
            await teacher.fill('[data-testid="import-text"]', "ПІБ;логін\nМаксименко Олена\n\nГончар Тарас;honchar-tabs\nСидоренко Ірина");
            await teacher.click('[data-testid="import-submit"]');
            await teacher.wait_selector('[data-testid="import-table"]');
            const rows = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="import-row"]')].map(tr => [...tr.children].map(td => td.innerText))`);
            if(rows.length !== 3) throw new Error(`rows ${JSON.stringify(rows)}`);
            if(!rows.every(row => /^[A-Z2-9]{10}$/.test(row[2]))) throw new Error(`passwords ${JSON.stringify(rows)}`);
            if(!rows.some(row => row[1] === "honchar-tabs")) throw new Error(`the given login is missing: ${JSON.stringify(rows)}`);
            const warning = await teacher.text_of('[data-testid="import-warning"]');
            if(!warning.includes("більше не відображатимуться")) throw new Error(`warning '${warning}'`);
            imported = rows;
            await teacher.shot("01-import-result");
            await teacher.click('[data-testid="import-copy"]');
            const clipboard = await wait_for(() => teacher.evaluate("navigator.clipboard.readText()"), 20, 250, "clipboard text");
            const expected = rows.map(row => row.join("\t")).join("\n");
            if(clipboard !== expected) throw new Error(`clipboard ${JSON.stringify(clipboard)} != ${JSON.stringify(expected)}`);
            return `3 rows ${rows.map(row => row[1]).join(", ")}; the password regexp holds; "Скопіювати все" put ${clipboard.split("\n").length} tab-separated lines on the clipboard`;
        });

        await step("2 the student list shows the new students; an assistant is added and gets its own group", async () => {
            await teacher.click('[data-testid="import-done"]');
            await teacher.wait_gone('[data-testid="import-dialog"]');
            await wait_for(async () => (await students_count()) === before_import + 3, 40, 250, "the header count +3");
            await teacher.click('[data-testid="assistant-open"]');
            await teacher.wait_selector('[data-testid="assistant-login"]');
            await teacher.fill('[data-testid="assistant-login"]', "no-such-user-tabs");
            await teacher.click('[data-testid="assistant-submit"]');
            const error = await wait_for(() => teacher.text_of('[data-testid="assistant-dialog"] .text-destructive'), 40, 250, "the error text for an unknown login");
            await teacher.fill('[data-testid="assistant-login"]', seeded.assistantLogin);
            await teacher.click('[data-testid="assistant-submit"]');
            await teacher.wait_gone('[data-testid="assistant-dialog"]');
            await wait_for(async () => (await teacher.count('[data-testid="member-row"][data-role="assistant"]')) === 1, 40, 250, "the assistant row");
            const logins = await member_logins();
            for(const row of imported) if(!logins.includes(row[1])) throw new Error(`${row[1]} is not in the list`);
            const total = await teacher.count('[data-testid="member-row"]');
            if(total !== STUDENT_COUNT + 3 + 1) throw new Error(`${total} rows`);
            const assistant_first = await teacher.evaluate(`document.querySelector('[data-testid="member-row"]').dataset.role`);
            if(assistant_first !== "assistant") throw new Error("the assistants are not the first group");
            await teacher.shot("02-students");
            return `${total} rows (${STUDENT_COUNT} + 3 imported + 1 assistant, assistants first); unknown login answered ${JSON.stringify(error)}`;
        });

        await step("3 deleting an imported student: confirmation, the row is gone, the header shows one less", async () => {
            const victim = imported[0][1];
            await teacher.evaluate(`window.__victim = [...document.querySelectorAll('[data-testid="member-row"]')].find(tr => tr.children[2].innerText === ${JSON.stringify(victim)}).dataset.member`);
            const id = await teacher.evaluate("window.__victim");
            // The menu is shot on the first row (an assistant), far from the page bottom and the toast, then closed.
            await teacher.click('[data-testid="member-row"] [data-testid="member-menu"]');
            await teacher.wait_selector('[data-testid="member-remove"]');
            await teacher.shot("03-member-menu");
            await teacher.press("Escape", "Escape", 27);
            await teacher.wait_gone('[data-testid="member-remove"]');
            await teacher.click(`[data-testid="member-row"][data-member="${id}"] [data-testid="member-menu"]`);
            await teacher.wait_selector('[data-testid="member-remove"]');
            await teacher.click('[data-testid="member-remove"]');
            await teacher.wait_selector('[data-testid="remove-dialog"] [data-testid="remove-confirm"]');
            const text = await teacher.text_of('[data-testid="remove-dialog"]');
            if(!text.includes(victim)) throw new Error(`the dialog does not name ${victim}: ${text}`);
            await teacher.click('[data-testid="remove-confirm"]');
            await teacher.wait_gone(`[data-testid="member-row"][data-member="${id}"]`);
            await wait_for(async () => (await students_count()) === before_import + 2, 40, 250, "the header count -1");
            return `${victim} removed; header '${await students_label()}'`;
        });

        await step("4 'Журнал дій': joins and submissions, 'Показати ще' adds the next page", async () => {
            await teacher.open(tab_url("activity"));
            await teacher.wait_selector('[data-testid="activity-row"]');
            await wait_for(async () => (await teacher.count('[data-testid="activity-row"]')) === ACTIVITY_PAGE, 40, 250, "the first page");
            await teacher.wait_selector('[data-testid="activity-more"]');
            await teacher.click('[data-testid="activity-more"]');
            const total = await wait_for(async () => { const n = await teacher.count('[data-testid="activity-row"]'); return n > ACTIVITY_PAGE && n; }, 40, 250, "more rows");
            await wait_for(async () => !(await teacher.exists('[data-testid="activity-more"]')), 40, 250, "the button to go away on the last page");
            const kinds = await teacher.evaluate(`[...new Set([...document.querySelectorAll('[data-testid="activity-row"]')].map(el => el.dataset.kind))]`);
            for(const kind of ["member_joined", "submitted"]) if(!kinds.includes(kind)) throw new Error(`no '${kind}' row, kinds ${kinds}`);
            const sample = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="activity-row"]')].slice(0, 3).map(el => el.innerText.replace(/\\s+/g, " ")).join(" | ")`);
            await teacher.evaluate(`document.querySelector('[data-testid="class-header"]').scrollIntoView()`);
            await teacher.shot("03-activity");
            return `${ACTIVITY_PAGE} -> ${total} rows, kinds ${kinds.join(",")}; top: ${sample}`;
        });

        await step("5 'Оцінки': a grade, 'здано' and empty cells; the CSV link returns a file with a BOM", async () => {
            await teacher.open(tab_url("grades"));
            await teacher.wait_selector('[data-testid="grade-cell"]');
            await wait_for(async () => (await teacher.count('[data-testid="grade-row"]')) === STUDENT_COUNT + 2, 40, 250, "all student rows");
            const kinds = await teacher.evaluate(`Object.fromEntries(["graded","submitted","none"].map(k => [k, document.querySelectorAll('[data-testid="grade-cell"][data-cell="' + k + '"]').length]))`);
            if(!kinds.graded || !kinds.submitted || !kinds.none) throw new Error(`cells ${JSON.stringify(kinds)}`);
            const submitted_text = await teacher.evaluate(`document.querySelector('[data-testid="grade-cell"][data-cell="submitted"]').innerText.trim()`);
            const graded_text = await teacher.evaluate(`document.querySelector('[data-testid="grade-cell"][data-cell="graded"]').innerText.trim()`);
            if(submitted_text !== "здано" || !/^\d+\/10$/.test(graded_text)) throw new Error(`texts '${submitted_text}' '${graded_text}'`);
            const link = await teacher.evaluate(`(() => { const a = document.querySelector('[data-testid="grades-export"]'); return { href: a.getAttribute("href"), download: a.hasAttribute("download") }; })()`);
            if(!link.download || link.href !== `/api/classes/${seeded.classId}/grades.csv`) throw new Error(`link ${JSON.stringify(link)}`);
            const head = await teacher.evaluate(`fetch(${JSON.stringify(link.href)}, { credentials: "include" }).then(async r => ({ status: r.status, type: r.headers.get("content-type"), bytes: [...new Uint8Array(await r.arrayBuffer()).slice(0, 3)] }))`);
            if(head.status !== 200 || head.bytes.join(",") !== "239,187,191") throw new Error(`csv ${JSON.stringify(head)}`);
            await teacher.shot("04-grades");
            const href = await teacher.evaluate(`document.querySelector('[data-testid="grade-cell"] a').getAttribute("href")`);
            if(!/^\/classes\/\d+\/assignments\/\d+\/students\/\d+$/.test(href)) throw new Error(`cell link ${href}`);
            return `cells ${JSON.stringify(kinds)}; sample '${graded_text}' / '${submitted_text}'; csv ${head.status} ${head.type}, first bytes ${head.bytes.map(b => b.toString(16)).join(" ")}; cell link ${href}`;
        });

        await step("6 'Аналітика' of the assignment: numbers and bars", async () => {
            await teacher.open(`${BASE}/classes/${seeded.classId}?a=${seeded.a1}`);
            await teacher.wait_selector('[data-testid="view-analytics"]');
            // The brief arrives after the header and moves the toggle down: click again if the first click missed.
            await wait_for(async () => {
                await teacher.click('[data-testid="view-analytics"]');
                await sleep(400);
                return (await teacher.evaluate("location.search")).includes("view=analytics");
            }, 10, 100, "the click on 'Аналітика' to change the address");
            await teacher.wait_selector('[data-testid="analytics-view"]').catch(async error => {
                throw new Error(`${error.message}; address ${await teacher.evaluate("location.search")}, page: ${(await teacher.evaluate("document.body.innerText")).slice(0, 300).replace(/\\s+/g, " ")}`);
            });
            const search = await teacher.evaluate("location.search");
            if(!search.includes("view=analytics")) throw new Error(`address ${search}`);
            const server = (await call("GET", `/api/assignments/${seeded.a1}/analytics`, null, seeded.teacherCookie)).json;
            await wait_for(async () => (await teacher.count('[data-testid="an-row"], [data-testid="an-idle"] a')) === server.per_student.length, 40, 250, "table rows");
            const opened = await teacher.text_of('[data-testid="an-opened"]');
            const submitted = await teacher.text_of('[data-testid="an-submitted"]');
            const median = await teacher.text_of('[data-testid="an-median"]');
            const students = server.students;
            if(opened !== `${server.opened} з ${students}` || submitted !== `${server.submitted} з ${students}`) throw new Error(`numbers '${opened}' '${submitted}' vs server ${server.opened}/${server.submitted}/${students}`);
            const expected_opened = Math.ceil(STUDENT_COUNT * 3 / 4);
            if(server.opened !== expected_opened) throw new Error(`seeded ${expected_opened} opened, server ${server.opened}`);
            const bars = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="grade-bar"]')].map(el => +el.dataset.count)`);
            const graded = server.grades.reduce((sum, g) => sum + g.count, 0);
            if(bars.length !== 11 || bars.reduce((a, b) => a + b, 0) !== graded || graded < 1) throw new Error(`bars ${bars}, graded ${graded}`);
            const tallest = await teacher.evaluate(`Math.max(...[...document.querySelectorAll('[data-testid="grade-bar"] div')].map(el => el.getBoundingClientRect().height))`);
            if(!(tallest > 20)) throw new Error(`tallest bar ${tallest}px`);
            await teacher.shot("05-analytics");
            return `opened '${opened}', submitted '${submitted}', median '${median}', ${server.per_student.length} rows, bars [${bars}] (${graded} graded), tallest ${Math.round(tallest)}px`;
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
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
