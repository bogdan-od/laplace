// The teacher's class page (/classes/:id) in a real browser: tiles and table with live data, the freeze
// button, the invite QR, a new code, "check all", and issuing an assignment. One student works for real in a second
// browser context (its own cookies). Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
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
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("class-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot
const DAY_MS = 86_400_000;
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

// A journal header the server accepts for a buildroot machine (the same recording the lesson check uses).
const START_HEADER = read_journal(JSON.parse(readFileSync(fileURLToPath(new URL("../../app/test/out/br1.json", import.meta.url)), "utf8"))).header;
delete START_HEADER.lesson;

const STUDENTS = [
    { name: "Ткачук Мирослава", login: "tkachuk", state: "stuck" },
    { name: "Бондаренко Андрій", login: "bondarenko", state: "work" },
    { name: "Шевченко Олена", login: "shevchenko", state: "graded" },
    { name: "Коваленко Максим", login: "kovalenko", state: "done" },
    { name: "Мельник Софія", login: "melnyk", state: "idle" },
    { name: "Кравчук Дмитро", login: "kravchuk", state: "idle" },
    { name: "Олійник Вікторія", login: "oliinyk", state: "work" },
    { name: "Лисенко Тарас", login: "lysenko", state: "live" },
];

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач class", login: "teacher-class", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-class", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const subject = async (title, brief) =>
        (await call("POST", "/api/library", { kind: "task", title, brief, topology }, teacher.cookie)).json.id;
    const first = await subject("class: виконайте echo", "Виконайте echo class-live у терміналі.\nПотім здайте роботу.");
    await call("PATCH", `/api/library/${first}`, { checks: [{ node: "m1", title: "echo", command: "echo class" }] }, teacher.cookie);
    const second = await subject("class: друге завдання", "Перегляньте адреси інтерфейсів.");
    const third = await subject("class: третє з бібліотеки", "Видається з діалогу.");
    const assign = async (itemId, due_at) =>
        (await call("POST", `/api/library/${itemId}/assign`, { class_id: klass.json.id, due_at, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const a1 = await assign(first, Date.now() + 3 * DAY_MS);
    const a2 = await assign(second, Date.now() + 10 * DAY_MS);

    const cookies = {};
    for(const student of STUDENTS) {
        const registered = await call("POST", "/api/auth/register", { name: student.name, login: `${student.login}-class`, password: "password-2", role: "student", invite_code: klass.json.invite_code });
        cookies[student.login] = registered.cookie;
        if(student.state === "idle" || student.state === "live") continue;
        const attempt = (await call("POST", `/api/assignments/${a1}/attempt`, null, registered.cookie)).json;
        const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: START_HEADER, make_head: true }, registered.cookie)).json;
        const head = { node: "m1", branch_id: branch.id, event_count: 0 };
        if(student.state === "stuck") await call("POST", `/api/attempts/${attempt.id}/help`, { ...head, text: "Не проходить ping до сусіднього вузла" }, registered.cookie);
        if(student.state === "done" || student.state === "graded") {
            const submission = (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [head] }, registered.cookie)).json;
            if(student.state === "graded") await call("PUT", `/api/submissions/${submission.id}/grade`, { grade: 9, note: "Добре" }, teacher.cookie);
        }
    }
    return { teacherCookie: teacher.cookie, classId: klass.json.id, a1, a2, third, liveCookie: cookies.lysenko, inviteCode: klass.json.invite_code };
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
        press: async (key, code, vk) => {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
        },
        type_line: async text => {
            await evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            for(const ch of text) {
                await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
                await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
            }
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
    };
    driver.console_lines = async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim());
    driver.wait_prompt = () => wait_for(async () => { const lines = (await driver.console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
    return driver;
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "class-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "class-cdp-"));
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
        console.log("seeded: class", seeded.classId, "assignments", seeded.a1, seeded.a2);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const teacher_cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(teacher_cdp);
        const teacher = await page_driver(teacher_cdp, "teacher");

        // The student gets a separate browser context: its own cookies and its own tab.
        const browser = await connect((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl);
        cdps.push(browser);
        const { browserContextId } = await browser.send("Target.createBrowserContext");
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
        const student_target = await wait_for(async () => (await targets()).find(t => t.id === targetId), 40, 250, "the student's tab");
        const student_cdp = await connect(student_target.webSocketDebuggerUrl);
        cdps.push(student_cdp);
        const student = await page_driver(student_cdp, "student");

        const toast_text = () => teacher.evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].map(el => el.innerText).join(" | ")`);
        const picker_count = async () => {
            await teacher.click('[data-testid="assignment-picker"]');
            await teacher.wait_selector('[data-testid="assignment-option"]');
            const n = await teacher.count('[data-testid="assignment-option"]');
            await teacher.click('[data-testid="assignment-picker"]');
            return n;
        };
        const statuses = () => teacher.evaluate(`Object.fromEntries(["stuck","work","done","idle"].map(s => [s, +(document.querySelector('[data-count="' + s + '"] .font-semibold')?.textContent ?? -1)]))`);
        const tile_names = () => teacher.evaluate(`[...document.querySelectorAll('[data-testid="student-tile"] .font-medium')].map(el => el.textContent)`);
        let invite_code = seeded.inviteCode;

        await step("1 the teacher opens the class: ?a= is the nearest deadline, 8 tiles, counters by status", async () => {
            await teacher.login_as(seeded.teacherCookie);
            await teacher.open(`${BASE}/classes/${seeded.classId}`);
            await teacher.wait_selector('[data-testid="student-tile"]');
            await wait_for(async () => (await teacher.count('[data-testid="student-tile"]')) === 8, 40, 250, "8 tiles");
            await wait_for(async () => (await teacher.evaluate("location.search")).includes(`a=${seeded.a1}`), 40, 250, "?a= in the address");
            const counts = JSON.stringify(await statuses());
            if(counts !== JSON.stringify({ stuck: 1, work: 2, done: 2, idle: 3 })) throw new Error(`counters ${counts}`);
            const names = await tile_names();
            if(names[0] !== "Ткачук Мирослава") throw new Error(`the student who needs help is not first: ${names}`);
            const title = await teacher.text_of('[data-testid="assignment-title"]');
            if(title !== "class: виконайте echo") throw new Error(`title '${title}'`);
            await teacher.evaluate("window.__class_no_reload = true");
            await teacher.shot("01-tiles");
            return `title '${title}', counters ${counts}, first tile '${names[0]}', address ${await teacher.evaluate("location.search")}`;
        });

        await step("2 a student works in a second context: the tile shows `class-live` without a reload", async () => {
            await student.login_as(seeded.liveCookie);
            await student.open(`${BASE}/assignments/${seeded.a1}`);
            await student.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await student.wait_prompt();
            await student.type_line("echo class-live");
            await wait_for(async () => (await student.console_lines()).includes("class-live"), 120, 250, "the answer in the student's terminal");
            const lysenko = `[data-testid="student-tile"][data-status]`;
            await wait_for(async () => teacher.evaluate(`[...document.querySelectorAll(${JSON.stringify(lysenko)})].some(el => el.textContent.includes("Лисенко") && el.querySelector('[data-testid="tile-terminal"]')?.innerText.includes("class-live"))`), 120, 250, "class-live on the tile of Лисенко Тарас");
            const status = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="student-tile"]')].find(el => el.textContent.includes("Лисенко")).dataset.status`);
            const reloaded = !(await teacher.evaluate("window.__class_no_reload === true"));
            if(reloaded) throw new Error("the page was reloaded");
            if(status !== "work") throw new Error(`status of the live student: ${status}`);
            await teacher.shot("02-live-tile");
            return `tile of Лисенко Тарас: status ${status}, terminal shows class-live, no reload`;
        });

        await step("3 the table view: 8 rows, the help card in the aside, ?view=table", async () => {
            await teacher.click('[data-testid="view-table"]');
            await teacher.wait_selector('[data-testid="student-table"]');
            await wait_for(async () => (await teacher.count('[data-testid="student-row"]')) === 8, 40, 250, "8 rows");
            const help = await teacher.text_of('[data-testid="help-card"]');
            if(!help.includes("Ткачук Мирослава") || !help.includes("Не проходить ping")) throw new Error(`help card: ${JSON.stringify(help)}`);
            const search = await teacher.evaluate("location.search");
            if(!search.includes("view=table") || !search.includes(`a=${seeded.a1}`)) throw new Error(`address ${search}`);
            const grade = await teacher.evaluate(`[...document.querySelectorAll('[data-testid="student-row"]')].find(el => el.textContent.includes("Шевченко")).lastElementChild.innerText`);
            if(!grade.includes("9")) throw new Error(`grade cell of Шевченко: ${JSON.stringify(grade)}`);
            await teacher.shot("03-table");
            return `8 rows, help card of Ткачук Мирослава, grade '${grade.replace(/\s+/g, "")}', address ${search}`;
        });

        await step("4 'Заморозити всіх' freezes the student's screen, 'Розморозити' brings it back", async () => {
            await teacher.click('[data-testid="freeze"]');
            await wait_for(async () => (await teacher.text_of('[data-testid="freeze"]')).includes("Розморозити"), 40, 250, "the button to say 'Розморозити'");
            await student.wait_selector('[data-testid="terminal"][data-state="frozen"]', 40);
            await teacher.click('[data-testid="freeze"]');
            await wait_for(async () => (await teacher.text_of('[data-testid="freeze"]')).includes("Заморозити всіх"), 40, 250, "the button to say 'Заморозити всіх'");
            await student.wait_selector('[data-testid="terminal"][data-state="live"]', 40);
            return "student terminal: live -> frozen -> live, the button text follows";
        });

        await step("5 the QR dialog: the image and the link /join/<code>", async () => {
            await teacher.click('[data-testid="show-qr"]');
            await teacher.wait_selector('[data-testid="qr-image"]');
            const src = await teacher.evaluate(`document.querySelector('[data-testid="qr-image"]').src.slice(0, 22)`);
            const link = await teacher.text_of('[data-testid="qr-link"]');
            if(!src.startsWith("data:image/png") || !link.endsWith(`/join/${invite_code}`)) throw new Error(`src '${src}', link '${link}'`);
            await teacher.shot("04-qr");
            await teacher.press("Escape", "Escape", 27);
            await teacher.wait_gone('[data-testid="qr-dialog"]');
            return `link ${link}`;
        });

        await step("6 'Новий код': confirmation, then another code on the page", async () => {
            await teacher.click('[data-testid="new-code"]');
            await teacher.wait_selector('[data-testid="new-code-dialog"]');
            await teacher.click('[data-testid="new-code-confirm"]');
            await teacher.wait_gone('[data-testid="new-code-dialog"]');
            const shown = await wait_for(async () => { const code = await teacher.text_of('[data-testid="invite-code"]'); return code !== invite_code && code; }, 40, 250, "another invite code");
            const server = (await call("GET", `/api/classes/${seeded.classId}`, null, seeded.teacherCookie)).json.invite_code;
            if(server !== shown) throw new Error(`page shows ${shown}, server has ${server}`);
            const old = await fetch(`${BASE}/api/invites/${invite_code}`);
            if(old.ok) throw new Error("the old invite still works");
            invite_code = shown;
            return `code ${shown}; the old link answers ${old.status}`;
        });

        await step("7 'Перевірити всі здачі': toast 'У черзі: N'", async () => {
            await teacher.click('[data-testid="check-all"]');
            const text = await wait_for(async () => { const t = await toast_text(); return t.includes("У черзі:") && t; }, 40, 250, "the toast 'У черзі'");
            return text;
        });

        await step("8 'Видати завдання' issues a third subject: a tab appears and ?a= changes", async () => {
            const before = await teacher.evaluate("location.search");
            const tabs_before = await picker_count();
            await teacher.click('[data-testid="assign"]');
            await teacher.wait_selector('[data-testid="assign-item"]');
            await wait_for(async () => (await teacher.count('[data-testid="assign-item"] option')) >= 3, 40, 250, "library options");
            await teacher.evaluate(`(() => { const select = document.querySelector('[data-testid="assign-item"]'); const option = [...select.options].find(o => o.textContent.includes("третє")); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(select, option.value); select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
            await teacher.shot("05-assign-dialog");
            await teacher.click('[data-testid="assign-submit"]');
            await teacher.wait_gone('[data-testid="assign-dialog"]');
            await wait_for(async () => (await picker_count()) === tabs_before + 1, 40, 250, "a third option in the picker");
            const after = await teacher.evaluate("location.search");
            const title = await teacher.text_of('[data-testid="assignment-title"]');
            if(after === before || title !== "class: третє з бібліотеки") throw new Error(`address ${before} -> ${after}, title '${title}'`);
            const pressed = await teacher.text_of('[data-testid="assignment-picker-title"]');
            await teacher.shot("06-assigned");
            return `tabs ${tabs_before} -> ${tabs_before + 1}, address ${before} -> ${after}, selected tab '${pressed}'`;
        });

        await step("9 a click on a tab changes ?a= and the title; an idle class page shows 8 idle students", async () => {
            await teacher.click('[data-testid="assignment-picker"]');
            await teacher.click(`[data-testid="assignment-option"][data-assignment="${seeded.a2}"]`);
            await wait_for(async () => (await teacher.evaluate("location.search")).includes(`a=${seeded.a2}`), 40, 250, "?a= of the second assignment");
            await wait_for(async () => (await teacher.text_of('[data-testid="assignment-title"]')) === "class: друге завдання", 40, 250, "the second title");
            await wait_for(async () => JSON.stringify(await statuses()) === JSON.stringify({ stuck: 0, work: 0, done: 0, idle: 8 }), 40, 250, "all students idle in the second assignment");
            return `address ${await teacher.evaluate("location.search")}, counters ${JSON.stringify(await statuses())}`;
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
