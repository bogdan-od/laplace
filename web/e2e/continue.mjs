// "Продовжити звідси" / "Відповісти звідси", the comments on a submission and the layout of the player in a real
// browser. The attempt is made through the API (a recorded buildroot journal), so no machine runs on the student's
// side; the
// machine of the player runs in the browser from the journal. Built server (temporary DB) + dev `vite` + headless
// Chromium.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { event_times } from "../../app/core/journal.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const JOURNAL = JSON.parse(readFileSync(join(ROOT, "app/test/out/buildroot-1.json"), "utf8"));
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("continue-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const SERVER_WAIT_TRIES = 720; // x 250 ms = 3 min for the server to replay a machine
const PLAYER_WAIT_TRIES = 720; // the browser loads the boot snapshot and replays up to the position
const DAY_MS = 86_400_000;
const HELP_EVENT_COUNT = 140;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];

const times = event_times(JOURNAL);

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
const TITLE = "cont: продовження і відповідь";
const STUDENT_NAME = "Лисенко Ірина";
const COMMENT_TEXT = "Тут треба перевірити адресу";
const MIDDLE_EVENT = 100;
const PANEL_GAP_PX = 30; // page padding (24) plus slack: the command list reaches the right edge of the page content

// A class with a task of one buildroot machine, one student who recorded a session, asked for help in it and handed it in.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач cont", login: "teacher-cont", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-cont", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = (await call("POST", "/api/library", { kind: "task", title: TITLE, brief: "Виконайте команди з журналу.", topology }, teacher.cookie)).json.id;
    const a1 = (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: Date.now() + 3 * DAY_MS, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: STUDENT_NAME, login: "lysenko-cont", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    const attempt = (await call("POST", `/api/assignments/${a1}/attempt`, null, student.cookie)).json;
    const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: JOURNAL.header, make_head: true }, student.cookie)).json;
    await call("PUT", `/api/branches/${branch.id}/events`, { from: 0, events: JOURNAL.events }, student.cookie);
    const help = (await call("POST", `/api/attempts/${attempt.id}/help`, { node: "m1", branch_id: branch.id, event_count: HELP_EVENT_COUNT, text: "Не працює uptime" }, student.cookie)).json;
    const head = { node: "m1", branch_id: branch.id, event_count: JOURNAL.events.length };
    const submission = (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [head] }, student.cookie)).json;
    return {
        teacherCookie: teacher.cookie, studentCookie: student.cookie, classId: klass.json.id, a1, studentId: student.json.id,
        attemptId: attempt.id, submissionId: submission.id, branchId: branch.id, helpId: help.id,
    };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "continue-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "cont-cdp-"));
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
        const page = await page_driver(cdp, "browser");
        const READY = '[data-testid="player"][data-phase="ready"]';
        const player_idle = async () => {
            await page.wait_selector(READY, PLAYER_WAIT_TRIES);
            await wait_for(async () => (await page.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_WAIT_TRIES, 250, "the seek to the moment");
        };
        const attempt_now = async () => (await call("GET", `/api/attempts/${seeded.attemptId}`, null, seeded.teacherCookie)).json;
        const path_now = () => page.evaluate("location.pathname");
        const middle_ms = Math.round(times[MIDDLE_EVENT - 1]);
        const events_at = ms => times.filter(t => t <= ms + 0.5).length;

        await step("1 the player of a branch names the assignment and the student, and has no fork button off the help moment", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${BASE}/play/branch-${seeded.branchId}`);
            await player_idle();
            const title = await page.text_of('[data-testid="player-title"]');
            const subtitle = await page.text_of('[data-testid="player-subtitle"]');
            await wait_for(async () => (await page.count('[data-testid="command-item"][data-kind="help"]')) === 1, 40, 250, "the help mark");
            if(title !== TITLE) throw new Error(`title '${title}'`);
            if(!subtitle.includes(STUDENT_NAME) || !subtitle.includes("m1")) throw new Error(`subtitle '${subtitle}'`);
            if(await page.exists('[data-testid="fork"]')) throw new Error("the teacher has a fork button at the start of the recording");
            return `title '${title}', subtitle '${subtitle}', one help mark, no fork button at 0`;
        });

        await step("2 the student's 'Продовжити звідси' makes a continue branch, the head of the machine", async () => {
            await page.login_as(seeded.studentCookie);
            await page.open(`${BASE}/play/branch-${seeded.branchId}?t=${middle_ms}`);
            await player_idle();
            await page.wait_selector('[data-testid="fork"]');
            const label = await page.text_of('[data-testid="fork"]');
            const at = Number(await page.attr_of('[data-testid="player"]', "data-position"));
            const expected = events_at(at);
            await page.shot("01-student-fork");
            await page.click('[data-testid="fork"]');
            await wait_for(async () => (await path_now()) === `/assignments/${seeded.a1}`, 80, 250, "the work screen of the assignment");
            const attempt = await wait_for(async () => {
                const found = (await attempt_now()).branches.find(b => b.kind === "continue");
                return found ? await attempt_now() : null;
            }, 40, 250, "the continue branch");
            const made = attempt.branches.find(b => b.kind === "continue");
            if(made.parent_id !== seeded.branchId) throw new Error(`parent ${made.parent_id}`);
            if(made.fork_event !== expected) throw new Error(`fork_event ${made.fork_event}, the position ${at} ms has ${expected} events`);
            if(attempt.heads.m1 !== made.id) throw new Error(`head ${attempt.heads.m1}, expected ${made.id}`);
            return `'${label}' at ${at} ms -> /assignments/${seeded.a1}, branch ${made.id} (continue off ${made.parent_id}, fork_event ${made.fork_event}), head`;
        });

        await step("3 the teacher's 'Відповісти' opens the moment of the request; 'Відповісти звідси' makes the reply and answers the request", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${BASE}/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}`);
            await page.wait_selector('[data-testid="help-reply"]');
            await wait_for(async () => (await page.evaluate(`!document.querySelector('[data-testid="help-reply"]').disabled`)), 40, 250, "the reply button enabled");
            await page.click('[data-testid="help-reply"]');
            await wait_for(async () => (await path_now()) === `/play/branch-${seeded.branchId}`, 80, 250, "the player");
            const search = await page.evaluate("location.search");
            const params = new URLSearchParams(search);
            if(params.get("reply") !== String(seeded.helpId)) throw new Error(`reply=${params.get("reply")}`);
            await player_idle();
            await page.wait_selector('[data-testid="fork"]');
            const label = await page.text_of('[data-testid="fork"]');
            const kind = await page.attr_of('[data-testid="fork"]', "data-kind");
            if(!label.includes("Відповісти звідси") || kind !== "reply") throw new Error(`button '${label}' / ${kind}`);
            await page.shot("02-teacher-reply");
            await page.click('[data-testid="fork"]');
            await wait_for(async () => (await path_now()) === `/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}`, 80, 250, "the student page");
            await wait_for(async () => (await page.evaluate("document.body.innerText")).includes("Відповідь надіслано"), 40, 100, "the notice");
            const attempt = await attempt_now();
            const reply = attempt.branches.find(b => b.kind === "reply");
            if(!reply) throw new Error("no reply branch in the tree");
            if(reply.parent_id !== seeded.branchId || reply.fork_event !== HELP_EVENT_COUNT) throw new Error(`reply off ${reply.parent_id} at ${reply.fork_event}`);
            const help = attempt.help.find(h => h.id === seeded.helpId);
            if(help.reply_branch_id !== reply.id) throw new Error(`reply_branch_id ${help.reply_branch_id}`);
            await wait_for(async () => (await page.evaluate("document.body.innerText")).includes("відповідь викладача"), 40, 250, "the reply in the tree of the page");
            await page.shot("03-after-reply");
            return `'${label}', branch ${reply.id} (reply off ${reply.parent_id} at event ${reply.fork_event}), the request answered, the notice and the tree on the student page`;
        });

        await step("4 a teacher's comment in the player of a submission: mark, list, tooltip, still there after a reload; the list fills the width", async () => {
            const url = `${BASE}/play/submission-${seeded.submissionId}-m1?t=${middle_ms}`;
            await page.open(url);
            await player_idle();
            await page.click('[data-testid="comment-open"]');
            await page.wait_selector('[data-testid="comment-text"]');
            await cdp.send("Input.insertText", { text: COMMENT_TEXT });
            await page.click('[data-testid="comment-save"]');
            await wait_for(async () => (await page.count('[data-testid="timeline-mark"][data-kind="comment"]')) === 1, 40, 250, "the comment mark");
            const saved = (await call("GET", `/api/submissions/${seeded.submissionId}`, null, seeded.teacherCookie)).json.comments;
            if(saved.length !== 1 || saved[0].text !== COMMENT_TEXT) throw new Error(`server comments ${JSON.stringify(saved)}`);
            await page.open(url);
            await player_idle();
            await wait_for(async () => (await page.count('[data-testid="timeline-mark"][data-kind="comment"]')) === 1, 40, 250, "the comment mark after the reload");
            const tip = await page.attr_of('[data-testid="timeline-mark"][data-kind="comment"]', "title");
            const row = await page.text_of('[data-testid="command-item"][data-kind="comment"]');
            if(!tip.includes(COMMENT_TEXT) || !row.includes(COMMENT_TEXT)) throw new Error(`tooltip '${tip}', row '${row}'`);
            const legend = await page.text_of('[data-testid="legend"]');
            if(!legend.includes("Коментар")) throw new Error(`legend '${legend}'`);
            const box = await page.evaluate(`(() => { const r = document.querySelector('[data-testid="command-panel"]').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()`);
            if(box.right < box.width - PANEL_GAP_PX) throw new Error(`the list ends at ${Math.round(box.right)} of ${box.width}: an empty strip on the right`);
            await page.shot("04-comment");
            return `mark with tooltip '${tip}', row '${row}', after reload still there; the list spans ${Math.round(box.left)}..${Math.round(box.right)} of ${box.width}`;
        });

        await step("5 the student sees the comment read-only", async () => {
            await page.login_as(seeded.studentCookie);
            await page.open(`${BASE}/play/submission-${seeded.submissionId}-m1`);
            await player_idle();
            await wait_for(async () => (await page.count('[data-testid="timeline-mark"][data-kind="comment"]')) === 1, 40, 250, "the comment mark");
            if(await page.exists('[data-testid="comment-open"]') || await page.exists('[data-testid="comment-delete"]')) throw new Error("the student has comment controls");
            return "one comment mark, no 'Коментар тут', no delete";
        });

        await step("6 the teacher deletes the comment", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${BASE}/play/submission-${seeded.submissionId}-m1`);
            await player_idle();
            await page.wait_selector('[data-testid="comment-delete"]');
            await page.click('[data-testid="comment-delete"]');
            await wait_for(async () => (await page.count('[data-testid="timeline-mark"][data-kind="comment"]')) === 0, 40, 250, "the mark gone");
            const left = (await call("GET", `/api/submissions/${seeded.submissionId}`, null, seeded.teacherCookie)).json.comments;
            if(left.length !== 0) throw new Error(`${left.length} comments left on the server`);
            return "mark and row gone, none left on the server";
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
