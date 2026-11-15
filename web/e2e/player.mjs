// The player (/play/:source) in a real browser. The submission is made through the API (a recorded buildroot
// journal), so no machine runs on the student's side; the machine of the player runs in the browser from the journal.
// Built server (temporary DB) + dev `vite` + headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { commands, event_times } from "../../app/core/journal.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const JOURNAL = JSON.parse(readFileSync(join(ROOT, "app/test/out/buildroot-1.json"), "utf8"));
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("player-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const SERVER_WAIT_TRIES = 720; // x 250 ms = 3 min for the server to replay a machine
const PLAYER_WAIT_TRIES = 720; // the browser loads the boot snapshot and replays up to the position
const DAY_MS = 86_400_000;
const HELP_EVENT_COUNT = 140;
const POSITION_TOLERANCE_MS = 1000;
const FOUND_COMMAND = "uname -r";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];

const all_commands = commands(JOURNAL.events);
const times = event_times(JOURNAL);
const target_command = all_commands.find(c => c.text === FOUND_COMMAND);

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

async function page_driver(cdp, who) {
    cdp.on(report_page_problems(who));
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
    const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    const q = selector => JSON.stringify(selector);
    return {
        evaluate, exists,
        login_as: async cookie => {
            const [name, ...value] = cookie.split("=");
            await cdp.send("Network.setCookie", { name, value: value.join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        },
        open: url => cdp.send("Page.navigate", { url }),
        wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
        text_of: selector => evaluate(`document.querySelector(${q(selector)})?.innerText ?? ""`),
        value_of: selector => evaluate(`document.querySelector(${q(selector)})?.value ?? ""`),
        attr_of: (selector, name) => evaluate(`document.querySelector(${q(selector)})?.getAttribute(${JSON.stringify(name)})`),
        count: selector => evaluate(`document.querySelectorAll(${q(selector)}).length`),
        shot: async name => {
            await sleep(500);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        },
        click: async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${q(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
        // A real key press: the page sees keydown (and the text goes into a focused field).
        press: async (key, code, windowsVirtualKeyCode, text) => {
            await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, text, windowsVirtualKeyCode });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
        },
    };
}

const TERMINAL_STATES = ["ok", "failed", "tail_unchecked", "timeout"];

// A class with a task of one buildroot machine, one student who handed in a recorded session and asked for help in it.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач player", login: "teacher-player", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-player", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = (await call("POST", "/api/library", { kind: "task", title: "player: перегляд запису", brief: "Виконайте команди з журналу.", topology }, teacher.cookie)).json.id;
    const a1 = (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: Date.now() + 3 * DAY_MS, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: "Лисенко Тарас", login: "lysenko-player", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    const attempt = (await call("POST", `/api/assignments/${a1}/attempt`, null, student.cookie)).json;
    const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: JOURNAL.header, make_head: true }, student.cookie)).json;
    await call("PUT", `/api/branches/${branch.id}/events`, { from: 0, events: JOURNAL.events }, student.cookie);
    await call("POST", `/api/attempts/${attempt.id}/help`, { node: "m1", branch_id: branch.id, event_count: HELP_EVENT_COUNT, text: "Не працює uptime" }, student.cookie);
    const head = { node: "m1", branch_id: branch.id, event_count: JOURNAL.events.length };
    const submission = (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [head] }, student.cookie)).json;
    return { teacherCookie: teacher.cookie, classId: klass.json.id, a1, studentId: student.json.id, submissionId: submission.id, branchId: branch.id };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    if(!target_command) throw new Error(`the journal has no command '${FOUND_COMMAND}'`);
    const dir = mkdtempSync(join(tmpdir(), "player-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "player-cdp-"));
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
        console.log("seeded: class", seeded.classId, "assignment", seeded.a1, "student", seeded.studentId, "submission", seeded.submissionId, "branch", seeded.branchId);
        await wait_for(async () => {
            const sub = (await call("GET", `/api/submissions/${seeded.submissionId}`, null, seeded.teacherCookie)).json;
            return TERMINAL_STATES.includes(sub.verify_status) ? sub : null;
        }, SERVER_WAIT_TRIES, 250, "the server's check of the journal");

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(cdp);
        const page = await page_driver(cdp, "teacher");
        const student_page = `${BASE}/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}`;
        const READY = '[data-testid="player"][data-phase="ready"]';
        const IDLE = '[data-testid="player"][data-seeking="false"]';
        const terminal_text = () => page.evaluate(`document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? ""`);
        const position = async () => Number(await page.attr_of('[data-testid="player"]', "data-position"));
        const flag = async name => page.attr_of('[data-testid="player"]', name);
        const wait_idle = async what => { await page.wait_selector(IDLE, 240); await sleep(300); return what; };

        await step("1 the player opens from the submission panel: the title, the commands, the marks, the legend", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${student_page}?submission=${seeded.submissionId}`);
            await page.wait_selector('[data-testid="submission-open"]');
            await page.click('[data-testid="submission-open"]');
            await page.wait_selector(READY, PLAYER_WAIT_TRIES);
            await wait_for(async () => (await page.count('[data-testid="command-item"]')) > 0, 40, 250, "commands in the list");
            await wait_for(async () => (await page.attr_of('[data-testid="terminal"]', "data-state")) === "replay", PLAYER_WAIT_TRIES, 250, "the machine in the replay state");
            const path = await page.evaluate("location.pathname");
            const title = await page.text_of('[data-testid="player-title"]');
            const subtitle = await page.text_of('[data-testid="player-subtitle"]');
            const items = await page.count('[data-testid="command-item"]');
            const kinds = await page.evaluate(`[...document.querySelectorAll('[data-testid="command-item"]')].map(el => el.dataset.kind).join(",")`);
            const ticks = await page.count('[data-testid="timeline-mark"]');
            const legend = await page.count('[data-testid="legend"] li');
            const paused = await flag("data-paused");
            if(path !== `/play/submission-${seeded.submissionId}-m1`) throw new Error(`path ${path}`);
            if(!title.includes("player") || !subtitle.includes("Лисенко")) throw new Error(`title '${title}' / '${subtitle}'`);
            if(items === 0 || items !== ticks) throw new Error(`${items} list items, ${ticks} marks on the timeline`);
            if(legend !== 6) throw new Error(`legend has ${legend} entries`);
            if(paused !== "true") throw new Error(`not paused at the start (${paused})`);
            await page.shot("01-player");
            return `${path}, '${title}' / '${subtitle}', ${items} items = ${ticks} marks (${kinds}), legend ${legend}, paused at the start`;
        });

        await step(`2 a click on the command '${FOUND_COMMAND}' shows its output in the terminal`, async () => {
            const before = await terminal_text();
            await page.click(`[data-testid="command-item"][title="${FOUND_COMMAND}"]`);
            await wait_for(async () => (await flag("data-seeking")) === "false" && /\n\d+\.\d+\.\d+/.test(await terminal_text()), PLAYER_WAIT_TRIES, 250, "the output of uname in the terminal");
            const after = await terminal_text();
            const at = await position();
            const current = await page.attr_of('[data-testid="command-item"][data-current="true"]', "title");
            if(before.includes(FOUND_COMMAND)) throw new Error("the command was already on the screen before the click");
            if(current !== FOUND_COMMAND) throw new Error(`current row '${current}'`);
            if(at < times[target_command.index] - 50) throw new Error(`position ${at} is before the Enter of the command (${Math.round(times[target_command.index])} ms)`);
            await page.shot("02-command");
            return `position ${at} ms (Enter at ${Math.round(times[target_command.index])} ms), current row '${current}', terminal: ${JSON.stringify(after.split("\n").filter(l => l.trim()).slice(-3))}`;
        });

        await step("3 ?t= is in the address while paused and a reload comes back to the same position", async () => {
            const search = await page.evaluate("location.search");
            const t = Number(new URLSearchParams(search).get("t"));
            const was = await position();
            if(!Number.isInteger(t) || Math.abs(t - was) > 1) throw new Error(`address '${search}', position ${was}`);
            await page.open(await page.evaluate("location.href"));
            await page.wait_selector(READY, PLAYER_WAIT_TRIES);
            await wait_for(async () => (await flag("data-seeking")) === "false" && /\n\d+\.\d+\.\d+/.test(await terminal_text()), PLAYER_WAIT_TRIES, 250, "the same screen after the reload");
            const now = await position();
            const paused = await flag("data-paused");
            if(Math.abs(now - was) > POSITION_TOLERANCE_MS) throw new Error(`position ${was} before, ${now} after the reload`);
            if(paused !== "true") throw new Error(`paused ${paused} after the reload`);
            return `address '${search}', position ${was} before and ${now} after the reload, paused`;
        });

        await step("4 Space and → act on the player, not when the focus is in the search field", async () => {
            const start = await position();
            await page.press(" ", "Space", 32, " ");
            await wait_for(async () => (await flag("data-paused")) === "false", 40, 100, "playing after Space");
            await sleep(1500);
            await page.press(" ", "Space", 32, " ");
            await wait_for(async () => (await flag("data-paused")) === "true", 40, 100, "paused after the second Space");
            await wait_idle("");
            const played = await position();
            if(played <= start) throw new Error(`position ${start} -> ${played} after playing`);
            await page.press("ArrowRight", "ArrowRight", 39);
            await wait_for(async () => (await position()) > played + 100, 80, 100, "a jump to the next command");
            await wait_idle("");
            const jumped = await position();
            await page.press("ArrowLeft", "ArrowLeft", 37);
            await wait_for(async () => (await position()) < jumped - 100, 80, 100, "a jump back");
            await wait_idle("");
            const back = await position();

            await page.press("/", "Slash", 191, "/");
            const focused = await page.evaluate(`document.activeElement?.dataset.testid`);
            if(focused !== "command-search") throw new Error(`'/' focused '${focused}'`);
            const typed_before = await page.value_of('[data-testid="command-search"]');
            await page.press(" ", "Space", 32, " ");
            await page.press("ArrowRight", "ArrowRight", 39);
            await sleep(700);
            const field = await page.value_of('[data-testid="command-search"]');
            const still = await position();
            const paused = await flag("data-paused");
            if(field !== `${typed_before} `) throw new Error(`search field '${field}'`);
            if(still !== back || paused !== "true") throw new Error(`the player moved: position ${back} -> ${still}, paused ${paused}`);
            return `Space played (${start} -> ${played} ms) and paused; → ${played} -> ${jumped}; ← -> ${back}; '/' focused the field; Space typed a space there and → did nothing (position ${still}, paused)`;
        });

        await step("5 speed 'макс' runs to the end of the journal", async () => {
            await page.evaluate(`document.activeElement?.blur()`);
            await page.click('[data-testid="speed-max"]');
            const speed = await flag("data-speed");
            if(speed !== "0") throw new Error(`speed ${speed}`);
            const started = Date.now();
            await page.click('[data-testid="play-toggle"]');
            await wait_for(async () => (await flag("data-ended")) === "true", PLAYER_WAIT_TRIES, 250, "the end of the journal");
            const took = Date.now() - started;
            const end = await position();
            const max = Number(await page.attr_of('[data-testid="timeline"]', "aria-valuemax"));
            if(Math.abs(end - max) > POSITION_TOLERANCE_MS) throw new Error(`ended at ${end}, the journal lasts ${max}`);
            await page.shot("03-ended");
            return `ended at ${end} of ${max} ms in ${(took / 1000).toFixed(1)} s`;
        });

        await step("6 a branch of the attempt tree opens in the player; 'Назад' returns to the page", async () => {
            await page.open(student_page);
            await page.wait_selector('[data-testid="attempt-tree"] a');
            await page.click('[data-testid="attempt-tree"] a');
            await page.wait_selector(READY, PLAYER_WAIT_TRIES);
            await wait_for(async () => (await page.count('[data-testid="command-item"]')) > 0, 40, 250, "commands of the branch");
            const path = await page.evaluate("location.pathname");
            const title = await page.text_of('[data-testid="player-title"]');
            if(path !== `/play/branch-${seeded.branchId}`) throw new Error(`path ${path}`);
            await page.shot("04-branch");
            await page.click('[data-testid="player-back"]');
            await page.wait_selector('[data-testid="student-page"]');
            return `${path}, title '${title}', 'Назад' went back to the student page`;
        });

        await step("7 'Переглянути момент' opens the branch at the moment of the request, with its mark", async () => {
            await page.wait_selector('[data-testid="help-moment"]');
            // The room joins after the first paint; an offline student has no terminal column, so the aside widens once then.
            await page.wait_selector('[data-testid="offline"]');
            await page.click('[data-testid="help-moment"]');
            try {
                await wait_for(async () => (await page.evaluate("location.pathname")).startsWith("/play/"), 40, 250, "the player address");
                await page.wait_selector(READY, PLAYER_WAIT_TRIES);
            } catch(error) {
                await page.shot("07-fail");
                const toasts = await page.evaluate(`[...document.querySelectorAll("[data-sonner-toast]")].map(el => el.innerText).join(" | ")`);
                throw new Error(`${error.message}; address ${await page.evaluate("location.href")}; toasts: ${toasts || "none"}`);
            }
            await wait_for(async () => (await page.count('[data-testid="command-item"][data-kind="help"]')) === 1, 40, 250, "the help mark in the list");
            await wait_for(async () => (await flag("data-seeking")) === "false", PLAYER_WAIT_TRIES, 250, "the seek to the moment");
            const expected = times[HELP_EVENT_COUNT - 1];
            const search = await page.evaluate("location.search");
            const t = Number(new URLSearchParams(search).get("t"));
            const at = await position();
            if(Math.abs(t - Math.round(expected)) > 1) throw new Error(`?t=${t}, expected ${Math.round(expected)}`);
            if(Math.abs(at - expected) > POSITION_TOLERANCE_MS) throw new Error(`position ${at}, expected ${Math.round(expected)}`);
            return `?t=${t} (event ${HELP_EVENT_COUNT} is at ${Math.round(expected)} ms), position ${at}, one help mark`;
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
