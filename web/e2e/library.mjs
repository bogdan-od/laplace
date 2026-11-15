// The library list and the page of an item. A teacher creates a task from /library, edits the brief and hints,
// saves, reloads, hands the task to a class, publishes a clip (the code opens in a browser context without cookies,
// "Скасувати публікацію" stops it) and filters the list. No machine runs on the student's side.
// Built server (temporary DB) + dev `vite` + headless Chromium.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8086 (server; fixed in server/src/main.ts), 5179 (vite), 9341 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const JOURNAL = JSON.parse(readFileSync(join(ROOT, "app/test/out/buildroot-1.json"), "utf8"));
const VITE_PORT = 5179;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("library-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const PLAYER_WAIT_TRIES = Number(process.env.TRIES ?? 720); // the browser loads the boot snapshot and replays the journal
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
let on_fail = null;

const TASK_TITLE = "library: нове завдання";
const RENAMED = "library: завдання з підказками";
const BRIEF = "Налаштуйте адресу 10.0.0.2 на інтерфейсі eth0.";
const HINTS = [["Подивіться на ifconfig.", "1"], ["Адресу задає команда ip addr add.", "2"]];
const CLIP_TITLE = "library: кліп для сайту";
const CLIP_FROM_MS = 5000;
const CLASS_NAME = "КН-library";

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
        press_enter: async () => {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
    };
    return driver;
}

// A class (the teacher owns it) and a clip with a start journal; the task of the run is made in the browser.
async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач library", login: "teacher-library", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: CLASS_NAME, subject: "Комп'ютерні мережі" }, teacher.cookie);
    const topology = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
    const clip = (await call("POST", "/api/library", { kind: "clip", title: CLIP_TITLE, topology }, teacher.cookie)).json;
    await call("PUT", `/api/library/${clip.id}/journals/m1?role=start`, JOURNAL, teacher.cookie);
    await call("PATCH", `/api/library/${clip.id}`, { clip_from_ms: CLIP_FROM_MS }, teacher.cookie);
    return { teacherCookie: teacher.cookie, classId: klass.json.id, clipId: clip.id };
}

