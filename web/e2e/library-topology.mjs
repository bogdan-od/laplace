// The topology editor, a journal from a file and the recording of a broken state on the page of a task.
// A teacher creates a task, types a broken and then a two-machine topology (the scheme follows, save, reload), goes
// back to
// one machine, loads the reference journal from a file (a wrong file is refused), records a broken state on a live
// machine, saves it as the start state and opens that journal in the player.
// Built server (temporary DB) + dev `vite` + headless Chromium. One live machine.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9341 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const JOURNAL_PATH = join(ROOT, "app/test/out/buildroot-1.json");
const VITE_PORT = 5179;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("library-topology-shots");
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


const TASK_TITLE = "libtopo: зламана мережа";
const BROKEN_COMMAND = "echo broken > /tmp/libtopo";
const ONE_MACHINE = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
const TWO_MACHINES = {
    format: "v86-topology/1",
    machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }, { id: "m2", title: "Buildroot 2", profile: "buildroot" }],
    switches: [{ id: "sw1" }],
    links: [{ machine: "m1", switch: "sw1", mode: "access", vlan: 1 }, { machine: "m2", switch: "sw1", mode: "access", vlan: 1 }],
};

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "library-topology-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "library-topo-cdp-"));
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

        const teacher = await call("POST", "/api/auth/register", { name: "Викладач libtopo", login: "teacher-libtopo", password: "password-1", role: "teacher" });
        const cookie = teacher.cookie;

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
        const item_of = async id => (await call("GET", `/api/library/${id}`, null, cookie)).json;
        const where = () => page.evaluate("location.pathname + location.search");
        const disabled = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.disabled ?? null`);
        let taskId = null;

        await step("1 the teacher creates a task; its page has the topology block with the scheme of one machine", async () => {
            await page.login_as(cookie);
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="create-item"]');
            await page.click('[data-testid="create-item"]');
            await page.wait_selector('[data-testid="create-item-dialog"]');
            await page.fill('[data-testid="create-item-title"]', TASK_TITLE);
            await page.click('[data-testid="create-item-submit"]');
            await page.wait_selector('[data-testid="item-page"][data-kind="task"]');
            taskId = Number(await page.attr_of('[data-testid="item-page"]', "data-item"));
            await page.wait_selector('[data-testid="topology-text"]');
            // One machine has no switch, so the layout of the core draws nothing: the block says so.
            if(!(await page.exists('[data-testid="scheme-empty"]'))) throw new Error("no note instead of the scheme of one machine");
            const text = await page.value_of('[data-testid="topology-text"]');
            if(JSON.parse(text).machines.length !== 1) throw new Error("the text is not the topology");
            return `task ${taskId}; the editor shows ${text.split("\n").length} lines and the note "Без комутатора - схеми немає"`;
        });

        await step("2 a syntax error: 'Помилка JSON' under the field, 'Зберегти' is off", async () => {
            await page.fill('[data-testid="topology-text"]', '{ "format": "v86-topology/1", ');
            await page.wait_selector('[data-testid="topology-problems"]');
            const problems = await page.text_of('[data-testid="topology-problems"]');
            if(!problems.includes("Помилка JSON")) throw new Error(`problems '${problems}'`);
            if((await disabled('[data-testid="save"]')) !== true) throw new Error("'Зберегти' is on");
            const reason = await page.text_of('[data-testid="save-problem"]');
            if(!(await page.exists('[data-testid="scheme-empty"]'))) throw new Error("the scheme changed on a broken text");
            if((await page.text_of('[data-testid="record-hint"]')) !== "Спершу збережіть зміни") throw new Error("no hint at the record button");
            if((await disabled('[data-testid="record-start"]')) !== true) throw new Error("the record button is on");
            return `problem '${problems.slice(0, 80)}'; save bar says '${reason.slice(0, 60)}'; the scheme keeps the last correct text`;
        });

        await step("3 two machines and a switch: the scheme has two machines; saved, they survive a reload", async () => {
            await page.fill('[data-testid="topology-text"]', JSON.stringify(TWO_MACHINES, null, 2));
            await wait_for(async () => (await page.count('[data-testid="diagram-machine"]')) === 2, 40, 100, "two machines on the scheme");
            if(await page.exists('[data-testid="topology-problems"]')) throw new Error("problems for a correct text");
            await page.click('[data-testid="save"]');
            await page.wait_gone('[data-testid="unsaved"]');
            const saved = await item_of(taskId);
            if(saved.topology.machines.length !== 2 || saved.topology.switches.length !== 1) throw new Error(`server has ${JSON.stringify(saved.topology)}`);
            await page.open(`${BASE}/library/${taskId}`);
            await page.wait_selector('[data-testid="topology-text"]');
            await wait_for(async () => (await page.count('[data-testid="diagram-machine"]')) === 2, 40, 100, "two machines after the reload");
            const rows = await page.count('[data-testid="machine-row"]');
            if(rows !== 2) throw new Error(`${rows} rows in "Машини"`);
            if(!(await page.value_of('[data-testid="topology-text"]')).includes('"m2"')) throw new Error("the text lost m2");
            await page.shot("01-two-machines");
            return "server has 2 machines and a switch; after the reload the text, the scheme and 'Машини' show both";
        });

        await step("4 back to one machine m1 and saved", async () => {
            await page.fill('[data-testid="topology-text"]', JSON.stringify(ONE_MACHINE, null, 2));
            await page.wait_selector('[data-testid="scheme-empty"]');
            await page.click('[data-testid="save"]');
            await page.wait_gone('[data-testid="unsaved"]');
            const saved = await item_of(taskId);
            if(saved.topology.machines.length !== 1 || saved.topology.machines[0].id !== "m1") throw new Error(`server has ${JSON.stringify(saved.topology)}`);
            if(await page.exists('[data-testid="journals-lost-dialog"]')) throw new Error("a confirmation without journals");
            return "server has m1 only";
        });

        const reference = '[data-testid="journal-row"][data-role="reference"]';
        await step("5 'Завантажити з файлу': a wrong file is refused with a text, the reference journal from buildroot-1.json is loaded", async () => {
            const bad = join(dir, "not-a-journal.json");
            writeFileSync(bad, "this is not json");
            await page.set_file(`${reference} [data-testid="journal-file"]`, bad);
            await page.wait_selector('[data-testid="journal-file-error"]');
            const refusal = await page.text_of('[data-testid="journal-file-error"]');
            if(!refusal.includes("не є коректним JSON")) throw new Error(`refusal '${refusal}'`);
            if((await item_of(taskId)).journals.length !== 0) throw new Error("the server got the wrong file");
            await page.set_file(`${reference} [data-testid="journal-file"]`, JOURNAL_PATH);
            await wait_for(async () => (await page.attr_of(`${reference} [data-testid="journal-state"]`, "data-has")) === "yes", 80, 250, "the reference journal in the row");
            const refs = (await item_of(taskId)).journals;
            if(refs.length !== 1 || refs[0].role !== "reference" || refs[0].node !== "m1") throw new Error(`server has ${JSON.stringify(refs)}`);
            if(await page.exists('[data-testid="journal-file-error"]')) throw new Error("the refusal stayed after a good file");
            return `refused: '${refusal}'; the server has ${JSON.stringify(refs)}`;
        });

        await step("6 'Записати початковий стан': a live machine without the menu, a command is typed, 'Зберегти як стартовий стан' returns to the page", async () => {
            if((await disabled('[data-testid="record-start"]')) === true) throw new Error("the record button is off");
            await page.click('[data-testid="record-start"]');
            await page.wait_selector('[data-testid="record-page"]');
            if((await where()) !== `/library/${taskId}/record`) throw new Error(`address ${await where()}`);
            if(await page.exists('nav')) throw new Error("the shell menu is on the recording page");
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            const prompt = () => wait_for(async () => { const lines = (await page.console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
            await prompt();
            await page.type_line(BROKEN_COMMAND);
            await wait_for(async () => (await page.console_lines()).some(line => line.includes(BROKEN_COMMAND)), 80, 250, "the typed command on the screen");
            await prompt();
            await wait_for(async () => (await disabled('[data-testid="record-save-start"]')) === false, 80, 250, "the save button to turn on");
            await page.shot("02-recording");
            await page.click('[data-testid="record-save-start"]');
            await wait_for(async () => (await where()) === `/library/${taskId}`, 120, 250, "the item page after saving");
            await wait_for(async () => (await page.attr_of('[data-testid="journal-row"][data-role="start"] [data-testid="journal-state"]', "data-has")) === "yes", 40, 250, "the start journal in the row");
            const refs = (await item_of(taskId)).journals.map(j => `${j.node}/${j.role}`).sort();
            if(refs.join(",") !== "m1/reference,m1/start") throw new Error(`server has ${refs}`);
            await page.shot("03-start-saved");
            return `server has ${refs.join(", ")}`;
        });

        await step("7 'Переглянути' the start journal: the player opens and the command list has the typed command", async () => {
            await page.click('[data-testid="journal-row"][data-role="start"] [data-testid="journal-view"]');
            await wait_for(async () => (await where()) === `/play/item-${taskId}-m1-start`, 40, 250, "the player address");
            await page.wait_selector('[data-testid="player"][data-phase="ready"]', BOOT_TRIES);
            await wait_for(async () => (await page.count('[data-testid="command-item"]')) > 0, 80, 250, "commands in the list");
            const titles = await page.evaluate(`[...document.querySelectorAll('[data-testid="command-item"]')].map(el => el.getAttribute("title")).join("|")`);
            if(!titles.includes("echo broken")) throw new Error(`commands: ${titles}`);
            await page.shot("04-player");
            return `commands: ${titles.slice(0, 120)}`;
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
