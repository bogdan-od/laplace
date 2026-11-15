// The topology work screen (diagram, frame counters, frame table, machine switch) and the right column
// of a one-machine task, in a real browser. Built server (temporary DB) + dev `vite` + one headless Chromium over CDP.
// Needs the server built (cd server && npm run build). Screenshots go to out/e2e/ (E2E_OUT).
// Needs free ports 8087 (server), 5177 (vite), 9338 (CDP).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_MAIN = join(ROOT, "server/dist/server/src/main.js");
const VITE_PORT = 5177;
const CDP_PORT = 9338;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT = out_dir("work-topology-shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const BOOT_TRIES = 480; // x 250 ms = 2 min for the guest to boot or replay
const PING_TRIES = 120; // x 250 ms
const COUNTER_TRIES = 40;
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

const TOPOLOGY = {
    format: "v86-topology/1",
    title: "Два хости в одній мережі",
    machines: [
        { id: "pc1", title: "pc1", profile: "net", setup: "ifconfig eth0 hw ether {mac} 10.0.10.2 netmask 255.255.255.0 up\n" },
        { id: "srv", title: "srv", profile: "net", setup: "ifconfig eth0 hw ether {mac} 10.0.10.3 netmask 255.255.255.0 up\n" },
    ],
    switches: [{ id: "sw1" }],
    links: [
        { machine: "pc1", switch: "sw1", mode: "access", vlan: 10 },
        { machine: "srv", switch: "sw1", mode: "access", vlan: 10 },
    ],
};
const SINGLE = { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
const PEER_IP = "10.0.10.3";

async function seed() {
    const teacher = await call("POST", "/api/auth/register", { name: "Викладач topo", login: "teacher-topo", password: "password-1", role: "teacher" });
    const klass = await call("POST", "/api/classes", { name: "КН-topo", subject: "Мережі" }, teacher.cookie);
    const assign = async (title, brief, topology) => {
        const item = await call("POST", "/api/library", { kind: "task", title, brief, topology }, teacher.cookie);
        return (await call("POST", `/api/library/${item.json.id}/assign`, { class_id: klass.json.id, due_at: null, max_grade: 100, shared_lan: false }, teacher.cookie)).json.id;
    };
    const net = await assign("topo: пінг між двома машинами", `Налаштуйте мережу і перевірте зв'язок: ping -c 3 ${PEER_IP}.\nДругий рядок умови.`, TOPOLOGY);
    const single = await assign("topo: одна машина", "Виконайте echo topo-ok.\nДругий рядок умови.", SINGLE);
    const student = await call("POST", "/api/auth/register", { name: "Студент topo", login: "student-topo", password: "password-2", role: "student", invite_code: klass.json.invite_code });
    return { net, single, cookie: student.cookie };
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
    const dir = mkdtempSync(join(tmpdir(), "work-topology-"));
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "topo-cdp-"));
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

        const tiles_live = () => evaluate(`document.querySelectorAll('[data-testid="machine-tile"][data-state="live"]').length`);
        const link_count = key => evaluate(`Number(document.querySelector('[data-testid="link"][data-link="${key}"]')?.dataset.count ?? -1)`);
        const frame_protocols = () => evaluate(`[...document.querySelectorAll('[data-testid="frame-row"]')].map(row => row.dataset.protocol)`);
        const scroll_to = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`);

        await step("1 the topology task opens: both machines live, address lines, the column stands beside the terminal", async () => {
            await login_as(seeded.cookie);
            await cdp.send("Page.navigate", { url: `${BASE}/assignments/${seeded.net}` });
            await wait_for(async () => (await tiles_live()) === 2, BOOT_TRIES, 250, "two live machine tiles");
            await wait_for(async () => (await evaluate(`document.querySelectorAll('[data-testid="tile-addresses"]').length`)) === 2, BOOT_TRIES, 250, "two address lines");
            await wait_selector('[data-testid="terminal"][data-state="live"][data-node="pc1"]');
            const beside = await evaluate(`document.querySelector('[data-testid="work-columns"]').dataset.beside`);
            if(beside !== "true") throw new Error(`the right column is not beside the terminal at ${WIDTH} px (data-beside=${beside})`);
            const addresses = await evaluate(`[...document.querySelectorAll('[data-testid="tile-addresses"]')].map(el => el.textContent)`);
            await shot("01-topology-live");
            return `addresses: ${addresses.join(" | ")}`;
        });

        await step(`2 ping -c 3 ${PEER_IP} on pc1 gets 3 packets received`, async () => {
            await wait_prompt();
            await type_line(`ping -c 3 ${PEER_IP}`);
            await wait_for(async () => { const text = (await console_lines()).join("\n"); return text.includes("3 packets received") || text.includes("0% packet loss"); }, PING_TRIES, 250, "the ping summary in the console");
            return "ping summary is in the console of pc1";
        });

        await step("3 link counters are above zero, the frame table has ARP and ICMP", async () => {
            await wait_for(async () => (await link_count("machine:pc1")) > 0 && (await link_count("machine:srv")) > 0, COUNTER_TRIES, 250, "counters on both machine links");
            await wait_for(async () => { const kinds = await frame_protocols(); return kinds.includes("ARP") && kinds.includes("ICMP"); }, COUNTER_TRIES, 250, "ARP and ICMP rows in the frame table");
            const counts = [await link_count("machine:pc1"), await link_count("machine:srv")];
            const kinds = [...new Set(await frame_protocols())];
            await scroll_to('[data-testid="diagram"]');
            await shot("02-ping-diagram");
            await scroll_to('[data-testid="frames"]');
            await shot("03-ping-frames");
            return `frames on links pc1 ${counts[0]}, srv ${counts[1]}; protocols in the table: ${kinds.join(", ")}`;
        });

        await step("4 a click on the second machine in the diagram puts its console in the terminal and ?m= changes", async () => {
            await scroll_to('[data-testid="diagram"]');
            await click('[data-testid="diagram-machine"][data-node="srv"]');
            await wait_for(async () => (await evaluate("location.search")).includes("m=srv"), 40, 250, "m=srv in the address");
            await wait_selector('[data-testid="terminal"][data-node="srv"]', 40);
            await wait_selector('[data-testid="frames"][data-node="srv"]', 40);
            const text = (await console_lines()).join("\n");
            if(text.includes("ping -c 3")) throw new Error("the terminal of srv shows the ping command typed on pc1");
            const selected = await evaluate(`[...document.querySelectorAll('[data-testid="diagram-machine"]')].filter(el => el.dataset.selected === "true").map(el => el.dataset.node)`);
            if(selected.join() !== "srv") throw new Error(`diagram selection: ${selected}`);
            await shot("04-second-machine");
            await click('[data-testid="machine-tile"][data-node="pc1"]');
            await wait_for(async () => (await evaluate("location.search")).includes("m=pc1"), 40, 250, "m=pc1 after a click on the tile");
            return `terminal and frame table switched to srv (console has no ping command), a tile click goes back: ${await evaluate("location.search")}`;
        });

        await step("5 one-machine task: the column has the brief, after submit the submission block", async () => {
            await cdp.send("Page.navigate", { url: `${BASE}/assignments/${seeded.single}` });
            await wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await wait_prompt();
            await wait_selector('[data-testid="aside"] [data-testid="brief"]', 20);
            await type_line("echo topo-ok");
            await wait_for(() => has_line("topo-ok"), 120, 250, "the answer topo-ok in the console");
            await wait_for(async () => (await evaluate(`document.querySelector('[data-testid="save-status"]')?.dataset.status`)) === "saved", 60, 250, "save status saved");
            await click('[data-testid="submit-open"]');
            await wait_selector('[data-testid="submit-confirm"]', 20);
            await click('[data-testid="submit-confirm"]');
            await wait_selector('[data-testid="aside"] [data-testid="submission-block"]', 240);
            await shot("05-single-submitted");
            return "brief and submission block are in the right column";
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