async function main() {
    if(!existsSync(SERVER_MAIN)) {
        console.log("The server is not built. Run: cd server && npm run build");
        process.exitCode = 1;
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), "library-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "library-cdp-"));
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
        console.log("seeded: class", seeded.classId, "clip", seeded.clipId);

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
        const library = async () => (await call("GET", "/api/library", null, seeded.teacherCookie)).json;
        const item_of = async id => (await call("GET", `/api/library/${id}`, null, seeded.teacherCookie)).json;
        const where = () => page.evaluate("location.pathname + location.search");
        let taskId = null;
        let assignmentId = null;

        await step("1 'Створити завдання' opens a dialog with the title; the new task opens on its own page", async () => {
            await page.login_as(seeded.teacherCookie);
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="library-row"]');
            const before = await page.count('[data-testid="library-row"]');
            await page.click('[data-testid="create-item"]');
            await page.wait_selector('[data-testid="create-item-dialog"]');
            await page.click('[data-testid="create-item-submit"]');
            await page.wait_selector('[data-testid="create-item-dialog"] .text-destructive');
            const refusal = await page.text_of('[data-testid="create-item-dialog"] .text-destructive');
            await page.fill('[data-testid="create-item-title"]', TASK_TITLE);
            await page.click('[data-testid="create-item-submit"]');
            await page.wait_selector('[data-testid="item-page"][data-kind="task"]');
            taskId = Number(await page.attr_of('[data-testid="item-page"]', "data-item"));
            const path = await where();
            if(path !== `/library/${taskId}`) throw new Error(`address ${path}`);
            const title = await page.value_of('[data-testid="item-title"]');
            if(title !== TASK_TITLE) throw new Error(`title '${title}'`);
            const item = await item_of(taskId);
            if(item.kind !== "task" || item.topology.machines.length !== 1) throw new Error("the item on the server differs");
            return `list had ${before} rows; empty title refused ('${refusal}'); opened ${path}`;
        });

        await step("2 the title is edited in place; brief and two hints are saved and survive a reload", async () => {
            await page.fill('[data-testid="item-title"]', RENAMED);
            await page.press_enter();
            await wait_for(async () => (await item_of(taskId)).title === RENAMED, 40, 250, "the new title on the server");
            await page.fill('[data-testid="brief"]', BRIEF);
            await page.wait_selector('[data-testid="unsaved"]');
            for(const [index, [text, penalty]] of HINTS.entries()) {
                await page.click('[data-testid="hint-add"]');
                await wait_for(async () => (await page.count('[data-testid="hint-row"]')) === index + 1, 20, 100, "a hint row");
                await page.fill('[data-testid="hint-text"]', text, index);
                await page.fill('[data-testid="hint-penalty"]', penalty, index);
            }
            await page.click('[data-testid="check-add"]');
            await page.fill('[data-testid="check-command"]', "ping -c1 10.0.0.1");
            // Leaving with unsaved changes asks first; staying keeps the form.
            await page.click('[data-testid="item-back"]');
            await page.wait_selector('[data-testid="leave-dialog"]');
            await page.click('[data-testid="leave-dialog-cancel"]');
            await page.wait_gone('[data-testid="leave-dialog"]');
            if(!(await where()).startsWith(`/library/${taskId}`)) throw new Error("left the page after 'Залишитися'");
            if((await page.value_of('[data-testid="brief"]')) !== BRIEF) throw new Error("the brief was lost");
            await page.click('[data-testid="save"]');
            await page.wait_gone('[data-testid="unsaved"]');
            const saved = await item_of(taskId);
            if(saved.brief !== BRIEF || saved.hints.map(h => `${h.text}|${h.penalty}`).join(";") !== HINTS.map(([t, p]) => `${t}|${p}`).join(";")) throw new Error(`server has ${JSON.stringify(saved.hints)} / '${saved.brief}'`);
            if(saved.checks.length !== 1 || saved.checks[0].node !== "m1") throw new Error(`checks ${JSON.stringify(saved.checks)}`);
            await page.open(`${BASE}/library/${taskId}`);
            await page.wait_selector('[data-testid="hint-row"]');
            if((await page.value_of('[data-testid="brief"]')) !== BRIEF) throw new Error("brief after reload");
            for(const [index, [text, penalty]] of HINTS.entries()) {
                if((await page.value_of('[data-testid="hint-text"]', index)) !== text || (await page.value_of('[data-testid="hint-penalty"]', index)) !== penalty) throw new Error(`hint ${index} after reload`);
            }
            if((await page.value_of('[data-testid="check-command"]')) !== "ping -c1 10.0.0.1") throw new Error("check after reload");
            if((await page.value_of('[data-testid="item-title"]')) !== RENAMED) throw new Error("title after reload");
            await page.shot("01-item-saved");
            return `title '${RENAMED}', ${HINTS.length} hints, 1 check; the leave dialog appeared and "Залишитися" kept the page`;
        });

        await step("3 'Видати класу' hands the task out: a notice with a link, the task is on the class page", async () => {
            await page.click('[data-testid="item-assign"]');
            await page.wait_selector('[data-testid="assign-item-dialog"] [data-testid="assign-item-submit"]');
            const defaultGrade = await page.value_of('[data-testid="assign-max-grade"]');
            const sharedLan = await page.exists('[data-testid="assign-shared-lan"]');
            await page.fill('[data-testid="assign-max-grade"]', "0");
            await page.click('[data-testid="assign-item-submit"]');
            await page.wait_selector('[data-testid="assign-error"]');
            const refusal = await page.text_of('[data-testid="assign-error"]');
            await page.fill('[data-testid="assign-max-grade"]', defaultGrade);
            await page.click('[data-testid="assign-item-submit"]');
            await page.wait_selector('[data-testid="assigned-notice"]');
            const href = await page.attr_of('[data-testid="assigned-link"]', "href");
            const match = /^\/classes\/(\d+)\?a=(\d+)$/.exec(href ?? "");
            if(!match || Number(match[1]) !== seeded.classId) throw new Error(`link ${href}`);
            assignmentId = Number(match[2]);
            const notice = await page.text_of('[data-testid="assigned-notice"]');
            if(!notice.includes("Завдання видано")) throw new Error(`notice '${notice}'`);
            await page.shot("02-assigned");
            await page.click('[data-testid="assigned-link"]');
            await page.wait_selector(`[data-testid="class-page"][data-assignment="${assignmentId}"]`);
            const assignment = (await call("GET", `/api/assignments/${assignmentId}`, null, seeded.teacherCookie)).json;
            if(assignment.max_grade !== 12 || assignment.due_at !== null || assignment.item_id !== taskId || assignment.hints.length !== 2) throw new Error(`assignment ${JSON.stringify({ g: assignment.max_grade, d: assignment.due_at, i: assignment.item_id })}`);
            return `default maximum ${defaultGrade}, 0 refused ('${refusal}'), shared network box: ${sharedLan}; link ${href}; class page shows assignment ${assignmentId}, item_id ${assignment.item_id}`;
        });

        let token = null;
        await step("4 a clip is published: link and iframe code, the link opens without cookies; 'Скасувати публікацію' closes it", async () => {
            await page.open(`${BASE}/library/${seeded.clipId}`);
            await page.wait_selector('[data-testid="item-page"][data-kind="clip"]');
            const clipFrom = await page.text_of('[data-testid="clip-from"]');
            if(!clipFrom.includes("00:05")) throw new Error(`clip-from '${clipFrom}'`);
            const viewHref = await page.attr_of('[data-testid="journal-view"]', "href");
            if(viewHref !== `/play/item-${seeded.clipId}-m1-start`) throw new Error(`view link ${viewHref}`);
            if(await page.exists('[data-testid="item-assign"]')) throw new Error("a clip can be assigned");
            await page.click('[data-testid="item-publish"]');
            await page.wait_selector('[data-testid="publish-dialog"] [data-testid="publish-submit"]');
            const warning = await page.text_of('[data-testid="publish-dialog"]');
            if(!warning.includes("Журнал стане доступним усім, хто має посилання")) throw new Error("no warning");
            await page.click('[data-testid="publish-submit"]');
            await page.wait_selector('[data-testid="embed-code"]');
            const link = await page.value_of('[data-testid="embed-link"]');
            const code = await page.value_of('[data-testid="embed-code"]');
            token = (await item_of(seeded.clipId)).embed_token;
            if(link !== `${BASE}/embed/${token}`) throw new Error(`link ${link}`);
            if(code !== `<iframe src="${link}" width="960" height="640"></iframe>`) throw new Error(`code ${code}`);
            await page.shot("03-published");

            const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
            const browser = await connect(version.webSocketDebuggerUrl);
            cdps.push(browser);
            const { browserContextId } = await browser.send("Target.createBrowserContext");
            const guest_tab = async () => {
                const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
                const target = await wait_for(async () => (await targets()).find(t => t.id === targetId), 40, 250, "the new tab");
                const tab = await connect(target.webSocketDebuggerUrl);
                cdps.push(tab);
                return { tab, guest: await page_driver(tab, "guest") };
            };
            const open = await guest_tab();
            await open.guest.open(link);
            const cookies = (await open.tab.send("Network.getCookies", { urls: [BASE] })).cookies;
            if(cookies.length !== 0) throw new Error(`the guest context has cookies: ${cookies.map(c => c.name)}`);
            await open.guest.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_WAIT_TRIES);
            const title = await open.guest.text_of('[data-testid="player-title"]');
            if(title !== CLIP_TITLE) throw new Error(`guest title '${title}'`);
            await open.tab.send("Page.close").catch(() => undefined);

            await page.click('[data-testid="unpublish"]');
            await wait_for(async () => (await item_of(seeded.clipId)).embed_token === null, 40, 250, "the token to be revoked");
            const api = await fetch(`${BASE}/api/embed/${token}`);
            if(api.status !== 404) throw new Error(`revoked token answers ${api.status}`);
            const closed = await guest_tab();
            await closed.guest.open(link);
            await sleep(4000);
            if(await closed.guest.exists('[data-testid="player"][data-phase="ready"]')) throw new Error("the revoked link still plays");
            const text = await closed.guest.evaluate("document.body.innerText");
            await closed.tab.send("Page.close").catch(() => undefined);
            await page.wait_selector('[data-testid="publish-submit"]');
            await page.shot("04-unpublished");
            return `warning shown; code '${code}'; the link played '${title}' without cookies; after revoking: API ${api.status}, page says '${text.trim().slice(0, 60)}'`;
        });

        await step("5 the list: a kind filter, a title search and 'Видалити' with a confirmation", async () => {
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="library-row"]');
            const kinds = async () => page.evaluate(`[...document.querySelectorAll('[data-testid="library-row"]')].map(r => r.dataset.kind).join(",")`);
            const all = await kinds();
            await page.click('[data-testid="kind-tab"][data-kind="clip"]');
            await wait_for(async () => (await kinds()) === "clip", 20, 100, "only the clip");
            await page.click('[data-testid="kind-tab"][data-kind="task"]');
            await wait_for(async () => (await kinds()) === "task", 20, 100, "only the task");
            const given = await page.text_of('[data-testid="library-row"]');
            if(!given.includes(CLASS_NAME)) throw new Error(`the row does not name the class: '${given}'`);
            await page.click('[data-testid="kind-tab"][data-kind="all"]');
            await page.fill('[data-testid="library-search"]', "ПІДКАЗКАМИ");
            await wait_for(async () => (await kinds()) === "task", 20, 100, "the search result");
            await page.fill('[data-testid="library-search"]', "такого немає");
            await wait_for(async () => (await page.count('[data-testid="library-row"]')) === 0, 20, 100, "no rows");
            await page.shot("05-list-search-empty");
            await page.fill('[data-testid="library-search"]', "");
            await page.click('[data-testid="kind-tab"][data-kind="all"]');
            await page.wait_selector('[data-testid="library-row"]');
            await page.shot("06-list");
            await page.click('[data-testid="library-open"]', (await kinds()).split(",").indexOf("task"));
            await page.wait_selector('[data-testid="item-page"][data-kind="task"]');
            await page.click('[data-testid="item-delete"]');
            await page.wait_selector('[data-testid="delete-dialog"]');
            await page.click('[data-testid="delete-dialog-confirm"]');
            await wait_for(async () => (await where()) === "/library", 40, 250, "the list after deleting");
            await page.wait_selector('[data-testid="library-row"]');
            const left = (await library()).map(i => i.kind).join(",");
            if(left !== "clip") throw new Error(`the server still has ${left}`);
            return `kinds before: ${all}; filter clip / task worked; the task row names '${CLASS_NAME}'; search found and missed; after deleting the server has: ${left}`;
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
