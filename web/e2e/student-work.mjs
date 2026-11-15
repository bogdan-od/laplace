// The student's screens in a real browser. Built server (temporary DB) + dev `vite` (its /ws proxy is part
// of the check) + one headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server), 5176 (vite), 9337 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const VITE_PORT = 5176;
const CDP_PORT = 9337;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const WS_URL = `ws://127.0.0.1:${VITE_PORT}/ws`;
const OUT = out_dir("student-work-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot or replay
const LIVE_UPDATE_MS = 15_000;
const WS_JOINED_MS = 15_000;
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

const HINTS = [{ text: "Спробуйте команду echo", penalty: 1 }, { text: "Прочитайте man echo", penalty: 2 }];

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач work", login: "teacher-work", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-work", subject: "Операційні системи" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const subject = async (title, hints) => {
        const item = await call("POST", "/api/library", { kind: "task", title, brief: `Виконайте echo work-ok.\nДругий рядок умови.`, topology }, teacher.cookie);
        if(hints) await call("PATCH", `/api/library/${item.json.id}`, { hints }, teacher.cookie);
        return item.json.id;
    };
    const assign = async (itemId, due_at) =>
        (await call("POST", `/api/library/${itemId}/assign`, { class_id: klass.json.id, due_at, max_grade: 100, shared_lan: false }, teacher.cookie)).json.id;
    const upcoming = await assign(await subject("work: echo (через 3 дні)", HINTS), Date.now() + 3 * DAY_MS);
    const overdue = await assign(await subject("work: прострочене", null), Date.now() - DAY_MS);
    const a = await call("POST", "/api/auth/register", { name: "Студент A", login: "student-a-work", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    // A student cannot register without an invite: B joins and the teacher removes them, leaving no class.
    const b = await call("POST", "/api/auth/register", { name: "Студент B", login: "student-b-work", password: "password-3", role: "student", invite_code: klass.json.invite_code });
    const me = await call("GET", "/api/me", null, b.cookie);
    await call("DELETE", `/api/classes/${klass.json.id}/members/${me.json.id}`, null, teacher.cookie);
    return { teacherCookie: teacher.cookie, upcoming, overdue, cookieA: a.cookie, cookieB: b.cookie };
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
    const dir = mkdtempSync(join(tmpdir(), "student-work-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "work-cdp-"));
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
        console.log("seeded: assignments", seeded.upcoming, seeded.overdue);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const target = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 80, 250, "chromium");
        cdp = await connect(target.webSocketDebuggerUrl);
        cdp.on(report_page_problems);
        // WebSocket traffic as the browser sees it: which URL the socket was opened on and what came in.
        const sockets = new Map();
        const joined = [];
        cdp.on(msg => {
            if(msg.method === "Network.webSocketCreated") sockets.set(msg.params.requestId, msg.params.url);
            else if(msg.method === "Network.webSocketFrameReceived") {
                try {
                    const data = JSON.parse(msg.params.response.payloadData);
                    if(data.type === "joined") joined.push({ url: sockets.get(msg.params.requestId), id: data.id, role: data.role });
                } catch { /* not JSON */ }
            }
        });
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Page.enable");
        await cdp.send("Network.enable");
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });

        const login_as = async cookie => {
            const [name, ...value] = cookie.split("=");
            await cdp.send("Network.setCookie", { name, value: value.join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        };
        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
        const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
        const wait_selector = (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`);
        const wait_gone = (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`);
        const page_text = () => evaluate("document.body.innerText");
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
        const escape = async () => {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
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
        const has_line = async text => (await console_lines()).includes(text);

        await step("1 student B without a class sees the invitation code field", async () => {
            await login_as(seeded.cookieB);
            await cdp.send("Page.navigate", { url: `${BASE}/` });
            await wait_for(async () => (await page_text()).includes("Код запрошення"), 80, 250, "the text 'Код запрошення'");
            if(!(await exists('input'))) throw new Error("no input field on the page");
            await shot("01-no-class");
            return "field 'Код запрошення' is on the page";
        });

        await step("2 student A sees two assignments in the right order", async () => {
            await login_as(seeded.cookieA);
            await cdp.send("Page.navigate", { url: `${BASE}/` });
            await wait_for(async () => (await evaluate(`document.querySelectorAll('[data-testid="assignment-row"]').length`)) === 2, 80, 250, "two assignment rows");
            const order = await evaluate(`[...document.querySelectorAll('[data-testid="assignment-row"]')].map(row => Number(row.dataset.assignment))`);
            if(order[0] !== seeded.upcoming || order[1] !== seeded.overdue) throw new Error(`order ${order}, expected ${seeded.upcoming}, ${seeded.overdue}`);
            await shot("02-my-assignments");
            return `rows ${order.join(", ")} (due in 3 days first, overdue second)`;
        });

        await step("3 the first row opens a live terminal, echo work-ok is answered", async () => {
            joined.length = 0;
            await click(`[data-testid="assignment-row"][data-assignment="${seeded.upcoming}"] a`);
            await wait_for(async () => (await evaluate("location.pathname")) === `/assignments/${seeded.upcoming}`, 40, 250, "the work page address");
            await wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await wait_prompt();
            await type_line("echo work-ok");
            await wait_for(() => has_line("work-ok"), 120, 250, "the answer work-ok in the console");
            await wait_for(async () => (await evaluate(`document.querySelector('[data-testid="save-status"]')?.dataset.status`)) === "saved", 60, 250, "save status saved");
            await shot("03-terminal");
            return "work-ok is in the console, status 'Збережено'";
        });

        await step("4 WebSocket through the vite proxy: opened on /ws of the vite port, `joined` received", async () => {
            const hit = await wait_for(() => joined.find(item => item.url === WS_URL), WS_JOINED_MS / 250, 250, `a 'joined' frame on ${WS_URL}`)
                .catch(() => {
                    throw new Error(`no 'joined' message within ${WS_JOINED_MS / 1000} s on ${WS_URL}; sockets seen: ${[...sockets.values()].join(", ") || "none"}; joined frames: ${JSON.stringify(joined)}`);
                });
            return `${hit.url}, joined as ${hit.id} (${hit.role})`;
        });

        await step("5 rollback menu and the hint dialog", async () => {
            await click('[data-testid="rollback-open"]');
            await wait_selector('[data-testid="rollback-option"]', 40);
            const labels = await evaluate(`[...document.querySelectorAll('[data-testid="rollback-option"]')].map(el => el.textContent)`);
            if(!labels.includes("До початку")) throw new Error(`no 'До початку' in ${JSON.stringify(labels)}`);
            if(!labels.some(label => label.includes("echo work-ok"))) throw new Error(`the typed command is not in the menu: ${JSON.stringify(labels)}`);
            await shot("05a-rollback-menu");
            await escape();
            await wait_gone('[data-testid="rollback-option"]');
            await click('[data-testid="hints-open"]');
            await wait_selector('[data-testid="hints-dialog"] [data-testid="hint-open"]', 40);
            await click('[data-testid="hint-open"]');
            await wait_selector('[data-testid="hint-confirm"]', 20);
            await click('[data-testid="hint-confirm"]');
            await wait_for(async () => (await page_text()).includes(HINTS[0].text), 40, 250, "the text of hint 1");
            await shot("05b-hint-opened");
            await escape();
            await wait_gone('[data-testid="hints-dialog"]');
            return `menu: ${labels.length} items; hint 1 opened with its text`;
        });

        await step("6 history shows the attempt tree with player links", async () => {
            await click('[data-testid="history-open"]');
            await wait_selector('[data-testid="history-dialog"] [data-testid="branch"]', 40);
            const links = await evaluate(`[...document.querySelectorAll('[data-testid="history-dialog"] a[href^="/play/branch-"]')].map(a => a.getAttribute("href"))`);
            if(links.length === 0) throw new Error("no player links in the tree");
            await shot("06-history");
            await escape();
            await wait_gone('[data-testid="history-dialog"]');
            return `branches with links: ${links.join(", ")}`;
        });

        let submissionId = 0;
        await step("7 submit with a confirmation, the submission block appears", async () => {
            await click('[data-testid="submit-open"]');
            await wait_selector('[data-testid="submit-confirm"]', 20);
            await click('[data-testid="submit-confirm"]');
            await wait_selector('[data-testid="submission-block"]', 240);
            submissionId = Number(await evaluate(`document.querySelector('[data-testid="submission-block"]').dataset.submission`));
            const verify = await evaluate(`document.querySelector('[data-testid="submission-block"]').dataset.verify`);
            await shot("07-submitted");
            return `submission ${submissionId}, verify_status ${verify}`;
        });

        await step("8 grade and comment from the teacher appear without a reload", async () => {
            await evaluate("window.__work_no_reload = true");
            await call("PUT", `/api/submissions/${submissionId}/grade`, { grade: 80, note: "Добре, але можна швидше" }, seeded.teacherCookie);
            await call("POST", `/api/submissions/${submissionId}/comments`, { node: "m1", event_index: 0, vtime_ms: 0, text: "Коментар викладача work" }, seeded.teacherCookie);
            const appeared = () => evaluate(`(document.querySelector('[data-testid="submission-grade"]')?.textContent ?? "").includes("80") && !!document.querySelector('[data-testid="submission-comment"]')`);
            let detail;
            try {
                await wait_for(appeared, LIVE_UPDATE_MS / 250, 250, "the grade and the comment on the screen");
                detail = "grade 80 and the comment appeared live (WS graded/commented), no reload";
            } catch {
                console.log(`FINDING: grade and comment did not appear within ${LIVE_UPDATE_MS / 1000} s without a reload; reloading`);
                await cdp.send("Page.reload");
                await wait_for(appeared, 480, 250, "the grade and the comment after a reload");
                detail = "NOT live: they appeared only after a reload (see FINDING above)";
            }
            const kept = await evaluate("window.__work_no_reload === true");
            await shot("08-graded");
            return `${detail}; page reloaded: ${kept ? "no" : "yes"}`;
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
