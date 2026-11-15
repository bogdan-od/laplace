// The teacher's page of one student in an assignment (/classes/:cid/assignments/:aid/students/:uid) in a real
// browser. The student works on a live buildroot machine in a second browser context (own cookies); the teacher watches
// the
// big terminal, takes the input over, types into the hidden terminal (port 2), reads the attempt tree and closes a help
// request. Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("student-page-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot
const DAY_MS = 86_400_000;
const TERMINAL = '[data-testid="teacher-terminal"]';
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

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач stu", login: "teacher-stu", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-stu", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = (await call("POST", "/api/library", { kind: "task", title: "stu: виконайте echo", brief: "Виконайте echo stu-student у терміналі.", topology }, teacher.cookie)).json.id;
    const a1 = (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: Date.now() + 3 * DAY_MS, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: "Лисенко Тарас", login: "lysenko-stu", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    return { teacherCookie: teacher.cookie, classId: klass.json.id, a1, studentCookie: student.cookie, studentId: student.json.id };
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
    // The `input` messages this tab sent over its WebSocket: the wire-level proof of where the typing went.
    const inputs = [];
    cdp.on(msg => {
        if(msg.method !== "Network.webSocketFrameSent") return;
        try { const data = JSON.parse(msg.params.response.payloadData); if(data.type === "input") inputs.push(data); } catch { /* not JSON */ }
    });
    const driver = {
        evaluate, exists, inputs,
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
        // Types into the xterm inside `root`; Enter is sent unless `enter` is false.
        type_into: async (root, text, enter = true) => {
            await evaluate(`document.querySelector(${JSON.stringify(`${root} .xterm-helper-textarea`)})?.focus()`);
            for(const ch of text) {
                await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
                await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
            }
            if(!enter) return;
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
    };
    driver.lines_of = async root => (await evaluate(`(document.querySelector(${JSON.stringify(`${root} .xterm-rows`)})?.innerText ?? '')`)).split("\n").map(line => line.trim());
    driver.wait_prompt = root => wait_for(async () => { const lines = (await driver.lines_of(root)).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
    return driver;
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "student-page-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "stu-cdp-"));
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
        console.log("seeded: class", seeded.classId, "assignment", seeded.a1, "student", seeded.studentId);

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
        const STUDENT_TERMINAL = '[data-testid="terminal"]';
        const page_url = `${BASE}/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}`;

        await step("1 the student types `echo stu-student`, the teacher's big terminal shows the line", async () => {
            await student.login_as(seeded.studentCookie);
            await student.open(`${BASE}/assignments/${seeded.a1}`);
            await student.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await student.wait_prompt(STUDENT_TERMINAL);
            await student.type_into(STUDENT_TERMINAL, "echo stu-student");
            await wait_for(async () => (await student.lines_of(STUDENT_TERMINAL)).includes("stu-student"), 120, 250, "the answer in the student's terminal");

            await teacher.login_as(seeded.teacherCookie);
            await teacher.open(page_url);
            await teacher.wait_selector(TERMINAL);
            await wait_for(async () => (await teacher.lines_of(TERMINAL)).includes("stu-student"), 120, 250, "stu-student in the teacher's big terminal");
            const name = await teacher.text_of('[data-testid="student-name"]');
            const back = await teacher.evaluate(`document.querySelector('[data-testid="back-to-class"]')?.getAttribute("href")`);
            if(name !== "Лисенко Тарас" || back !== `/classes/${seeded.classId}?a=${seeded.a1}`) throw new Error(`header: name '${name}', back '${back}'`);
            const cols = await teacher.evaluate(`document.querySelector(${JSON.stringify(`${TERMINAL} .xterm-screen`)}).getBoundingClientRect().width`);
            await teacher.shot("01-student-terminal");
            return `big terminal shows stu-student; header '${name}', back link ${back}; terminal ${Math.round(cols)} px wide (80 columns)`;
        });

        await step("2 'Перехопити ввід': the teacher types `echo stu-teacher`, the line appears in the student's terminal", async () => {
            await teacher.type_into(TERMINAL, "x", false);
            if(teacher.inputs.length !== 0) throw new Error("the read-only terminal sent input");
            await teacher.click('[data-testid="intercept"]');
            await teacher.wait_selector('[data-testid="intercept-note"]');
            const note = await teacher.text_of('[data-testid="intercept-note"]');
            if(note !== "Ви вводите в термінал студента") throw new Error(`note '${note}'`);
            await teacher.type_into(TERMINAL, "echo stu-teacher");
            await wait_for(async () => (await student.lines_of(STUDENT_TERMINAL)).includes("stu-teacher"), 120, 250, "stu-teacher in the student's terminal");
            await wait_for(async () => (await teacher.lines_of(TERMINAL)).includes("stu-teacher"), 40, 250, "stu-teacher in the teacher's terminal");
            const ports = [...new Set(teacher.inputs.map(item => item.port))];
            if(ports.join() !== "0" || !teacher.inputs.every(item => item.machine === "m1")) throw new Error(`inputs ${JSON.stringify(teacher.inputs.slice(0, 3))}`);
            await teacher.shot("02-intercept");
            return `student's terminal shows stu-teacher; ${teacher.inputs.length} input messages, all port 0 machine m1; note '${note}'`;
        });

        await step("3 hidden terminal: `echo stu-hidden` goes to port 2, the student does not see it", async () => {
            const before = teacher.inputs.length;
            await teacher.click('[data-testid="release"]');
            await teacher.click('[data-testid="tab-hidden"]');
            await wait_for(async () => (await teacher.evaluate(`document.querySelector(${JSON.stringify(TERMINAL)})?.dataset.port`)) === "2", 40, 250, "the hidden terminal");
            const note = await teacher.text_of('[data-testid="hidden-note"]');
            await teacher.type_into(TERMINAL, "echo stu-hidden");
            await wait_for(() => teacher.inputs.length > before, 40, 250, "input messages for port 2");
            const fresh = teacher.inputs.slice(before);
            if(!fresh.every(item => item.port === 2 && item.machine === "m1")) throw new Error(`inputs ${JSON.stringify(fresh.slice(0, 3))}`);
            const answered = await wait_for(async () => (await teacher.lines_of(TERMINAL)).includes("stu-hidden"), 80, 250, "stu-hidden output in the hidden terminal").then(() => true, () => false);
            const student_text = await student.evaluate("document.body.innerText");
            if(student_text.includes("stu-hidden")) throw new Error("the student's page shows stu-hidden");
            await teacher.shot("03-hidden");
            if(!answered) notes.push("step 3: no output on port 2 within 20 s - only the input to port 2 was checked");
            return `${fresh.length} input messages, all port 2; output in the hidden tab: ${answered ? "yes" : "NO (see notes)"}; student page has no stu-hidden; note '${note}'`;
        });

        await step("4 the attempt tree shows the machine (a line, or a tree with forks)", async () => {
            await teacher.wait_selector('[data-testid="attempt-tree"] [data-node]');
            const total = await teacher.count('[data-testid="branch"], [data-testid="branch-flat"]');
            const text = await teacher.text_of('[data-testid="attempt-tree"]');
            // A machine without forks is one line "m1  N подій"; with forks the tree marks the head.
            if(total < 1 || !text.includes("m1")) throw new Error(`branches ${total}, text ${JSON.stringify(text)}`);
            return `${total} branch(es), text ${JSON.stringify(text.split("\n")[1] ?? "")}`;
        });

        await step("5 a help request (seeded through the API by the student) is listed, 'Закрити' removes it from the open ones", async () => {
            const attempt = (await call("GET", `/api/assignments/${seeded.a1}/attempt`, null, seeded.studentCookie)).json;
            const head = attempt.heads.m1;
            await call("POST", `/api/attempts/${attempt.id}/help`, { node: "m1", branch_id: head, event_count: 0, text: "Не працює echo у терміналі" }, seeded.studentCookie);
            await wait_for(() => teacher.exists('[data-testid="help-item"][data-state="open"]'), 120, 250, "the open help request on the page");
            const text = await teacher.text_of('[data-testid="help-item"]');
            if(!text.includes("Не працює echo у терміналі")) throw new Error(`help text ${JSON.stringify(text)}`);
            const reply_enabled = await teacher.evaluate(`document.querySelector('[data-testid="help-reply"]')?.disabled === false`);
            const moment_enabled = await teacher.evaluate(`document.querySelector('[data-testid="help-moment"]')?.disabled === false`);
            if(!reply_enabled || !moment_enabled) throw new Error(`help-reply enabled ${reply_enabled}, help-moment enabled ${moment_enabled}`);
            await teacher.click('[data-testid="help-close"]');
            await teacher.wait_gone('[data-testid="help-item"][data-state="open"]');
            await wait_for(() => teacher.exists('[data-testid="help-item"][data-state="closed"]'), 40, 250, "the closed request");
            const open = (await call("GET", "/api/help?open=1", null, seeded.teacherCookie)).json.length;
            if(open !== 0) throw new Error(`${open} open requests on the server`);
            await teacher.shot("04-help-closed");
            return `request listed with its text, 'Відповісти' and 'Переглянути момент' enabled, after 'Закрити' the state is closed and the server has 0 open`;
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
