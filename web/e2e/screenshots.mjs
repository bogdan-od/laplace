// Screenshots of almost every screen of the product on the demo data.
// `demo:reset` into a temporary folder (or E2E_REUSE=<folder with db.sqlite and journals/>), the built server serving
// web/dist on port 8093, headless Chromium over CDP (no Vite). Pictures: out/e2e/screenshots-shots/NN-name.png (E2E_OUT),
// 1440x900, scale 1.25, light theme, plus captions.md (one line per picture, Ukrainian).
// Terminal states after a student's work are taken in the player (no live machines); live machines are used only
// by steps 47-51 (the teacher over a live student, the student's network work, the student's grade screen, a lesson,
// recording of a reference).
// Failure shots go to out/e2e/screenshots-fail. A failed step does not stop the independent next ones.
// STEPS=7,10-12 runs only those steps (captions.md keeps the lines of the pictures that exist).
// Needs: cd server && npm run build; cd web && npx vite build. Needs free ports 8093 (server), 9343 and 9344 (CDP).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_DIST = join(ROOT, "server/dist/server/src");
const PORT = 8093;
const CDP_PORT = 9343;
const CDP_PORT_STUDENT = 9344;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = out_dir("screenshots-shots");
const CAPTIONS = join(OUT, "captions.md");
const FAIL_OUT = out_dir("screenshots-fail");
const WIDTH = Number(process.env.E2E_WIDTH ?? 1440);
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 minutes for a machine to boot in the browser
const PLAYER_TRIES = 720; // 3 minutes: the player restores the machine from the journal
const PASSWORD = "student-demo";
const TEACHER = { login: "teacher", password: "teacher-demo" };
const student_login = number => ({ login: `student${String(number).padStart(2, "0")}`, password: PASSWORD });
const user_id_of = number => number + 2; // fixed by the demo seed (student01 = 3)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The pictures in order, by group; the place here is the number in the file name.
const ORDER = [
    // Login
    "vkhid", "reiestratsiia", "vkhid-za-kodom",
    // Teacher, classes
    "spysok-klasiv", "klas-plytky", "plytky-zhyvyi-student", "studenty-menu", "import-csv", "import-rezultat", "zhurnal-dii",
    "otsinky-klasu", "analityka-zavdannia", "zamorozhennia", "inshyi-klas",
    // Teacher, student
    "student-derevo-sproby", "zapyt-dopomohy", "vidpovid-na-zapyt", "zdacha-2-z-2", "otsinka-shtraf-pidkazky", "zdacha-0-z-2",
    "lms-peredano", "lms-ne-peredano", "perekhoplennia-vvodu", "prykhovanyi-terminal",
    // Player
    "pleier-metky", "pleier-komentar", "pleier-poshuk", "porivnyannia-zdach", "vyrizannia-klipu", "publichnyi-klip", "panel-pcap",
    "terminal-ospf", "terminal-ssh", "terminal-brandmauer", "terminal-vlan", "terminal-c",
    // Library
    "biblioteka-filtr", "predmet-skhema-vlan", "topolohiia-pomylka", "zapys-etalonu", "urok-u-biblioteci", "rozmitka-uroku",
    "pereglianuty-yak-student", "opublikovanyi-urok",
    // General
    "na-perevirku-filtry", "kalendar", "spovishchennia-vykladacha", "poshuk", "tost-vydaleno", "nalashtuvannia-lms",
    // Student
    "moi-zavdannia", "moi-zavdannia-zdano", "robota-merezheve-zavdannia", "kadry-merezhi", "pidkazka-zi-shtrafom", "dialog-zapytu-dopomohy",
    "istoriia-sprob", "zamorozhene-zavdannia", "otsinka-i-komentari", "spovishchennia-studenta", "urok", "zavdannia-klasu-os",
];
const files = [];
const results = [];
const captions = new Map();
let failure_hook = null;

// "7", "10-12" or "18-" (to the end), comma separated.
function step_filter(spec) {
    if(!spec) return () => true;
    const ranges = spec.split(",").map(part => {
        const [from, to] = part.split("-");
        return [Number(from), to === undefined ? Number(from) : to === "" ? 99 : Number(to)];
    });
    return n => ranges.some(([from, to]) => n >= from && n <= to);
}
const wanted = step_filter(process.env.STEPS);

async function wait_for(fn, tries, pause_ms, what) {
    for(let i = 0; i < tries; i++) {
        try { const value = await fn(); if(value) return value; } catch { /* not ready yet */ }
        await sleep(pause_ms);
    }
    throw new Error(`timeout waiting for ${what}`);
}

