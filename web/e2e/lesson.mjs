// The lesson screen (kind = lesson) in a real browser: the teacher's journal at 1x, "now on your own"
// segments, retry, solution, next, finishing the lesson, "Мої завдання" showing it done. Built server (temporary DB)
// + dev `vite` + one headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; the port is fixed in server/src/main.ts, as for the other e2e scripts), 5178 (vite),
// 9339 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commands, read_journal } from "../../app/core/journal.mjs";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const VITE_PORT = 5178;
const CDP_PORT = 9339;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("lesson-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot or replay
const LESSON_FILE = fileURLToPath(new URL("../../app/test/out/br1.json", import.meta.url));
const AFTER_LOOP_MARGIN = 4;
const LOOP_RESULT = "100000";
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

// Segments and notes counted from the commands of the teacher's journal:
// [0] ifconfig, [1] uname, [2] sleep, [3] loop, [4] head.
const JOURNAL = read_journal(JSON.parse(readFileSync(LESSON_FILE, "utf8")));
const COMMANDS = commands(JOURNAL.events);
const LOOP_DONE = COMMANDS[4].start - AFTER_LOOP_MARGIN;
const NOTE = { t: "note", at: COMMANDS[0].index, text: "Спершу uname -r" };
const FIRST = { t: "self", from: COMMANDS[1].start, to: LOOP_DONE, text: "Виконайте: echo alpha" };
const SECOND = { t: "self", from: COMMANDS[4].start, to: COMMANDS[4].index, text: "Виконайте: echo beta" };
const NOTE_AFTER_FIRST = { t: "note", at: LOOP_DONE, text: "Цикл відпрацював" };

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач lesson", login: "teacher-lesson", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-lesson", subject: "Операційні системи" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = await call("POST", "/api/library", { kind: "lesson", title: "lesson: перший урок", brief: "Подивіться, як працює uname.\nПотім спробуйте самі.", topology }, teacher.cookie);
    const journal = { ...JOURNAL, header: { ...JOURNAL.header, lesson: [NOTE, NOTE_AFTER_FIRST, FIRST, SECOND] } };
    await call("PUT", `/api/library/${item.json.id}/journals/m1?role=start`, journal, teacher.cookie);
    const lesson = (await call("POST", `/api/library/${item.json.id}/assign`, { class_id: klass.json.id, due_at: null, max_grade: 100, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: "Студент lesson", login: "student-lesson", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    return { teacherCookie: teacher.cookie, classId: klass.json.id, lesson, studentCookie: student.cookie };
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

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "lesson-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "lesson-cdp-"));
    const children = [];
    const spawn_child = (cmd, args, options) => { const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...options }); children.push(child); return child; };
    let chrome = null;
    let cdp = null;
    const stop_children = () => { for(const child of children) { try { process.kill(-child.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_children(); process.exit(130); });

    try {
        spawn_child("node", [SERVER_MAIN], {
            cwd: ROOT, env: { ...process.env, LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") },
        });
        spawn_child("node", [join(ROOT, "web/node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web") });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 80, 250, "server behind the vite proxy");

        const seeded = await seed();
        console.log("seeded: lesson assignment", seeded.lesson);

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
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });

        const login_as = async cookie => {
            const [name, ...value] = cookie.split("=");
            await cdp.send("Network.setCookie", { name, value: value.join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        };
        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
        const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
        const wait_selector = (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`);
        const wait_gone = (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`);
        const console_lines = async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim());
        const wait_prompt = () => wait_for(async () => { const lines = (await console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
        const shot = async name => {
            await sleep(500);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        };
        // Radix opens menus on pointerdown, so a real mouse click is needed (element.click() is not enough).
        const click = async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
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

        const lines_have = async text => (await console_lines()).includes(text);
        const panel_phase = selector => `[data-testid="lesson-panel"][data-lesson-phase="${selector}"]`;
        const text_of = async selector => (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`));
        const wait_phase = (phase, tries = BOOT_TRIES) => wait_selector(panel_phase(phase), tries);

        await step("1 the student opens the lesson: the teacher's note is over the terminal, the journal replays", async () => {
            await login_as(seeded.studentCookie);
            await cdp.send("Page.navigate", { url: `${BASE}/assignments/${seeded.lesson}` });
            await wait_for(async () => (await text_of('[data-testid="lesson-note"]')).includes(NOTE.text), BOOT_TRIES, 250, `the note '${NOTE.text}'`);
            const stale = await evaluate(`(document.querySelector('[data-testid="terminal-overlay"]')?.innerText ?? "").includes("%")`);
            if(stale) throw new Error("the restore percent overlay is shown over the lesson replay");
            await shot("01-lesson-note");
            return `note '${NOTE.text}' is shown, no restore overlay`;
        });

        await step("2 first segment: phase student, the task text, live terminal, typed echo answers", async () => {
            await wait_phase("student");
            const task = await text_of('[data-testid="lesson-task"]');
            if(!task.includes("Виконайте: echo alpha")) throw new Error(`task text: ${JSON.stringify(task)}`);
            await wait_selector('[data-testid="terminal"][data-state="live"]', 60);
            await wait_prompt();
            await type_line("echo mine-alpha");
            await wait_for(() => lines_have("mine-alpha"), 120, 250, "the answer mine-alpha in the console");
            const buttons = await evaluate(`["lesson-retry", "lesson-solution", "lesson-next"].map(id => document.querySelector('[data-testid="' + id + '"]').disabled)`);
            if(buttons.join() !== "false,false,true") throw new Error(`disabled flags retry/solution/next: ${buttons}`);
            await shot("02-student-segment");
            return `task '${task}', mine-alpha answered, buttons enabled: retry, solution; next disabled`;
        });

        await step("3 'Спробувати знову': student again, the typed line is gone, input still works", async () => {
            await click('[data-testid="lesson-retry"]');
            await wait_for(async () => (await exists(panel_phase("student"))) && !(await lines_have("mine-alpha")) && (await exists('[data-testid="terminal"][data-state="live"]')), BOOT_TRIES, 250, "phase student with a clean live terminal");
            await wait_prompt();
            await type_line("echo mine-alpha");
            await wait_for(() => lines_have("mine-alpha"), 120, 250, "mine-alpha after the retry");
            return "phase student again, terminal was cleared, mine-alpha answers again";
        });

        await step("4 'Показати розв'язок': phase solved, the teacher's loop command is in the terminal", async () => {
            await click('[data-testid="lesson-solution"]');
            await wait_phase("solved");
            if(await lines_have("mine-alpha")) throw new Error("the student's own line is in the teacher's replay");
            const next = await evaluate(`document.querySelector('[data-testid="lesson-next"]').disabled`);
            if(next) throw new Error("'Далі' is disabled in the solved phase");
            // The segment ends before the loop prints its result (event ~202 of br1): the result shows up after 'Далі'.
            if(!(await console_lines()).some(line => line.includes("while [ $i -lt 100000 ]"))) throw new Error("the teacher's loop command is not in the console");
            await shot("04-solution-shown");
            return "phase solved, the teacher's loop command in the console, 'Далі' enabled";
        });

        await step("5 'Далі': the teacher's loop result, second segment, the progress list marks the first as passed", async () => {
            await click('[data-testid="lesson-next"]');
            await wait_for(async () => (await exists(panel_phase("student"))) && (await text_of('[data-testid="lesson-task"]')).includes("echo beta"), BOOT_TRIES, 250, "phase student with the second task");
            if(!(await lines_have(LOOP_RESULT))) throw new Error(`the teacher's loop result ${LOOP_RESULT} is not in the console after 'Далі'`);
            const head = await text_of('[data-testid="lesson-progress"] h2');
            const passed = await evaluate(`[...document.querySelectorAll('[data-testid="lesson-segment"]')].map(el => el.dataset.passed)`);
            if(head !== "Відрізок 2 з 2" || passed.join() !== "true,false") throw new Error(`progress: '${head}', passed flags ${passed}`);
            const note = await text_of('[data-testid="lesson-note"]');
            if(!note.includes(NOTE_AFTER_FIRST.text)) throw new Error(`the note after the first segment: ${JSON.stringify(note)}`);
            await shot("05-second-segment");
            return `'${head}', passed flags ${passed}, note '${NOTE_AFTER_FIRST.text}'`;
        });

        await step("6 second segment: solution, solved", async () => {
            await click('[data-testid="lesson-solution"]');
            await wait_phase("solved");
            return "phase solved";
        });

        await step("7 'Далі': the end of the lesson, 'Кінець уроку' and the finish button", async () => {
            await click('[data-testid="lesson-next"]');
            await wait_phase("done");
            const end = await text_of('[data-testid="lesson-end"]');
            if(end !== "Кінець уроку" || !(await exists('[data-testid="lesson-complete"]'))) throw new Error(`end '${end}', finish button missing`);
            await shot("07-lesson-end");
            return "phase done, 'Кінець уроку', 'Завершити урок'";
        });

        await step("8 'Завершити урок': 'Урок пройдено' appears, the button is gone", async () => {
            await click('[data-testid="lesson-complete"]');
            await wait_for(async () => (await text_of('[data-testid="lesson-passed"]')).startsWith("Урок пройдено"), 40, 250, "'Урок пройдено' in the right column");
            await wait_gone('[data-testid="lesson-complete"]');
            const line = await text_of('[data-testid="lesson-passed"]');
            await shot("08-lesson-completed");
            return line;
        });

        await step("9 'Мої завдання' show the lesson as done (SPA navigation, no reload)", async () => {
            await click('[data-testid="work-page"] header a');
            await wait_for(async () => (await text_of(`[data-testid="assignment-row"][data-assignment="${seeded.lesson}"]`)).includes("Здано"), 80, 250, "'Здано' in the row of the lesson");
            const mine = await call("GET", "/api/me/assignments", null, seeded.studentCookie);
            const status = mine.json.find(item => item.id === seeded.lesson)?.my_status;
            if(status !== "done") throw new Error(`GET /api/me/assignments: my_status ${status}`);
            await shot("09-my-assignments");
            return "row says 'Здано', my_status done";
        });
        console.log("RESULT: DONE");
    }
    finally {
        cdp?.close();
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
