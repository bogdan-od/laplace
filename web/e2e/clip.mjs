// "Вирізати кліп", the traffic file (.pcap), "Порівняти з еталоном", a library item journal on its own and a
// published item in a browser context without a login. The attempt is made through the API (a recorded journal with
// network frames), so no machine runs on the student's side; the machines of the players run in the browser from
// journals.
// Built server (temporary DB) + dev `vite` + headless Chromium.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9340 (CDP).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { event_times } from "../../app/core/journal.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const REFERENCE = JSON.parse(readFileSync(join(ROOT, "app/test/out/buildroot-1.json"), "utf8"));
// A recording of `ping` between two machines (a copy of a journal the server kept): 10 incoming frames, 30 events.
const NET = JSON.parse(readFileSync(join(ROOT, "web/e2e/fixtures/ping-net-frames.json"), "utf8"));
NET.header.machine = "m1"; // the student's journal of node m1, as a live machine would write it
const VITE_PORT = 5179;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("clip-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const SERVER_WAIT_TRIES = 720; // x 250 ms = 3 min for the server to replay a machine
const PLAYER_WAIT_TRIES = Number(process.env.TRIES ?? 720); // the browser loads the boot snapshot and replays up to the position
const DAY_MS = 86_400_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
let on_fail = null;

const times = event_times(NET);

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
            console.log(`CONSOLE.${msg.params.type}[${who}]`, msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 1500));
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
        if(on_fail) console.log("PAGE AT THE FAILURE:", await on_fail().catch(() => "(unreadable)"));
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
const TITLE = "clip: кліп і порівняння";
const STUDENT_NAME = "Лисенко Ірина";
const CLIP_TITLE = "Кліп з розсилкою кадрів";
const SEEK_TOLERANCE_MS = 100;
const CLIP_EVENTS = 20;
const NET_FRAMES = NET.events.filter(e => e.t === "net").length;