async function api(method, path, body, cookie) {
    const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if(!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return { json: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
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

function report_page_problems(tag) {
    return msg => {
        if(msg.method === "Runtime.exceptionThrown") {
            console.log(`EXCEPTION[${tag}]`, msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
        } else if(msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
            console.log(`CONSOLE.error[${tag}]`, msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
        }
    };
}

// A screen that cannot be taken because of a product defect: the step is reported as skipped, not failed.
class Skip extends Error {}

async function step(n, name, job) {
    if(!wanted(n)) return;
    const label = String(n).padStart(2, "0");
    const started = Date.now();
    try {
        const detail = await job();
        const line = `step ${n} ok: ${name}${detail ? ` - ${detail}` : ""} (${Math.round((Date.now() - started) / 1000)} s)`;
        results.push(line);
        console.log(line);
    } catch(error) {
        if(error instanceof Skip) {
            const line = `step ${n} SKIP: ${name} - ${error.message}`;
            results.push(line);
            console.log(line);
            await failure_hook?.(`skip-${label}`);
            return;
        }
        const line = `step ${n} FAIL: ${name} - ${error.message}`;
        results.push(line);
        console.log(line);
        await failure_hook?.(label);
    }
}

async function page_driver(cdp, tag) {
    cdp.on(report_page_problems(tag));
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    const key = (type, params) => cdp.send("Input.dispatchKeyEvent", { type, ...params });
    const driver = {
        evaluate, exists,
        open: url => cdp.send("Page.navigate", { url }),
        wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
        wait_gone: (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`),
        wait_count: (selector, count, tries = 120) => wait_for(async () => (await driver.count(selector)) === count, tries, 250, `${count} x ${selector}`),
        wait_text: (text, tries = 80) => wait_for(async () => (await driver.body_text()).includes(text), tries, 250, `the text '${text}'`),
        text_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
        attr_of: (selector, name) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`),
        count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
        body_text: () => evaluate("document.body.innerText"),
        // Puts the element under the top of the scroll container (nearest scrollable ancestor), not under a sticky bar.
        scroll_to: selector => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            let box = el.parentElement;
            while(box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
            if(!box) { el.scrollIntoView({ block: "start" }); return true; }
            box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
            return true;
        })()`),
        fill: (selector, text) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`),
        select_value: (selector, value) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        })()`),
        // Radix opens menus on pointerdown, so a real mouse click is needed (element.click() is not enough).
        click: async selector => {
            const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if(!point) throw new Error(`no element ${selector}`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        },
        // Clicks the first element of the selector whose text contains `text`.
        click_text: async (selector, text) => {
            const found = await evaluate(`(() => {
                document.querySelectorAll("[data-e2e-target]").forEach(el => el.removeAttribute("data-e2e-target"));
                const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.innerText.includes(${JSON.stringify(text)}));
                if(!el) return false;
                el.setAttribute("data-e2e-target", "1");
                return true;
            })()`);
            if(!found) throw new Error(`no '${text}' in ${selector}`);
            await driver.click('[data-e2e-target="1"]');
        },
        escape: async () => {
            await key("keyDown", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            await key("keyUp", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        },
        console_lines: async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim()),
        type_line: async (text, terminal = '[data-testid="terminal"]') => {
            await evaluate(`document.querySelector(${JSON.stringify(terminal + " .xterm-helper-textarea")})?.focus()`);
            for(const ch of text) {
                await key("keyDown", { key: ch, text: ch });
                await key("keyUp", { key: ch });
            }
            await key("keyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await key("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
        park_mouse: () => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: WIDTH - 4, y: HEIGHT - 4 }),
        // Waits until nothing is loading, no toast is up (unless the toast is the subject) and the terminals stopped printing.
        settle: async (keep_toast = false) => {
            await driver.park_mouse();
            try {
                await wait_for(async () => !(await evaluate(`/Завантаження/.test(document.body.innerText)`)) && !(await exists('[aria-busy="true"]')) && (keep_toast || !(await exists('[data-sonner-toast]'))), 80, 250, "the page to stop loading");
            } catch(error) { console.log(`WARN settle: ${error.message}`); }
            let previous = null;
            for(let i = 0; i < 20; i++) {
                const now = await evaluate(`[...document.querySelectorAll('.xterm-rows')].map(el => el.innerText).join("|")`);
                if(now === previous) break;
                previous = now;
                await sleep(700);
            }
            await sleep(keep_toast ? 500 : 300);
        },
        set_height: async height => {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: false });
            await sleep(500);
        },
        // slug: the name from ORDER (its place there is the number in the file name); opts.tall: a window taller than usual (a long page keeps its header);
        // opts.toast: a toast is the subject of the picture; opts.error_ok: the page says "Помилка" on purpose.
        shot: async (slug, caption, opts = {}) => {
            const number = ORDER.indexOf(slug) + 1;
            if(number === 0) throw new Error(`the picture ${slug} is not in ORDER`);
            if(opts.tall) await driver.set_height(opts.tall);
            try {
                await driver.settle(opts.toast);
                const text = await driver.body_text();
                if(!opts.error_ok && /Помилка/.test(text)) throw new Error(`'Помилка' on the page of ${String(number).padStart(2, "0")}-${slug}`);
                const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
                const name = `${String(number).padStart(2, "0")}-${slug}`;
                writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
                files.push(name);
                captions.set(number, caption);
            } finally {
                if(opts.tall) await driver.set_height(HEIGHT);
            }
        },
        fail_shot: async name => {
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(FAIL_OUT, `${name}.png`), Buffer.from(data, "base64"));
        },
    };
    driver.wait_prompt = () => wait_for(async () => { const lines = (await driver.console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
    driver.has_line = async text => (await driver.console_lines()).includes(text);
    driver.run = async (text, expect) => {
        await driver.type_line(text);
        if(expect) await wait_for(() => driver.has_line(expect), 120, 250, `'${expect}' in the console after '${text}'`);
        else await sleep(1500);
    };
    // The player of one recording: ready, not seeking, the command list drawn.
    driver.wait_player = async () => {
        await driver.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_TRIES);
        await wait_for(async () => (await driver.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
        await driver.wait_selector('[data-testid="command-item"]', 40);
    };
    // Goes to a command of the list: the last one, or the last one whose text contains `text`.
    driver.seek_command = async text => {
        const index = await evaluate(`(() => {
            const items = [...document.querySelectorAll('[data-testid="command-item"]')];
            const hit = ${JSON.stringify(text ?? "")} === "" ? items.length - 1 : items.map(el => el.innerText).findLastIndex(t => t.includes(${JSON.stringify(text ?? "")}));
            if(hit >= 0) items[hit].setAttribute("data-e2e-target", "1");
            return hit;
        })()`);
        if(index < 0) throw new Error(`no command '${text}' in the player`);
        await driver.click('[data-e2e-target="1"]');
        await wait_for(async () => (await driver.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
        // Either the terminal shows output, or the player reports a replay defect (a product defect, not a failure of the script).
        let defect = "";
        await wait_for(async () => {
            const broken = await driver.body_text();
            if(broken.includes("Машина зупинилась")) { defect = broken.match(/Машина зупинилась[^\n]*/)[0]; return true; }
            return (await driver.console_lines()).filter(Boolean).length > 1;
        }, 120, 250, "the terminal to show output");
        if(defect) throw new Skip(`the player stops after a click on a command: ${defect}`);
    };
    return driver;
}

function launch_chrome(port, profile) {
    return spawn("chromium-browser", [
        "--headless=new", "--disable-features=BackForwardCache", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        `--window-size=${WIDTH},${HEIGHT}`, "--lang=uk", "about:blank",
    ], { stdio: "ignore", env: { ...process.env, LANGUAGE: "uk" } }); // native widgets (file input) follow the browser locale
}

async function open_browser(port, tag) {
    const profile = mkdtempSync(join(tmpdir(), `shots-cdp-${tag}-`));
    const chrome = launch_chrome(port, profile);
    const targets = () => fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
    const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
    const cdp = await connect(first.webSocketDebuggerUrl);
    const page = await page_driver(cdp, tag);
    const current_login = () => page.evaluate(`fetch("/api/me").then(r => r.ok ? r.json() : null).then(me => me?.login ?? null)`);
    // A signed-in browser is redirected away from /login, so the session is ended through the API first.
    const sign_out = async () => {
        await page.open(`${BASE}/login`);
        await wait_for(async () => (await page.evaluate("location.origin")) === BASE && (await page.evaluate("document.readyState")) === "complete", 80, 250, "the app origin");
        if(await current_login()) await page.evaluate(`fetch("/api/auth/logout", { method: "POST" }).then(() => true)`);
        await page.open(`${BASE}/login`);
        await page.wait_selector('input[autocomplete="username"]');
    };
    const sign_in = async ({ login, password }) => {
        if((await page.evaluate("location.origin")) === BASE && (await current_login()) === login) return;
        await sign_out();
        await page.fill('input[autocomplete="username"]', login);
        await page.fill('input[type="password"]', password);
        await page.click('form button[type="submit"]');
        await wait_for(async () => (await page.evaluate("location.pathname")) !== "/login", 80, 250, `leaving /login as ${login}`);
    };
    const close = async () => { cdp.close(); await close_browser(chrome, port); await remove_profile(profile); };
    return { page, sign_in, sign_out, close };
}

function write_captions() {
    const lines = new Map();
    if(existsSync(CAPTIONS)) {
        for(const line of readFileSync(CAPTIONS, "utf8").split("\n")) {
            const found = /^(\d+) - (.+)$/.exec(line);
            if(found) lines.set(Number(found[1]), found[2]);
        }
    }
    for(const [number, text] of captions) lines.set(number, text);
    const exist = new Set(readdirSyncSafe().map(name => Number(name.slice(0, 2))));
    const sorted = [...lines.entries()].filter(([number]) => exist.has(number)).sort((a, b) => a[0] - b[0]);
    writeFileSync(CAPTIONS, sorted.map(([number, text]) => `${String(number).padStart(2, "0")} - ${text}`).join("\n") + "\n");
    return sorted.length;
}

function readdirSyncSafe() {
    return spawnSync("ls", [OUT], { encoding: "utf8" }).stdout.split("\n").filter(name => /^\d\d-.*\.png$/.test(name));
}

// Skipped screens leave gaps in the numbers: close them so the numbering is continuous (names and captions follow).
function compact_numbers() {
    const names = readdirSyncSafe().sort();
    const text = new Map();
    for(const line of readFileSync(CAPTIONS, "utf8").split("\n")) {
        const found = /^(\d+) - (.+)$/.exec(line);
        if(found) text.set(Number(found[1]), found[2]);
    }
    const moved = names.map((name, index) => ({ from: name, to: `${String(index + 1).padStart(2, "0")}${name.slice(2)}`, caption: text.get(Number(name.slice(0, 2))) }));
    for(const { from } of moved) renameSync(join(OUT, from), join(OUT, `tmp-${from}`));
    for(const { from, to } of moved) renameSync(join(OUT, `tmp-${from}`), join(OUT, to));
    writeFileSync(CAPTIONS, moved.map(({ to, caption }) => `${to.slice(0, 2)} - ${caption}`).join("\n") + "\n");
    return moved.length;
}

async function main() {
    if(process.env.COMPACT) {
        console.log(`compacted ${compact_numbers()} pictures`);
        return;
    }
    if(!existsSync(join(SERVER_DIST, "main.js")) || !existsSync(join(ROOT, "web/dist/index.html"))) {
        console.log("Build first: cd server && npm run build; cd web && npx vite build");
        process.exitCode = 1;
        return;
    }
    // E2E_REUSE=<folder with db.sqlite and journals/>: skip the reset and use that data (to debug the steps quickly).
    const reuse = process.env.E2E_REUSE;
    const dir = reuse ?? mkdtempSync(join(tmpdir(), "shots-"));
    mkdirSync(OUT, { recursive: true });
    if(!process.env.STEPS) for(const name of [...readdirSyncSafe(), "captions.md"]) rmSync(join(OUT, name), { force: true });
    mkdirSync(FAIL_OUT, { recursive: true });
    const env = { ...process.env, PORT: String(PORT), LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") };
    let server = null;
    let teacher_browser = null;
    const stop_server = () => { if(server) { try { process.kill(-server.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_server(); process.exit(130); });
    const run_started = Date.now();

    try {
        const reset = reuse ? { status: 0, stdout: "reset skipped (E2E_REUSE)", stderr: "" } : spawnSync("node", [join(SERVER_DIST, "demo/reset.js")], { cwd: ROOT, env, encoding: "utf8" });
        console.log(reset.stdout.split("\n").slice(-4).join("\n"));
        if(reset.status !== 0) throw new Error(`demo:reset failed: ${reset.stderr.slice(-500)}`);
        server = spawn("node", [join(SERVER_DIST, "main.js")], { cwd: ROOT, env, stdio: "ignore", detached: true });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 120, 250, "the server");

        teacher_browser = await open_browser(CDP_PORT, "main");
        const { page, sign_in, sign_out } = teacher_browser;
        failure_hook = async label => {
            await page.fail_shot(`99-fail-${label}`).catch(() => {});
            console.log("PAGE", await page.evaluate("location.href"), JSON.stringify((await page.body_text()).slice(0, 500)));
        };

        // State is looked up through the API of the teacher, so every step can run on its own.
        const teacher_cookie = (await api("POST", "/api/auth/login", TEACHER)).cookie;
        const classes = (await api("GET", "/api/classes", null, teacher_cookie)).json;
        const class_kn = classes.find(c => c.name.startsWith("КН"));
        const class_os = classes.find(c => c.name.startsWith("ОС"));
        if(!class_kn || !class_os) throw new Error(`classes: ${classes.map(c => c.name)}`);
        const detail_kn = (await api("GET", `/api/classes/${class_kn.id}`, null, teacher_cookie)).json;
        const detail_os = (await api("GET", `/api/classes/${class_os.id}`, null, teacher_cookie)).json;
        const by_title = (detail, prefix) => {
            const found = detail.assignments.find(a => a.title.startsWith(prefix));
            if(!found) throw new Error(`no assignment '${prefix}'`);
            return found;
        };
        const config = by_title(detail_kn, "Налаштування");
        const link = by_title(detail_kn, "Зв");
        const lesson = by_title(detail_kn, "Урок");
        const vlan = by_title(detail_kn, "VLAN");
        const firewall = by_title(detail_kn, "Брандмауер");
        const ospf = by_title(detail_kn, "Динамічна");
        const ssh = by_title(detail_kn, "Віддалений");
        const csum = by_title(detail_os, "Програма на C");
        const class_page = (klass, query = "") => `${BASE}/classes/${klass.id}${query}`;
        const student_page = (klass, assignment, number, query = "") => `${class_page(klass)}/assignments/${assignment.id}/students/${user_id_of(number)}${query}`;
        const progress_of = async (assignment, number) => {
            const found = (await api("GET", `/api/assignments/${assignment.id}/students`, null, teacher_cookie)).json.find(s => s.user_id === user_id_of(number));
            if(!found) throw new Error(`student ${number} is not in assignment ${assignment.id}`);
            return found;
        };
        const submission_of = async (assignment, number) => {
            const sub = (await progress_of(assignment, number)).latest_submission;
            if(!sub) throw new Error(`student ${number} has no submission in assignment ${assignment.id}`);
            return sub;
        };
        const library = (await api("GET", "/api/library", null, teacher_cookie)).json;
        const item_of = async assignment => (await api("GET", `/api/assignments/${assignment.id}`, null, teacher_cookie)).json.item_id;
        const open_work = async (browser, assignment, machines) => {
            await browser.page.open(`${BASE}/assignments/${assignment.id}`);
            if(machines > 1) await browser.page.wait_count('[data-testid="machine-tile"][data-state="live"]', machines, BOOT_TRIES);
            await browser.page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await browser.page.wait_prompt();
        };
        const as_teacher = () => sign_in(TEACHER);
        const as_student = number => sign_in(student_login(number));
        const player_of = async (source, seek_text) => {
            await page.open(`${BASE}/play/${source}`);
            await page.wait_player();
            if(seek_text !== null) await page.seek_command(seek_text);
        };
        // The terminal state at the end of a student's work in the player: the last command, its output is above the cursor.
        const terminal_shot = async (slug, caption, assignment, student_number, node, seek_text) => {
            await as_teacher();
            const sub = await submission_of(assignment, student_number);
            await player_of(`submission-${sub.id}-${node}`, seek_text);
            await page.shot(slug, caption);
            return `submission ${sub.id}, ${node}`;
        };

        // Login
        await step(1, "login page", async () => {
            await sign_out();
            await page.shot("vkhid", "Сторінка входу: логін і пароль, посилання на реєстрацію викладача.");
        });
        await step(2, "registration page", async () => {
            await sign_out();
            await page.open(`${BASE}/register`);
            await page.wait_selector('input[autocomplete="new-password"]');
            await page.shot("reiestratsiia", "Реєстрація викладача: ім'я, логін і пароль (студенти реєструються за кодом запрошення).");
        });
        await step(3, "join by invite code", async () => {
            await sign_out();
            const code = detail_kn.invite_code;
            if(!code) throw new Error("the class has no invite code");
            await page.open(`${BASE}/join/${code}`);
            await page.wait_selector('input[autocomplete="new-password"]');
            await page.wait_text(class_kn.name);
            await page.shot("vkhid-za-kodom", `Запрошення до класу ${class_kn.name}: студент без акаунта бачить назву класу й викладача та реєструється одним кроком.`);
        });

        // Teacher, classes
        await step(4, "teacher: two classes in the menu", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, `?a=${config.id}`));
            await page.wait_count('[data-testid="student-tile"]', 14);
            await page.click('button[title="Показати меню"]');
            await page.wait_text("Мої класи");
            await page.wait_text(class_os.name);
            await page.shot("spysok-klasiv", "Викладач: меню зліва показує обидва класи з лічильниками здач і запитів допомоги, посередині відкрито клас КН-31.");
            await page.click('button[title="Сховати меню"]');
            await page.wait_gone('nav.border-r');
        });
        await step(5, "teacher: class page with student tiles", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, `?a=${vlan.id}`));
            await page.wait_count('[data-testid="student-tile"]', 14);
            await page.shot("klas-plytky", "Викладач: сторінка класу, плитки студентів із їхнім станом і останньою командою; угорі код запрошення, вкладки й вибране завдання.", { tall: 960 });
        });
        await step(6, "teacher: students tab with the row menu", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, "?tab=students"));
            await page.wait_selector('[data-testid="member-row"]');
            await page.click('[data-testid="member-menu"]');
            await page.wait_selector('[data-testid="member-remove"]');
            await page.shot("studenty-menu", "Викладач: вкладка «Студенти», у рядку студента відкрито меню «...» з дією «Видалити».");
        });
        await step(7, "teacher: CSV import dialog", async () => {
            await as_teacher();
            await page.open(class_page(class_os, "?tab=students"));
            await page.wait_selector('[data-testid="import-open"]');
            await page.click('[data-testid="import-open"]');
            await page.wait_selector('[data-testid="import-text"]');
            await page.fill('[data-testid="import-text"]', "Мельник Ігор\nСавчук Марія;savchuk");
            await page.shot("import-csv", "Викладач: діалог імпорту списку студентів з CSV, у полі два рядки (прізвище та ім'я або «ім'я;логін»).");
        });
        await step(8, "teacher: activity log", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, "?tab=activity"));
            await page.wait_selector('[data-testid="activity-row"]');
            await page.shot("zhurnal-dii", "Викладач: вкладка «Журнал дій» класу, хто й коли здав роботу, отримав оцінку, написав коментар.");
            return `${await page.count('[data-testid="activity-row"]')} rows`;
        });
        await step(9, "teacher: grades tab", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, "?tab=grades"));
            await page.wait_selector('[data-testid="grade-row"]');
            await page.shot("otsinky-klasu", "Викладач: вкладка «Оцінки», таблиця оцінок усіх студентів класу за всіма завданнями.");
            return `${await page.count('[data-testid="grade-row"]')} rows`;
        });
        await step(10, "teacher: assignment analytics", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, `?a=${vlan.id}&view=analytics`));
            await page.wait_selector('[data-testid="analytics-view"]');
            await page.wait_selector('[data-testid="grade-bar"]');
            await page.shot("analityka-zavdannia", "Викладач: «Аналітика» завдання, розподіл оцінок, час до здачі та студенти, які ще не починали.");
        });
        await step(11, "teacher: frozen assignment", async () => {
            await as_teacher();
            await page.open(class_page(class_kn, `?a=${firewall.id}`));
            await page.wait_count('[data-testid="student-tile"]', 14);
            await wait_for(async () => (await page.attr_of('[data-testid="freeze"]', "data-frozen")) === "true", 40, 250, "the freeze button to show the frozen state");
            await page.shot("zamorozhennia", "Викладач: завдання заморожено для всього класу, кнопка змінилася на «Розморозити».");
        });
        await step(12, "teacher: the second class", async () => {
            await as_teacher();
            await page.open(class_page(class_os));
            await page.wait_selector('[data-testid="student-tile"]');
            await page.shot("inshyi-klas", `Викладач: другий клас ${class_os.name}, завдання «Програма на C» на образі з компілятором.`, { tall: 1000 });
        });

        // Teacher, student
        await step(13, "teacher: student page with the attempt tree and a rollback", async () => {
            await as_teacher();
            await page.open(student_page(class_kn, vlan, 4));
            await page.wait_selector('[data-testid="attempt-tree"]');
            await page.wait_selector('[data-testid="branch-tree"], [data-testid="branch-flat"], [data-testid="branch"]');
            await page.shot("student-derevo-sproby", "Викладач: сторінка студента в завданні VLAN, у дереві спроби видно відкат і повторне виконання команд (дві гілки).", { tall: 1000 });
        });
        await step(14, "teacher: an open help request", async () => {
            await as_teacher();
            await page.open(student_page(class_kn, link, 5));
            await page.wait_selector('[data-testid="help-item"]');
            await page.wait_selector('[data-testid="help-reply"]');
            await page.shot("zapyt-dopomohy", "Викладач: відкритий запит «У мене не працює» від студента з текстом і кнопкою «Відповісти», у дереві спроби позначено момент запиту.", { tall: 1000 });
        });
        await step(15, "teacher: the answer to a request", async () => {
            await as_teacher();
            await page.open(student_page(class_kn, config, 11));
            await page.wait_selector('[data-testid="attempt-tree"]');
            await page.wait_text("відповідь викладача");
            await page.shot("vidpovid-na-zapyt", "Викладач: запит допомоги закрито відповіддю, у дереві спроби є гілка «відповідь викладача».", { tall: 1000 });
        });
        await step(16, "teacher: submission panel 2/2 with the hint penalty", async () => {
            await as_teacher();
            const sub = await submission_of(vlan, 1);
            await page.open(student_page(class_kn, vlan, 1, `?submission=${sub.id}`));
            await page.wait_selector('[data-testid="check-summary"]');
            await page.wait_selector('[data-testid="grade-input"]');
            if(!/2 з 2/.test(await page.text_of('[data-testid="check-summary"]'))) throw new Error(`summary: ${await page.text_of('[data-testid="check-summary"]')}`);
            await page.shot("zdacha-2-z-2", "Викладач: панель здачі завдання VLAN, обидві перевірки пройдено (2 з 2), нижче форма оцінки та посилання на записи.", { tall: 2300 });
            await page.scroll_to('[data-testid="grade-section"]');
            await page.shot("otsinka-shtraf-pidkazky", "Викладач: оцінка 8 замість 10, у примітку записано штраф за відкриту підказку.");
            return await page.text_of('[data-testid="grade-note"]');
        });
        await step(17, "teacher: submission panel 0/2", async () => {
            await as_teacher();
            const sub = await submission_of(vlan, 5);
            await page.open(student_page(class_kn, vlan, 5, `?submission=${sub.id}`));
            await page.wait_selector('[data-testid="check-summary"]');
            if(!/0 з 2/.test(await page.text_of('[data-testid="check-summary"]'))) throw new Error(`summary: ${await page.text_of('[data-testid="check-summary"]')}`);
            await page.shot("zdacha-0-z-2", "Викладач: панель здачі, у якій обидві перевірки не пройдено (0 з 2), результат кожної перевірки видно окремим рядком.", { tall: 2300 });
        });
        await step(18, "teacher: the LMS line, sent and failed", async () => {
            await as_teacher();
            const sent = await submission_of(config, 1);
            await page.open(student_page(class_kn, config, 1, `?submission=${sent.id}`));
            await page.wait_selector('[data-testid="grade-lms"]');
            if(!(await page.text_of('[data-testid="grade-lms"]')).includes("оцінку передано")) throw new Error(`lms: ${await page.text_of('[data-testid="grade-lms"]')}`);
            await page.scroll_to('[data-testid="grade-section"]');
            await page.shot("lms-peredano", "Викладач: під формою оцінки рядок «LMS: оцінку передано», оцінку вже надіслано до Moodle.");
            const failed = await submission_of(config, 2);
            await page.open(student_page(class_kn, config, 2, `?submission=${failed.id}`));
            await page.wait_selector('[data-testid="grade-lms"]');
            if(!(await page.text_of('[data-testid="grade-lms"]')).includes("не передано")) throw new Error(`lms: ${await page.text_of('[data-testid="grade-lms"]')}`);
            await page.scroll_to('[data-testid="grade-section"]');
            await page.shot("lms-ne-peredano", "Викладач: рядок «LMS: не передано» з текстом помилки, оцінка не потрапила до журналу Moodle.");
            return await page.text_of('[data-testid="grade-lms"]');
        });

        // Player
        await step(19, "player: marks, comments (student01 config, m1)", async () => {
            await as_teacher();
            const sub = await submission_of(config, 1);
            await player_of(`submission-${sub.id}-m1`, "");
            await page.wait_selector('[data-testid="timeline-mark"]', 40);
            await page.shot("pleier-metky", "Викладач: програвач запису здачі завдання «Налаштування», на шкалі часу кольорові мітки команд і коментарів, праворуч список команд із коментарем викладача.");
            await page.click('[data-testid="comment-open"]');
            await page.wait_selector('[data-testid="comment-text"]');
            await page.fill('[data-testid="comment-text"]', "Тут краще спершу перевірити адресу інтерфейсу.");
            await page.shot("pleier-komentar", "Викладач: форма коментаря до моменту запису, коментар прикріплюється до поточного місця на шкалі.");
            return `${await page.count('[data-testid="timeline-mark"]')} marks`;
        });
        await step(20, "player: command search", async () => {
            await as_teacher();
            const sub = await submission_of(vlan, 1);
            await player_of(`submission-${sub.id}-m1`, null);
            await page.fill('[data-testid="command-search"]', "ping");
            await wait_for(async () => (await page.count('[data-testid="command-item"]')) > 0, 40, 250, "found commands");
            await page.shot("pleier-poshuk", "Викладач: пошук за командами в записі, у списку лишилися команди, що містять «ping».");
            return `${await page.count('[data-testid="command-item"]')} found`;
        });
        await step(21, "player: compare two submissions", async () => {
            await as_teacher();
            const first = await submission_of(config, 1);
            const second = await submission_of(config, 2);
            await page.open(`${BASE}/compare?a=submission-${first.id}-m1&b=submission-${second.id}-m1`);
            await wait_for(async () => (await page.count('[data-testid="player"][data-phase="ready"][data-seeking="false"]')) === 2, PLAYER_TRIES, 250, "both players ready");
            for(const side of [0, 1]) {
                await page.evaluate(`(() => {
                    document.querySelectorAll('[data-e2e-target]').forEach(el => el.removeAttribute("data-e2e-target"));
                    const items = document.querySelectorAll('[data-testid="player"]')[${side}].querySelectorAll('[data-testid="command-item"]');
                    items[items.length - 1].setAttribute("data-e2e-target", "1");
                })()`);
                await page.click('[data-e2e-target="1"]');
            }
            await wait_for(async () => (await page.count('[data-testid="player"][data-seeking="false"]')) === 2, PLAYER_TRIES, 250, "both players to stop seeking");
            await page.shot("porivnyannia-zdach", "Викладач: порівняння двох здач поруч, ліворуч і праворуч окремі програвачі зі своїми шкалами та списками команд.");
        });
        await step(22, "player: clip bar", async () => {
            await as_teacher();
            const sub = await submission_of(config, 1);
            await player_of(`submission-${sub.id}-m1`, null);
            await page.click('[data-testid="clip-open"]');
            await page.wait_selector('[data-testid="clip-bar"]');
            await page.fill('[data-testid="clip-title"]', "Фрагмент для уроку");
            await page.shot("vyrizannia-klipu", "Викладач: вирізання кліпу, на шкалі виділено відрізок, задано початок, кінець і назву.");
        });
        await step(23, "player: public embed page without a login", async () => {
            const clip = library.find(item => item.kind === "clip");
            if(!clip) throw new Error("no clip in the library");
            const token = (await api("GET", `/api/library/${clip.id}`, null, teacher_cookie)).json.embed_token;
            if(!token) throw new Error("the clip has no embed token");
            await sign_out();
            await page.open(`${BASE}/embed/${token}`);
            await page.wait_player();
            await page.shot("publichnyi-klip", "Публічна сторінка кліпу за посиланням: відтворення без входу в систему, для вставки на сайт.");
            return `token ${token.slice(0, 6)}...`;
        });
        await step(24, "submission panel: pcap button", async () => {
            await as_teacher();
            const sub = await submission_of(vlan, 2);
            await page.open(student_page(class_kn, vlan, 2, `?submission=${sub.id}`));
            await page.wait_selector('[data-testid="submission-players"]');
            // The button appears after the journal of the machine is loaded and its network frames are counted.
            await wait_for(() => page.exists('[data-testid="pcap"]'), 80, 250, "the pcap button");
            await page.scroll_to('[data-testid="submission-players"]');
            const table = await page.exists('[data-testid="frames"]');
            await page.shot("panel-pcap", table
                ? "Викладач: панель здачі VLAN, біля кожної машини кнопка «Завантажити трафік (.pcap)» і таблиця мережевих кадрів."
                : "Викладач: панель здачі VLAN, біля кнопки «Відкрити запис» кожної машини кнопка «Завантажити трафік (.pcap)» з кадрами, що надійшли до машини.", { tall: 2300 });
            return `frames table: ${table}`;
        });
        await step(25, "player: OSPF terminal", () => terminal_shot("terminal-ospf", "Викладач: запис здачі завдання OSPF, у терміналі маршрутизатора r1 видно сусідів BIRD у стані Full і пінг до петлі r3.", ospf, 1, "r1", ""));
        await step(26, "player: SSH terminal", () => terminal_shot("terminal-ssh", "Викладач: запис здачі завдання SSH, у терміналі m2 видно вхід на m1 за SSH без пароля.", ssh, 1, "m2", ""));
        await step(27, "player: firewall terminal", () => terminal_shot("terminal-brandmauer", "Викладач: запис здачі завдання «Брандмауер», у терміналі m2 сторінка m1 відкривається, а ping заборонено правилом iptables.", firewall, 1, "m2", ""));
        await step(28, "player: VLAN terminal", () => terminal_shot("terminal-vlan", "Викладач: запис здачі завдання VLAN, у терміналі m1 пінг до машини в іншому VLAN проходить через маршрутизатор.", vlan, 2, "m1", ""));
        await step(29, "player: C terminal", () => terminal_shot("terminal-c", "Викладач: запис здачі завдання «Програма на C» класу ОС-21, у терміналі видно компіляцію gcc і результат програми.", csum, 15, "m1", ""));


        // Library
        const item_vlan = await item_of(vlan);
        const item_lesson = await item_of(lesson);
        const item_config = await item_of(config);
        await step(30, "library: list with the filter", async () => {
            await as_teacher();
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="library-row"]');
            await page.click('[data-testid="kind-tab"][data-kind="task"]');
            await page.fill('[data-testid="library-search"]', "ма");
            await wait_for(async () => (await page.count('[data-testid="library-row"]')) > 0 && (await page.count('[data-testid="library-row"]')) < library.filter(item => item.kind === "task").length, 40, 250, "the filter to narrow the list");
            await page.shot("biblioteka-filtr", "Викладач: бібліотека з фільтром за видом («Завдання») і пошуком за назвою, показано лише збіги.");
            return `${await page.count('[data-testid="library-row"]')} rows`;
        });
        await step(31, "library: item with the topology scheme", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_vlan}`);
            await page.wait_selector('[data-testid="topology-scheme"]');
            await wait_for(async () => !(await page.exists('[data-testid="scheme-empty"]')), 40, 250, "the scheme to draw");
            await page.shot("predmet-skhema-vlan", "Викладач: предмет бібліотеки «VLAN», умова, JSON-опис топології та схема з trunk-каналом, підказки й перевірки нижче.", { tall: 1700 });
            // The same page with a broken description: the text is cut, the problems are listed, nothing is saved.
            const text = await page.evaluate(`document.querySelector('[data-testid="topology-text"]').value`);
            await page.fill('[data-testid="topology-text"]', text.slice(0, Math.floor(text.length * 0.8)));
            await page.wait_selector('[data-testid="topology-problems"]');
            await page.shot("topolohiia-pomylka", "Викладач: опис топології з синтаксичною помилкою, під полем перелічено проблеми, зберегти такий опис неможливо.", { tall: 1700, error_ok: true });
        });
        await step(32, "library: lesson item", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_lesson}`);
            await page.wait_selector('[data-testid="lesson-block"]');
            await wait_for(async () => (await page.text_of('[data-testid="lesson-notes"]')) !== "…", 40, 250, "the lesson counts");
            await page.shot("urok-u-biblioteci", "Викладач: предмет-урок у бібліотеці, кількість пояснень і відрізків «Тепер сам», кнопки розмітки та перегляду як студент.", { tall: 1300 });
        });
        await step(33, "library: lesson markup", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_lesson}/markup`);
            await page.wait_player();
            await page.wait_selector('[data-testid="markup-item"]');
            await page.shot("rozmitka-uroku", "Викладач: розмітка уроку в програвачі, праворуч список пояснень і відрізків «Тепер сам» з прив'язкою до моментів запису.");
            return `${await page.count('[data-testid="markup-item"]')} items`;
        });
        await step(34, "library: lesson preview as a student", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_lesson}/preview`);
            await page.wait_selector('[data-testid="preview-badge"]');
            // The lesson stops at the "Тепер сам" task and waits for the student: the first explanations have run by then, `ls /` has printed.
            await wait_for(async () => (await page.exists('[data-testid="lesson-task"]')) && (await page.console_lines()).some(line => /\bbin\b.*\bfstab\b/.test(line)), BOOT_TRIES, 250, "the task block and the output of ls /");
            await page.shot("pereglianuty-yak-student", "Викладач: «Переглянути як студент», екран уроку такий самий, як у студента, але нічого не зберігається й не зараховується.");
        });
        await step(35, "library: published lesson", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_lesson}`);
            await page.wait_selector('[data-testid="item-publish"]');
            await page.click('[data-testid="item-publish"]');
            await page.wait_selector('[data-testid="embed-link"]');
            await page.shot("opublikovanyi-urok", "Викладач: урок опубліковано, діалог показує публічне посилання та код для вставки на сайт, є кнопка скасування публікації.");
        });

        // General
        await step(36, "teacher: /review with filters", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            await page.click('[data-testid="review-tab"][data-kind="submission"]');
            await page.select_value('[data-testid="review-class"]', String(class_kn.id));
            await wait_for(async () => (await page.count('[data-testid="review-row"]')) > 0 && (await page.evaluate(`[...document.querySelectorAll('[data-testid="review-row"]')].every(el => el.dataset.kind === "submission")`)), 40, 250, "the filtered list");
            await page.shot("na-perevirku-filtry", "Викладач: сторінка «На перевірку» з фільтром за видом («Здачі») і за класом, у рядках стан автоматичної перевірки.");
            return `${await page.count('[data-testid="review-row"]')} rows`;
        });
        await step(37, "teacher: calendar", async () => {
            await as_teacher();
            await page.open(`${BASE}/calendar`);
            await page.wait_selector('[data-testid="calendar-entry"]');
            await page.shot("kalendar", "Викладач: календар термінів завдань обох класів за місяць, є завантаження в .ics.");
        });
        await step(38, "teacher: notifications menu", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            await page.click('button[title="Сповіщення"]');
            await page.wait_text("Сповіщення");
            await wait_for(async () => (await page.evaluate(`document.querySelectorAll('[role="dialog"] button').length`)) > 3, 40, 250, "the notifications");
            await page.shot("spovishchennia-vykladacha", "Викладач: випадне меню сповіщень, нові здачі та запити «не працює», непрочитані виділено.");
        });
        await step(39, "teacher: search results", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            await page.click_text("header button", "Пошук");
            await page.wait_selector('input[aria-label="Пошук"]');
            await page.fill('input[aria-label="Пошук"]', "VLAN");
            await page.wait_selector('[role="option"]', 40);
            await page.shot("poshuk", "Викладач: загальний пошук (Ctrl+K) за словом «VLAN», результати згруповано: завдання, предмети бібліотеки.");
        });
        await step(40, "teacher: toast with undo", async () => {
            await as_teacher();
            const clip = library.find(item => item.kind === "clip");
            await page.open(`${BASE}/library/${clip.id}`);
            await page.wait_selector('[data-testid="item-delete"]');
            await page.click('[data-testid="item-delete"]');
            await page.wait_selector('[data-testid="delete-dialog-confirm"]');
            await sleep(500); // the dialog animates in; a click during the animation is lost
            await page.click('[data-testid="delete-dialog-confirm"]');
            await page.wait_selector('[data-sonner-toast]');
            await page.shot("tost-vydaleno", "Викладач: після видалення предмета внизу з'являється повідомлення «Предмет видалено» з кнопкою «Скасувати».", { toast: true });
            await page.click_text("[data-sonner-toast] button", "Скасувати");
            await wait_for(async () => (await api("GET", "/api/library", null, teacher_cookie)).json.some(item => item.id === clip.id), 40, 250, "the clip to be restored");
        });
        await step(41, "teacher: settings with the LMS platform", async () => {
            await as_teacher();
            await page.open(`${BASE}/settings`);
            await page.wait_selector('[data-testid="lti-platform"]');
            await page.wait_text("Moodle");
            await page.shot("nalashtuvannia-lms", "Викладач: «Налаштування», розділ «LMS (LTI 1.3)» з адресами для налаштування інструменту й підключеною платформою «Moodle ліцею».", { tall: 1600 });
        });

        // Student (no live machines)
        await step(42, "student09: 'Мої завдання' (overdue, not started)", async () => {
            await as_student(9);
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            await page.shot("moi-zavdannia", "Студент: «Мої завдання», у списку прострочене завдання в роботі (червоний термін) завдання, які ще не розпочато, і заморожене викладачем завдання з позначкою «Призупинено».");
        });
        await step(43, "student01: 'Мої завдання' (done, grades)", async () => {
            await as_student(1);
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            await page.shot("moi-zavdannia-zdano", "Студент: «Мої завдання» студента, що виконав більшість завдань, у рядках стан «Здано» й виставлені оцінки.");
        });
        await step(44, "student01: notifications menu", async () => {
            await as_student(1);
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            await page.click('button[title="Сповіщення"]');
            await page.wait_text("Сповіщення");
            await wait_for(async () => (await page.evaluate(`document.querySelectorAll('[role="dialog"] button').length`)) > 2, 40, 250, "the notifications");
            await page.shot("spovishchennia-studenta", "Студент: меню сповіщень, нові оцінки й коментарі викладача до моментів запису.");
        });
        await step(45, "student06: frozen assignment screen", async () => {
            await as_student(6);
            await page.open(`${BASE}/assignments/${firewall.id}`);
            await page.wait_text("Викладач призупинив роботу");
            await page.shot("zamorozhene-zavdannia", "Студент: екран замороженого завдання, машини не запускаються, доки викладач не відновить роботу.");
        });
        await step(46, "student15: 'Мої завдання' of the second class", async () => {
            await as_student(15);
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 2);
            await page.shot("zavdannia-klasu-os", `Студент класу ${class_os.name}: «Мої завдання» другого класу, завдання «Програма на C» й «Права доступу» з оцінками.`);
        });

        // Live machines: at most four scenarios
        await step(47, "live: the teacher over a live student (tiles, intercept, hidden terminal)", async () => {
            const student = await open_browser(CDP_PORT_STUDENT, "student");
            try {
                await student.sign_in(student_login(9));
                await open_work(student, config, 1);
                await student.page.run("ls /");
                await as_teacher();
                await page.open(class_page(class_kn, `?a=${config.id}`));
                await page.wait_selector('[data-testid="room-online"]', 80);
                await wait_for(async () => (await page.evaluate(`document.querySelector('[data-testid="student-tile"][data-online="true"] [data-testid="tile-terminal"]')?.innerText ?? ""`)).trim() !== "", 120, 250, "the live student's terminal in the tile");
                await page.shot("plytky-zhyvyi-student", "Викладач: плитки класу, студент у кімнаті, у його плитці видно живий вивід терміналу, угорі «У кімнаті 1 з 14».");

                await page.open(student_page(class_kn, config, 9));
                await page.wait_selector('[data-testid="terminals"]', 80);
                await page.wait_selector('[data-testid="teacher-terminal"]', 80);
                await sleep(2000);
                await page.click('[data-testid="intercept"]');
                await page.wait_selector('[data-testid="intercept-note"]');
                await page.shot("perekhoplennia-vvodu", "Викладач: перехоплення вводу, термінал студента позначено рамкою, угорі «Ви вводите в термінал студента» і кнопка «Повернути керування».");
                await page.click('[data-testid="release"]');
                await page.click('[data-testid="tab-hidden"]');
                await page.wait_selector('[data-testid="hidden-note"]');
                await sleep(1000);
                await page.type_line("id", '[data-testid="teacher-terminal"]');
                await wait_for(async () => (await page.evaluate(`document.querySelector('[data-testid="teacher-terminal"] .xterm-rows')?.innerText ?? ""`)).includes("uid=0"), 80, 250, "the hidden shell to answer");
                await page.shot("prykhovanyi-terminal", "Викладач: прихований термінал студента, окрема оболонка root, яку студент не бачить, для перевірок і налаштування.");
            } finally {
                await student.close();
            }
        });
        await step(48, "live: student's network work (scheme, tiles, frames, hint, help, history)", async () => {
            // student09 has not started the VLAN task: a fresh attempt (a restored attempt of the demo students does not replay in the browser).
            await as_student(9);
            await open_work(teacher_browser, vlan, 3);
            await wait_for(async () => (await page.evaluate(`[...document.querySelectorAll('[data-testid="machine-tile"]')].every(el => /([0-9a-f]{2}:){5}[0-9a-f]{2}/.test(el.innerText))`)), 120, 250, "the network setup of the machines");
            await page.run("ifconfig eth0 192.168.10.2 netmask 255.255.255.0 up");
            await page.run("ping -c 2 -W 2 192.168.10.1");
            await page.shot("robota-merezheve-zavdannia", "Студент: робота над мережевим завданням, термінал вибраної машини, схема топології, плитки трьох машин і мережеві адреси.", { tall: 1100 });
            await page.wait_selector('[data-testid="frame-row"]', 80);
            await page.scroll_to('[data-testid="frames"]');
            await page.shot("kadry-merezhi", "Студент: таблиця останніх мережевих кадрів вибраної машини в стилі tcpdump (ARP, ICMP).");
            await page.click('[data-testid="hints-open"]');
            await page.click('[data-testid="hint-open"]');
            await page.wait_selector('[data-testid="hint-confirm"]');
            await page.click('[data-testid="hint-confirm"]');
            await page.wait_selector('[data-testid="hint-text"]');
            await page.shot("pidkazka-zi-shtrafom", "Студент: відкрита підказка із записаним штрафом, підтвердження показує, скільки балів буде знято з оцінки.");
            await page.escape();
            await page.wait_gone('[data-testid="hints-dialog"]');
            await page.click('[data-testid="help-open"]');
            await page.wait_selector('[data-testid="help-text"]');
            await page.fill('[data-testid="help-text"]', "Пінг між m1 і m2 не проходить, хоча підінтерфейси створено.");
            await page.shot("dialog-zapytu-dopomohy", "Студент: діалог «У мене не працює», студент описує проблему, запит піде викладачу разом із місцем у записі.");
            await page.escape();
            await page.wait_gone('[data-testid="help-dialog"]');
            await page.click('[data-testid="history-open"]');
            await page.wait_selector('[data-testid="history-machine"]');
            await page.shot("istoriia-sprob", "Студент: історія спроби по машинах, звідси можна повернутися до будь-якого збереженого моменту.");
        });
        await step(49, "live: student sees the grade and the comments", async () => {
            await as_student(1);
            await open_work(teacher_browser, config, 1);
            await page.wait_selector('[data-testid="submission-block"]', 60);
            await page.wait_selector('[data-testid="submission-comment"]', 60);
            await page.shot("otsinka-i-komentari", "Студент: оцінка, примітка й коментарі викладача до моментів запису під терміналом завдання.");
        });
        await step(50, "live: the lesson", async () => {
            await as_student(5);
            await page.open(`${BASE}/assignments/${lesson.id}`);
            await page.wait_selector('[data-testid="lesson-note"]', BOOT_TRIES);
            await wait_for(async () => (await page.text_of('[data-testid="lesson-note"]')).trim().length > 0, BOOT_TRIES, 250, "the lesson note");
            const phase = () => page.attr_of('[data-testid="lesson-panel"]', "data-lesson-phase");
            for(let i = 0; i < 12 && (await phase()) !== "student"; i++) {
                if(!(await page.evaluate(`document.querySelector('[data-testid="lesson-next"]')?.disabled ?? true`))) await page.click('[data-testid="lesson-next"]');
                await sleep(2500);
            }
            if((await phase()) !== "student") throw new Error(`the lesson did not reach the student's segment, phase ${await phase()}`);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', 120);
            await page.wait_prompt();
            await page.shot("urok", "Студент: урок, пояснення викладача зверху, список відрізків і завдання «Тепер сам», яке студент виконує в живому терміналі.");
        });
        await step(51, "live: recording of a reference", async () => {
            await as_teacher();
            await page.open(`${BASE}/library/${item_config}/record`);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await page.wait_prompt();
            await page.wait_selector('[data-testid="record-save-reference"]');
            await page.shot("zapys-etalonu", "Викладач: режим запису еталона, машина працює наживо, угорі кнопки збереження початкового стану та еталонного журналу.");
        });

        // Last: it adds two students to the second class.
        await step(52, "teacher: CSV import result with the passwords", async () => {
            await as_teacher();
            await page.open(class_page(class_os, "?tab=students"));
            await page.wait_selector('[data-testid="import-open"]');
            await page.click('[data-testid="import-open"]');
            await page.wait_selector('[data-testid="import-text"]');
            await page.fill('[data-testid="import-text"]', "Мельник Ігор\nСавчук Марія;savchuk");
            await page.click('[data-testid="import-submit"]');
            await page.wait_selector('[data-testid="import-table"]');
            await page.wait_count('[data-testid="import-row"]', 2);
            await page.shot("import-rezultat", "Викладач: результат імпорту, для нових студентів створено логіни й паролі, які показано лише один раз, є кнопка «Скопіювати все».");
        });

        console.log(`RESULT: ${results.some(line => line.includes(" FAIL:")) ? "FAIL" : "DONE"} in ${Math.round((Date.now() - run_started) / 1000)} s`);
    }
    finally {
        await teacher_browser?.close();
        stop_server();
        if(!reuse) rmSync(dir, { recursive: true, force: true });
        console.log(`captions.md: ${write_captions()} lines`);
        if(!process.env.STEPS && !process.env.COMPACT) console.log(`numbers compacted: ${compact_numbers()} pictures`);
        console.log("\nSteps:");
        for(const line of results) console.log(line);
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
