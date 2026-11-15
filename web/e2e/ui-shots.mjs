// Screenshots of the first screens: built server (temporary DB) + dev `vite` with its proxy + one headless Chromium
// over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE_PORT = 5173;
const CDP_PORT = 9335;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("ui-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const KEY_CTRL = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STUDENTS = [
    { name: "Іван Петренко", login: "ivan.petrenko" },
    { name: "Оксана Шевченко", login: "oksana.shevchenko" },
    { name: "Андрій Коваленко", login: "andrii.kovalenko" },
];

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
    const teacher = await call("POST", "/api/auth/register", { name: "Олена Іваненко", login: "olena", password: "password-1", role: "teacher" });
    const cookie = teacher.cookie;
    const created = await call("POST", "/api/classes", { name: "КН-21", subject: "Комп'ютерні мережі" }, cookie);
    await call("POST", "/api/classes", { name: "КН-22", subject: "Операційні системи" }, cookie);
    const code = created.json.invite_code;
    for(const s of STUDENTS) {
        await call("POST", "/api/auth/register", { name: s.name, login: s.login, password: "password-2", role: "student", invite_code: code });
    }
    return { cookie, code };
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

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "ui-shots-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "ui-shots-cdp-"));
    const children = [];
    const spawn_child = (cmd, args, options) => { const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...options }); children.push(child); return child; };
    let chrome = null;
    let cdp = null;
    const stop_children = () => { for(const child of children) { try { process.kill(-child.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_children(); process.exit(130); });

    try {
        spawn_child("node", ["server/dist/server/src/main.js"], {
            cwd: ROOT, env: { ...process.env, LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") },
        });
        spawn_child("node", [join(ROOT, "web/node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web") });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 80, 250, "server behind the vite proxy");

        const { cookie, code } = await seed();
        console.log("seeded: class invite code", code);

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--force-device-scale-factor=${SCALE}`, `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const target = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 80, 250, "chromium");
        cdp = await connect(target.webSocketDebuggerUrl);
        cdp.on(report_page_problems);
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Page.enable");
        await cdp.send("Network.enable");
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });

        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
        const wait_text = (text, what) => wait_for(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), 120, 250, what ?? `text "${text}"`);
        const wait_selector = selector => wait_for(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 120, 250, `selector ${selector}`);
        const open = async path => { await cdp.send("Page.navigate", { url: BASE + path }); };
        const shot = async name => {
            await sleep(400); // let fonts and transitions settle
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
            console.log("saved", join(OUT, `${name}.png`));
        };
        const key = (type, key_name, code_name, vk, modifiers = 0) => cdp.send("Input.dispatchKeyEvent", { type, key: key_name, code: code_name, windowsVirtualKeyCode: vk, modifiers });

        // 1-2: a visitor
        await open("/login");
        await wait_text("Увійти");
        await shot("1-login");
        await open(`/join/${code}`);
        await wait_text("Зареєструватися та приєднатися");
        await shot("2-join");

        // 3: the teacher's shell; the session cookie from the API answer instead of typing in the form
        const sid = cookie.split("=");
        await cdp.send("Network.setCookie", { name: sid[0], value: sid.slice(1).join("="), url: BASE, httpOnly: true, sameSite: "Lax" });
        await open("/review");
        await wait_text("Мої класи");
        await wait_text("КН-22");
        await shot("3-shell");

        // 4: search with Ctrl+K and typed text
        await key("keyDown", "Control", "ControlLeft", 17, KEY_CTRL);
        await key("keyDown", "k", "KeyK", 75, KEY_CTRL);
        await key("keyUp", "k", "KeyK", 75, KEY_CTRL);
        await key("keyUp", "Control", "ControlLeft", 17);
        await wait_selector('input[aria-label="Пошук"]');
        await cdp.send("Input.insertText", { text: "Петренко" });
        await wait_text("Нічого не знайдено", "search answer (404 until the server route exists is also this text)");
        await shot("4-search");
        await key("keyDown", "Escape", "Escape", 27);
        await key("keyUp", "Escape", "Escape", 27);
        await wait_for(async () => !(await evaluate(`!!document.querySelector('input[aria-label="Пошук"]')`)), 40, 100, "search dialog to close");

        // 5: the bell with the list ("member_joined" x3 from the seeded students)
        await evaluate(`document.querySelector('button[title="Сповіщення"]').click()`);
        await wait_text("Новий студент у класі");
        await shot("5-notifications");
        console.log("RESULT: DONE");
    }
    finally {
        cdp?.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_children();
        await remove_profile(profile);
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch(error => { console.log("RESULT: FAIL", error); process.exitCode = 1; });