// A class with a task of one buildroot machine (the teacher's reference journal in the item), one student who recorded a
// session with network frames and handed it in, and a clip of that session, published.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач clip", login: "teacher-clip", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-clip", subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const item = (await call("POST", "/api/library", { kind: "task", title: TITLE, brief: "Виконайте команди з журналу.", topology }, teacher.cookie)).json.id;
    await call("PUT", `/api/library/${item}/journals/m1?role=reference`, REFERENCE, teacher.cookie);
    const a1 = (await call("POST", `/api/library/${item}/assign`, { class_id: klass.json.id, due_at: Date.now() + 3 * DAY_MS, max_grade: 10, shared_lan: false }, teacher.cookie)).json.id;
    const student = await call("POST", "/api/auth/register", { name: STUDENT_NAME, login: "lysenko-clip", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    const attempt = (await call("POST", `/api/assignments/${a1}/attempt`, null, student.cookie)).json;
    const branch = (await call("POST", `/api/attempts/${attempt.id}/branches`, { node: "m1", parent: null, kind: "start", header: NET.header, make_head: true }, student.cookie)).json;
    await call("PUT", `/api/branches/${branch.id}/events`, { from: 0, events: NET.events }, student.cookie);
    const head = { node: "m1", branch_id: branch.id, event_count: NET.events.length };
    const submission = (await call("POST", `/api/attempts/${attempt.id}/submit`, { heads: [head] }, student.cookie)).json;
    const clip = (await call("POST", "/api/library/clip", { branch_id: branch.id, to_event: CLIP_EVENTS, from_ms: Math.round(times[CLIP_EVENTS / 2]), title: CLIP_TITLE }, teacher.cookie)).json;
    const embed = (await call("POST", `/api/library/${clip.id}/embed`, null, teacher.cookie)).json;
    return {
        teacherCookie: teacher.cookie, studentCookie: student.cookie, classId: klass.json.id, a1, item, studentId: student.json.id,
        attemptId: attempt.id, submissionId: submission.id, branchId: branch.id, clip, token: embed.token,
    };
}

// A pcap file read back: the records as { sec, usec, length }.
function read_pcap(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if(view.getUint32(0, true) !== 0xa1b2c3d4 || view.getUint16(4, true) !== 2 || view.getUint16(6, true) !== 4 || view.getUint32(16, true) !== 65535 || view.getUint32(20, true) !== 1) {
        throw new Error("the global header is not libpcap 2.4 / snaplen 65535 / ethernet");
    }
    const records = [];
    for(let at = 24; at < bytes.length;) {
        const length = view.getUint32(at + 8, true);
        records.push({ sec: view.getUint32(at, true), usec: view.getUint32(at + 4, true), length });
        at += 16 + length;
    }
    return records;
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "clip-"));
    const downloads = mkdtempSync(join(tmpdir(), "clip-downloads-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "clip-cdp-"));
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
        console.log("seeded: class", seeded.classId, "assignment", seeded.a1, "student", seeded.studentId, "submission", seeded.submissionId, "branch", seeded.branchId, "clip", seeded.clip.id);
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
        on_fail = async () => `${await page.evaluate("location.href")}\n${(await page.evaluate("document.body.innerText")).slice(0, 500)}`;
        const idle = async (scope = "") => {
            await page.wait_selector(`${scope} [data-testid="player"][data-phase="ready"]`.trim(), PLAYER_WAIT_TRIES);
            await wait_for(async () => (await page.attr_of(`${scope} [data-testid="player"]`.trim(), "data-seeking")) === "false", PLAYER_WAIT_TRIES, 250, "the seek to the moment");
        };
        const position = async (scope = "") => Number(await page.attr_of(`${scope} [data-testid="player"]`.trim(), "data-position"));
        const events_at = ms => times.filter(t => t <= ms + 0.5).length;
        // A click on the timeline at a fraction of its width: the player seeks there.
        const click_timeline = async fraction => {
            const point = await page.evaluate(`(() => { const r = document.querySelector('[data-testid="timeline"]').getBoundingClientRect(); return { x: r.x + r.width * ${fraction}, y: r.y + r.height / 2 }; })()`);
            for(const [type, extra] of [["mouseMoved", {}], ["mousePressed", { button: "left", clickCount: 1 }], ["mouseReleased", { button: "left", clickCount: 1 }]]) {
                await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
            }
            await sleep(300);
            await idle();
            return position();
        };
        const library = async () => (await call("GET", "/api/library", null, seeded.teacherCookie)).json;

        await step("1 the teacher cuts a clip in the player of a branch: ends, order check, title, saved to the library", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${BASE}/play/branch-${seeded.branchId}`);
            await idle();
            await page.wait_selector('[data-testid="clip-open"]');
            await page.click('[data-testid="clip-open"]');
            await page.wait_selector('[data-testid="clip-bar"]');
            if(!(await page.evaluate(`document.querySelector('[data-testid="clip-save"]').disabled`))) throw new Error("save is on before any end is set");
            // End before start: off, with the reason.
            const late = await click_timeline(0.7);
            await page.click('[data-testid="clip-start"]');
            const early = await click_timeline(0.3);
            await page.click('[data-testid="clip-end"]');
            if(!(await page.evaluate(`document.querySelector('[data-testid="clip-save"]').disabled`))) throw new Error("save is on when the end is before the start");
            const problem = await page.text_of('[data-testid="clip-problem"]');
            if(!problem.includes("Кінець")) throw new Error(`problem '${problem}'`);
            // Equal ends: off as well.
            await page.click('[data-testid="clip-start"]');
            if(!(await page.evaluate(`document.querySelector('[data-testid="clip-save"]').disabled`))) throw new Error("save is on for an empty interval");
            // Normal: start early, end late.
            await page.click('[data-testid="clip-start"]');
            const end_at = await click_timeline(0.7);
            await page.click('[data-testid="clip-end"]');
            if(await page.evaluate(`document.querySelector('[data-testid="clip-save"]').disabled`)) throw new Error("save is off for a normal interval");
            const title = await page.value_of('[data-testid="clip-title"]');
            if(!title.includes(TITLE) || !title.includes(STUDENT_NAME) || !/\d\d:\d\d-\d\d:\d\d/.test(title)) throw new Error(`default title '${title}'`);
            if(!(await page.exists('[data-testid="clip-range"]'))) throw new Error("no interval on the timeline");
            await page.shot("01-clip-bar");
            const before = new Set((await library()).map(i => i.id));
            await page.click('[data-testid="clip-save"]');
            await wait_for(async () => (await page.evaluate("document.body.innerText")).includes("Кліп збережено"), 40, 250, "the notice");
            if(await page.exists('[data-testid="clip-bar"]')) throw new Error("the clip mode did not close");
            const made = await wait_for(async () => (await library()).find(i => !before.has(i.id) && i.kind === "clip"), 40, 250, "the clip in the library");
            const detail = (await call("GET", `/api/library/${made.id}`, null, seeded.teacherCookie)).json;
            const journal = (await call("GET", `/api/library/${made.id}/journals/m1?role=start`, null, seeded.teacherCookie)).json;
            const expected_events = events_at(end_at);
            if(detail.title !== title) throw new Error(`title '${detail.title}'`);
            if(Math.abs(detail.clip_from_ms - early) > SEEK_TOLERANCE_MS) throw new Error(`clip_from_ms ${detail.clip_from_ms}, the start was at ${early}`);
            if(journal.events.length !== expected_events) throw new Error(`${journal.events.length} events in the clip, the end at ${end_at} ms has ${expected_events}`);
            const link_ok = await page.evaluate("document.body.innerText.includes('Відкрити в бібліотеці')");
            return `late ${late} / early ${early} refused (off, '${problem}'), equal refused; saved '${detail.title}' (clip ${made.id}, from ${detail.clip_from_ms} ms, ${journal.events.length} events up to ${end_at} ms), notice with link: ${link_ok}`;
        });

        await step("2 the traffic file from the panel of a submission: tcpdump reads as many packets as the journal has frames", async () => {
            await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
            await page.open(`${BASE}/classes/${seeded.classId}/assignments/${seeded.a1}/students/${seeded.studentId}?submission=${seeded.submissionId}`);
            await page.wait_selector('[data-testid="submission-panel"] [data-testid="pcap"][data-frames]');
            await wait_for(async () => (await page.attr_of('[data-testid="pcap"]', "data-frames")) === String(NET_FRAMES), 80, 250, "the frame count on the button");
            if(await page.evaluate(`document.querySelector('[data-testid="pcap"]').disabled`)) throw new Error("the button is off");
            const name = `${seeded.studentId}-${seeded.submissionId}-m1.pcap`;
            await page.shot("02-submission-panel");
            await page.click('[data-testid="pcap"]');
            const file = await wait_for(() => { const found = readdirSync(downloads).find(f => f === name); return found ? join(downloads, found) : null; }, 80, 250, `the file ${name}`);
            await sleep(300);
            const bytes = new Uint8Array(readFileSync(file));
            const records = read_pcap(bytes);
            if(records.length !== NET_FRAMES) throw new Error(`${records.length} records, ${NET_FRAMES} frames in the journal`);
            const first_net = NET.events.findIndex(e => e.t === "net");
            const want_us = Math.round((NET.header.epoch + times[first_net]) * 1000);
            const got_us = records[0].sec * 1_000_000 + records[0].usec;
            if(got_us !== want_us) throw new Error(`first frame at ${got_us} us, expected ${want_us}`);
            let note = "tcpdump: not installed, the records were counted by reading the file";
            try {
                const out = execFileSync("tcpdump", ["-nn", "-tt", "-r", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                const packets = out.split("\n").filter(line => line.trim() !== "").length;
                if(packets !== NET_FRAMES) throw new Error(`tcpdump -r shows ${packets} packets, ${NET_FRAMES} frames in the journal`);
                note = `tcpdump -r shows ${packets} packets`;
            } catch(error) {
                if(error.code !== "ENOENT") throw error;
            }
            return `${name}: ${bytes.length} bytes, ${records.length} records for ${NET_FRAMES} frames, first at ${got_us} us (epoch + event time); ${note}`;
        });

        await step("3 'Порівняти з еталоном' opens two players side by side; the keys and ?t= belong to the left one", async () => {
            await page.wait_selector('[data-testid="compare-open"]');
            const href = await page.evaluate(`document.querySelector('[data-testid="compare-open"]').getAttribute("href")`);
            const want = `/compare?a=submission-${seeded.submissionId}-m1&b=item-${seeded.item}-m1-reference`;
            if(href !== want) throw new Error(`href '${href}', expected '${want}'`);
            await page.click('[data-testid="compare-open"]');
            await wait_for(async () => (await page.evaluate("location.pathname")) === "/compare", 40, 250, "the compare screen");
            const left = '[data-testid="compare-left"]';
            const right = '[data-testid="compare-right"]';
            await idle(left);
            await idle(right);
            if((await page.count('[data-testid="player"]')) !== 2) throw new Error("not two players");
            if(await page.exists('[data-testid="player-back"]') === false) throw new Error("no way back on the compare screen");
            const fits = await page.evaluate(`[...document.querySelectorAll('[data-testid="terminal"]')].map(t => ({ font: t.dataset.font, scroll: t.scrollWidth, client: t.clientWidth, cols: t.querySelector('.xterm-screen')?.clientWidth ?? 0 }))`);
            for(const f of fits) if(f.scroll > f.client + 2) throw new Error(`a terminal overflows: ${JSON.stringify(f)}`);
            const space = () => page.press(" ", "Space", 32, " ");
            await space();
            await wait_for(async () => (await page.attr_of(`${left} [data-testid="player"]`, "data-paused")) === "false", 40, 250, "the left player playing");
            const right_paused = await page.attr_of(`${right} [data-testid="player"]`, "data-paused");
            if(right_paused !== "true") throw new Error(`the right player reacted to the key (paused=${right_paused})`);
            await space();
            await wait_for(async () => (await page.attr_of(`${left} [data-testid="player"]`, "data-paused")) === "true", 40, 250, "the left player paused");
            await idle(left);
            await wait_for(async () => new URLSearchParams(await page.evaluate("location.search")).has("t"), 40, 250, "?t= of the left player");
            const search = new URLSearchParams(await page.evaluate("location.search"));
            if(search.get("a") === null || search.get("b") === null) throw new Error(`a/b lost: ${search}`);
            await page.shot("03-compare");
            return `two players, terminals ${JSON.stringify(fits)}; Space moved only the left one; ${search}`;
        });

        await step("4 the reference journal of an item opens on its own, without the actions of a recording", async () => {
            await page.open(`${BASE}/play/item-${seeded.item}-m1-reference`);
            await idle();
            const title = await page.text_of('[data-testid="player-title"]');
            const subtitle = await page.text_of('[data-testid="player-subtitle"]');
            if(title !== TITLE || !subtitle.includes("m1") || !subtitle.includes("еталон")) throw new Error(`title '${title}', subtitle '${subtitle}'`);
            for(const id of ["fork", "clip-open", "comment-open"]) if(await page.exists(`[data-testid="${id}"]`)) throw new Error(`${id} is on a library item`);
            await page.shot("04-item-reference");
            return `title '${title}', subtitle '${subtitle}', no fork / clip / comment`;
        });

        await step("5 a published item opens in a browser context without cookies, at /embed/<token> and /play/embed-<token>", async () => {
            const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
            const browser = await connect(version.webSocketDebuggerUrl);
            cdps.push(browser);
            const { browserContextId } = await browser.send("Target.createBrowserContext");
            const check = async (path, shotName) => {
                const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
                const target = await wait_for(async () => (await targets()).find(t => t.id === targetId), 40, 250, "the new tab");
                const tab = await connect(target.webSocketDebuggerUrl);
                cdps.push(tab);
                const guest = await page_driver(tab, "guest");
                await guest.open(`${BASE}${path}`);
                const cookies = (await tab.send("Network.getCookies", { urls: [BASE] })).cookies;
                if(cookies.length !== 0) throw new Error(`the new context has cookies: ${cookies.map(c => c.name)}`);
                const scope = '[data-testid="player"][data-phase="ready"]';
                await guest.wait_selector(scope, PLAYER_WAIT_TRIES);
                await wait_for(async () => (await guest.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_WAIT_TRIES, 250, "the start moment");
                const title = await guest.text_of('[data-testid="player-title"]');
                const at = Number(await guest.attr_of('[data-testid="player"]', "data-position"));
                const where = await guest.evaluate("location.pathname");
                if(title !== CLIP_TITLE) throw new Error(`title '${title}'`);
                if(where !== path) throw new Error(`the address became ${where}`);
                if(Math.abs(at - seeded.clip.clip_from_ms) > SEEK_TOLERANCE_MS) throw new Error(`starts at ${at} ms, the clip from ${seeded.clip.clip_from_ms}`);
                for(const id of ["player-back", "clip-open", "fork", "pcap", "comment-open"]) if(await guest.exists(`[data-testid="${id}"]`)) throw new Error(`${id} in the published player`);
                if(shotName) await guest.shot(shotName);
                await tab.send("Page.close").catch(() => undefined);
                return `${path}: '${title}' at ${at} ms`;
            };
            const a = await check(`/embed/${seeded.token}`, "05-embed");
            const b = await check(`/play/embed-${seeded.token}`, null);
            const revoked = await fetch(`${BASE}/api/embed/${"x".repeat(22)}`);
            return `${a}; ${b}; a made-up token -> ${revoked.status}`;
        });
        console.log("RESULT: DONE");
    }
    finally {
        for(const cdp of cdps) cdp.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_children();
        await remove_profile(profile);
        rmSync(dir, { recursive: true, force: true });
        rmSync(downloads, { recursive: true, force: true });
        console.log("\nSteps:");
        for(const line of results) console.log(line);
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
