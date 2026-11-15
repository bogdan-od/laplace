// The markup of a lesson and "Переглянути як студент". A lesson with one explanation is seeded through the API.
// The page of the item shows the block "Урок" (1 explanation); "Розмітити урок" opens the player with the markup panel:
// a segment "now on your own" is begun and ended, a start inside a segment is refused, the old note is deleted, the
// lesson is
// saved and survives a reload; "Переглянути як студент" plays it to the segment, "Показати розв'язок" works.
// Built server (temporary DB) + dev `vite` + headless Chromium. One live machine at a time.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5180 (vite), 9342 (CDP).
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
const LESSON_FILE = join(ROOT, "app/test/out/br1.json");
const VITE_PORT = 5180;
const CDP_PORT = 9342;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("lesson-markup-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = Number(process.env.TRIES ?? 720); // the browser loads the boot snapshot, boots or replays a journal
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
let on_fail = null;


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
    const driver = {
        evaluate, exists,
        login_as: async cookie => {
            const [name, ...value] = cookie.split("=");
            await cdp.send("Network.setCookie", { name, value: value.join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        },
        open: url => cdp.send("Page.navigate", { url }),
        wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
        wait_gone: (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`),
        text_of: selector => evaluate(`document.querySelector(${q(selector)})?.innerText ?? ""`),
        value_of: (selector, n = 0) => evaluate(`document.querySelectorAll(${q(selector)})[${n}]?.value ?? ""`),
        attr_of: (selector, name) => evaluate(`document.querySelector(${q(selector)})?.getAttribute(${JSON.stringify(name)})`),
        count: selector => evaluate(`document.querySelectorAll(${q(selector)}).length`),
        shot: async name => {
            await sleep(500);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(OUT, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            files.push(path);
        },
        click: async (selector, n = 0) => {
            const point = await evaluate(`(() => { const el = document.querySelectorAll(${q(selector)})[${n}]; if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}[${n}]`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
        // Focuses the field, selects what is in it and types the text (the page sees real input events).
        fill: async (selector, text, n = 0) => {
            const ok = await evaluate(`(() => { const el = document.querySelectorAll(${q(selector)})[${n}]; if(!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); el.select(); return true; })()`);
            if(!ok) throw new Error(`no field ${selector}[${n}]`);
            if(text === "") await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            else await cdp.send("Input.insertText", { text });
        },
        // Puts a file into the <input type="file"> found by the selector (the page gets a real change event).
        set_file: async (selector, path) => {
            const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
            if(!nodeId) throw new Error(`no file input ${selector}`);
            await cdp.send("DOM.setFileInputFiles", { files: [path], nodeId });
        },
        console_lines: async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim()),
        type_line: async text => {
            await evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            for(const ch of text) {
                await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
                await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
            }
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
        press_enter: async () => {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
    };
    return driver;
}



// The commands of the teacher's journal, as the lesson check counts them: [0] ifconfig, [1] uname, [2] sleep, [3] loop,
// [4] head.
const JOURNAL = read_journal(JSON.parse(readFileSync(LESSON_FILE, "utf8")));
const COMMANDS = commands(JOURNAL.events);
const NOTE = { t: "note", at: COMMANDS[0].index, text: "Спершу ifconfig" };
const SELF_TEXT = "Виконайте: echo alpha";
const ONE_MACHINE = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "lesson-markup-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "markup-cdp-"));
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

        const teacher = await call("POST", "/api/auth/register", { name: "Викладач markup", login: "teacher-markup", password: "password-1", role: "teacher" });
        const cookie = teacher.cookie;
        const created = await call("POST", "/api/library", { kind: "lesson", title: "markup: урок для розмітки", brief: "Подивіться, як працює uname.", topology: ONE_MACHINE }, cookie);
        const lessonId = created.json.id;
        await call("PUT", `/api/library/${lessonId}/journals/m1?role=start`, { ...JOURNAL, header: { ...JOURNAL.header, lesson: [NOTE] } }, cookie);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        cdps.push(cdp);
        const page = await page_driver(cdp, "teacher");
        on_fail = async () => `${await page.evaluate("location.href")}\n${(await page.evaluate("document.body.innerText")).slice(0, 600)}`;
        const where = () => page.evaluate("location.pathname");
        const journal_on_server = async () => (await call("GET", `/api/library/${lessonId}/journals/m1?role=start`, null, cookie)).json;
        const kinds = () => page.evaluate(`[...document.querySelectorAll('[data-testid="markup-item"]')].map(el => el.dataset.kind).join()`);
        const player_idle = () => wait_for(async () => (await page.attr_of('[data-testid="player"]', "data-seeking")) === "false", 240, 250, "the player to stop seeking");
        // Goes to the output of the n-th command of the list and waits until the player stands there.
        const go_to_command = async n => {
            await page.click('[data-testid="command-item"][data-kind="command"]', n);
            await sleep(300);
            await player_idle();
        };
        const markup_ready = async () => {
            await page.wait_selector('[data-testid="player"][data-phase="ready"]', BOOT_TRIES);
            await wait_for(async () => (await page.count('[data-testid="command-item"]')) >= 5, 80, 250, "commands in the list");
            await player_idle();
        };
        await page.login_as(cookie);

        await step("1 the page of the lesson has the block 'Урок' with 1 explanation and no stub", async () => {
            await page.open(`${BASE}/library/${lessonId}`);
            await page.wait_selector('[data-testid="lesson-block"]');
            await wait_for(async () => (await page.text_of('[data-testid="lesson-notes"]')) === "1", 40, 250, "1 explanation in the block");
            const selfs = await page.text_of('[data-testid="lesson-selfs"]');
            if(selfs !== "0") throw new Error(`segments '${selfs}'`);
            if(await page.exists('[data-testid="next-update-card"]')) throw new Error("the stub is still here");
            if((await page.evaluate(`document.querySelector('[data-testid="lesson-markup"]').getAttribute("href")`)) !== `/library/${lessonId}/markup`) throw new Error("wrong link of the markup");
            return `explanations 1, segments ${selfs}`;
        });

        await step("2 'Розмітити урок': the player without the menu has the markup panel with the old note", async () => {
            await page.click('[data-testid="lesson-markup"]');
            await page.wait_selector('[data-testid="markup-panel"]');
            if((await where()) !== `/library/${lessonId}/markup`) throw new Error(`address ${await where()}`);
            if(await page.exists('nav')) throw new Error("the shell menu is on the markup page");
            await markup_ready();
            if((await kinds()) !== "note") throw new Error(`marks ${await kinds()}`);
            if((await page.count('[data-testid="lesson-span"][data-kind="note"]')) !== 1) throw new Error("no note on the timeline");
            await page.shot("01-markup-panel");
            return "the panel lists 1 note, the timeline draws it";
        });

        await step("3 'Сам: початок' after uname, a move on to the loop, 'Сам: кінець': the segment is in the list and on the timeline", async () => {
            await go_to_command(1);
            await page.fill('[data-testid="markup-text"]', SELF_TEXT);
            await page.click('[data-testid="markup-from"]');
            await page.wait_selector('[data-testid="markup-pending"]');
            const pending = await page.text_of('[data-testid="markup-pending"]');
            if(!/подія \d+/.test(pending)) throw new Error(`pending '${pending}'`);
            await go_to_command(3);
            await page.click('[data-testid="markup-to"]');
            await wait_for(async () => (await kinds()) === "note,self", 40, 250, "the segment in the list");
            if(await page.exists('[data-testid="markup-pending"]')) throw new Error("the start stayed open");
            if((await page.value_of('[data-testid="markup-text"]')) !== "") throw new Error("the text stayed in the field");
            if((await page.count('[data-testid="lesson-span"][data-kind="self"]')) !== 1) throw new Error("no band on the timeline");
            const row = await page.evaluate(`document.querySelectorAll('[data-testid="markup-item"]')[1].innerText.replace(/\\s+/g, " ")`);
            await page.shot("02-segment-added");
            return `${pending}; list row '${row}'`;
        });

        await step("4 a start inside the segment is refused with a text; 'Сам: кінець' without a start too", async () => {
            await go_to_command(2);
            await page.click('[data-testid="markup-from"]');
            await page.wait_selector('[data-testid="markup-error"]');
            const refusal = await page.text_of('[data-testid="markup-error"]');
            if(!refusal.includes("всередину")) throw new Error(`refusal '${refusal}'`);
            if(await page.exists('[data-testid="markup-pending"]')) throw new Error("a start was opened inside a segment");
            await page.fill('[data-testid="markup-text"]', "x");
            await page.click('[data-testid="markup-to"]');
            await wait_for(async () => (await page.text_of('[data-testid="markup-error"]')).includes("Спершу натисніть"), 20, 100, "the text about the missing start");
            if((await kinds()) !== "note,self") throw new Error(`marks changed: ${await kinds()}`);
            return `'${refusal}'`;
        });

        await step("5 the old note is deleted; leaving with unsaved marks asks first; 'Зберегти урок' stores them", async () => {
            await page.click('[data-testid="markup-delete"]', 0);
            await wait_for(async () => (await kinds()) === "self", 40, 100, "only the segment in the list");
            await page.wait_selector('[data-testid="markup-unsaved"]');
            await page.click('[data-testid="player-back"]');
            await page.wait_selector('[data-testid="markup-leave-dialog"]');
            await page.click('[data-testid="markup-leave-dialog-cancel"]');
            await page.wait_gone('[data-testid="markup-leave-dialog"]');
            if(!(await where()).startsWith(`/library/${lessonId}/markup`)) throw new Error(`left to ${await where()}`);
            await page.click('[data-testid="markup-save"]');
            await page.wait_gone('[data-testid="markup-unsaved"]');
            const saved = (await journal_on_server()).header.lesson;
            if(saved.length !== 1 || saved[0].t !== "self" || saved[0].text !== SELF_TEXT) throw new Error(`server has ${JSON.stringify(saved)}`);
            if(saved[0].from >= saved[0].to) throw new Error("the segment is not from < to");
            return `server has ${JSON.stringify(saved)}`;
        });

        await step("6 after a reload the marks are in place", async () => {
            await page.open(`${BASE}/library/${lessonId}/markup`);
            await page.wait_selector('[data-testid="markup-panel"]');
            await markup_ready();
            if((await kinds()) !== "self") throw new Error(`marks ${await kinds()}`);
            if((await page.count('[data-testid="lesson-span"][data-kind="self"]')) !== 1) throw new Error("no band on the timeline");
            if(await page.exists('[data-testid="markup-unsaved"]')) throw new Error("a fresh page is unsaved");
            await page.shot("03-after-reload");
            return "one segment in the list and on the timeline";
        });

        await step("7 the block 'Урок' now counts 0 explanations and 1 segment", async () => {
            await page.open(`${BASE}/library/${lessonId}`);
            await page.wait_selector('[data-testid="lesson-block"]');
            await wait_for(async () => (await page.text_of('[data-testid="lesson-selfs"]')) === "1", 40, 250, "1 segment in the block");
            const notes = await page.text_of('[data-testid="lesson-notes"]');
            if(notes !== "0") throw new Error(`explanations '${notes}'`);
            return "explanations 0, segments 1";
        });

        await step("8 'Переглянути як студент': the lesson reaches the segment, the machine is live, 'Показати розв'язок' works", async () => {
            await page.click('[data-testid="lesson-preview"]');
            await page.wait_selector('[data-testid="work-page"][data-kind="lesson"]');
            if((await where()) !== `/library/${lessonId}/preview`) throw new Error(`address ${await where()}`);
            if(await page.exists('nav')) throw new Error("the shell menu is on the preview");
            await page.wait_selector('[data-testid="lesson-panel"][data-lesson-phase="student"]', BOOT_TRIES);
            const task = await page.text_of('[data-testid="lesson-task"]');
            if(!task.includes(SELF_TEXT)) throw new Error(`task '${task}'`);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', 120);
            // The player stops at an event boundary, so the start may stand after the first key of the next command: clear the line (Ctrl+U).
            await sleep(1500);
            await page.evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "u", code: "KeyU", modifiers: 2, windowsVirtualKeyCode: 85 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "u", code: "KeyU", modifiers: 2, windowsVirtualKeyCode: 85 });
            await page.type_line("echo markup-mine");
            await wait_for(async () => (await page.console_lines()).includes("markup-mine"), 120, 250, "the typed line answered");
            if(await page.exists('[data-testid="lesson-complete"]')) throw new Error("the preview has the finish button");
            await page.click('[data-testid="lesson-solution"]');
            await page.wait_selector('[data-testid="lesson-panel"][data-lesson-phase="solved"]', BOOT_TRIES);
            if((await page.console_lines()).includes("markup-mine")) throw new Error("the own line is in the teacher's replay");
            await page.shot("04-preview-solution");
            return `task '${task}', live machine answered, solution shown`;
        });

        await step("9 'Далі' to the end: no 'Завершити урок', the last button leads back to the item", async () => {
            await page.click('[data-testid="lesson-next"]');
            await page.wait_selector('[data-testid="lesson-panel"][data-lesson-phase="done"]', BOOT_TRIES);
            if(await page.exists('[data-testid="lesson-complete"]')) throw new Error("'Завершити урок' in the preview");
            await page.click('[data-testid="lesson-preview-back"]');
            await wait_for(async () => (await where()) === `/library/${lessonId}`, 40, 250, "the item page");
            return "back on the page of the item";
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
