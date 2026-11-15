// The whole demo path in a real browser on the built server with the demo data and live v86 machines.
// `demo:reset` into a temporary folder (or E2E_REUSE=<folder>), the built server serving web/dist on port 8092, headless
// Chromium over CDP (no Vite). student10 did not start the "config" and "link" assignments in the demo: he does them
// now, the teacher checks, replies and grades, the student sees the grade, then the lesson and the six-machine
// submission.
// Screenshots: out/e2e/demo-path-shots/NN-name.png (E2E_OUT), 1440x900, scale 1.25, light theme.
// Failure shots go to out/e2e/demo-path-fail. A failed step does not stop the independent next ones.
// STEPS=7,10-12 runs only those steps (state is read from the API, so a later step works on data a copy of the
// reset folder already has done by earlier steps only if they ran).
// Needs: cd server && npm run build; cd web && npx vite build. Needs free ports 8092 (server), 9342 (CDP).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_DIST = join(ROOT, "server/dist/server/src");
const PORT = 8092;
const CDP_PORT = 9342;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = out_dir("demo-path-shots");
const FAIL_OUT = out_dir("demo-path-fail");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.25;
const TALL_HEIGHT = 1500;
const BOOT_TRIES = 480; // x 250 ms = 2 minutes for a machine to boot in the browser
const PLAYER_TRIES = 720; // 3 minutes: the player restores the machine from the journal
const SERVER_TRIES = 720; // 3 minutes for the server's own check of a journal or a check run
const STUDENT = { login: "student10", password: "student-demo" };
const TEACHER = { login: "teacher", password: "teacher-demo" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = [];
const results = [];
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

function report_page_problems(msg) {
    if(msg.method === "Runtime.exceptionThrown") {
        console.log("EXCEPTION", msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
    } else if(msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        console.log("CONSOLE.error", msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
}

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
        const line = `step ${n} FAIL: ${name} - ${error.message}`;
        results.push(line);
        console.log(line);
        await failure_hook?.(label);
    }
}

async function page_driver(cdp) {
    cdp.on(report_page_problems);
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
        text_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
        attr_of: (selector, name) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`),
        count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
        body_text: () => evaluate("document.body.innerText"),
        scroll_to: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`),
        fill: (selector, text) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if(!el) return false;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
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
        escape: async () => {
            await key("keyDown", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            await key("keyUp", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        },
        console_lines: async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim()),
        type_line: async text => {
            await evaluate(`document.querySelector('[data-testid="terminal"] .xterm-helper-textarea')?.focus()`);
            for(const ch of text) {
                await key("keyDown", { key: ch, text: ch });
                await key("keyUp", { key: ch });
            }
            await key("keyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await key("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        },
        park_mouse: () => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: WIDTH - 4, y: HEIGHT - 4 }),
        // Waits until nothing is loading, no toast is up and the terminals stopped printing; then takes the picture.
        settle: async () => {
            await driver.park_mouse();
            try {
                await wait_for(async () => !(await evaluate(`/Завантаження/.test(document.body.innerText)`)) && !(await exists('[aria-busy="true"]')) && !(await exists('[data-sonner-toast]')), 80, 250, "the page to stop loading");
            } catch(error) { console.log(`WARN settle: ${error.message}`); }
            let previous = null;
            for(let i = 0; i < 20; i++) {
                const now = await evaluate(`[...document.querySelectorAll('.xterm-rows')].map(el => el.innerText).join("|")`);
                if(now === previous) break;
                previous = now;
                await sleep(700);
            }
            await sleep(300);
        },
        // A page longer than the window: the window is made taller for the picture, so the header stays in it.
        shot_tall: async (name, height) => {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: false });
            await sleep(500);
            await driver.shot(name);
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
        },
        shot: async (name, dir = OUT) => {
            await driver.settle();
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
            const path = join(dir, `${name}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            if(dir === OUT) files.push(path);
        },
    };
    driver.wait_prompt = () => wait_for(async () => { const lines = (await driver.console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
    driver.has_line = async text => (await driver.console_lines()).includes(text);
    driver.run = async (text, expect) => {
        await driver.type_line(text);
        if(expect) await wait_for(() => driver.has_line(expect), 120, 250, `'${expect}' in the console after '${text}'`);
        else await sleep(1500);
    };
    return driver;
}

async function main() {
    if(!existsSync(join(SERVER_DIST, "main.js")) || !existsSync(join(ROOT, "web/dist/index.html"))) {
        console.log("Build first: cd server && npm run build; cd web && npx vite build");
        process.exitCode = 1;
        return;
    }
    // E2E_REUSE=<folder with db.sqlite and journals/>: skip the reset and use that data (to debug the steps quickly).
    const reuse = process.env.E2E_REUSE;
    const dir = reuse ?? mkdtempSync(join(tmpdir(), "demo-path-"));
    mkdirSync(OUT, { recursive: true });
    mkdirSync(FAIL_OUT, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "demo-path-cdp-"));
    const env = { ...process.env, PORT: String(PORT), LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") };
    let server = null;
    let chrome = null;
    let cdp = null;
    const stop_server = () => { if(server) { try { process.kill(-server.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_server(); process.exit(130); });
    const run_started = Date.now();

    try {
        const reset = reuse ? { status: 0, stdout: "reset skipped (E2E_REUSE)", stderr: "" } : spawnSync("node", [join(SERVER_DIST, "demo/reset.js")], { cwd: ROOT, env, encoding: "utf8" });
        console.log(reset.stdout.split("\n").slice(-4).join("\n"));
        if(reset.status !== 0) throw new Error(`demo:reset failed: ${reset.stderr.slice(-500)}`);
        server = spawn("node", [join(SERVER_DIST, "main.js")], { cwd: ROOT, env, stdio: "ignore", detached: true });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 120, 250, "the server");

        chrome = spawn("chromium-browser", [
            "--headless=new", "--disable-features=BackForwardCache", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
        ], { stdio: "ignore" });
        const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        cdp = await connect(first.webSocketDebuggerUrl);
        const page = await page_driver(cdp);
        failure_hook = async label => {
            await page.shot(`99-fail-${label}`, FAIL_OUT).catch(() => {});
            console.log("PAGE", await page.evaluate("location.href"), JSON.stringify((await page.body_text()).slice(0, 500)));
        };

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

        // State is looked up through the API of the teacher, so every step can run on its own.
        const teacher_cookie = (await api("POST", "/api/auth/login", TEACHER)).cookie;
        const student = (await api("POST", "/api/auth/login", STUDENT)).json;
        const klass = (await api("GET", "/api/classes", null, teacher_cookie)).json[0];
        const class_page = `${BASE}/classes/${klass.id}`;
        const detail = (await api("GET", `/api/classes/${klass.id}`, null, teacher_cookie)).json;
        const by_title = prefix => {
            const found = detail.assignments.find(a => a.title.startsWith(prefix));
            if(!found) throw new Error(`no assignment '${prefix}'`);
            return found;
        };
        const config = by_title("Налаштування");
        const link = by_title("Зв");
        const lesson = by_title("Урок");
        const net = by_title("Мережа");
        const progress_of = async (assignment, user_id) => (await api("GET", `/api/assignments/${assignment.id}/students`, null, teacher_cookie)).json.find(s => s.user_id === user_id);
        const student_page = (assignment, user_id, query = "") => `${class_page}/assignments/${assignment.id}/students/${user_id}${query}`;
        const as_teacher = async () => sign_in(TEACHER);
        const as_student = async () => sign_in(STUDENT);
        // The work page of an assignment: wait until all machines are live and the shell of the first answers.
        const open_work = async (assignment, machines) => {
            await page.open(`${BASE}/assignments/${assignment.id}`);
            if(machines > 1) await page.wait_count('[data-testid="machine-tile"][data-state="live"]', machines, BOOT_TRIES);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await page.wait_prompt();
        };
        const verify_done = async submission_id => wait_for(async () => {
            const sub = (await api("GET", `/api/submissions/${submission_id}`, null, teacher_cookie)).json;
            return sub.verify_status === "queued" || sub.verify_status === "running" ? null : sub;
        }, SERVER_TRIES, 250, "the server's check of the journal");

        await step(1, "login page", async () => {
            await sign_out();
            await page.shot("01-vhid");
        });

        await step(2, "teacher: class page with student tiles", async () => {
            await as_teacher();
            await page.open(`${class_page}?a=${config.id}`);
            await page.wait_count('[data-testid="student-tile"]', 14);
            await page.shot("02-klasy-vykladacha");
            return `${klass.name}, assignment '${config.title}'`;
        });

        await step(3, "teacher: library", async () => {
            await as_teacher();
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="library-row"]');
            await page.shot("03-biblioteka");
            return `${await page.count('[data-testid="library-row"]')} rows`;
        });

        await step(4, "teacher: library item with two machines and a switch", async () => {
            await as_teacher();
            const item_id = (await api("GET", `/api/assignments/${link.id}`, null, teacher_cookie)).json.item_id;
            await page.open(`${BASE}/library/${item_id}`);
            await page.wait_selector('[data-testid="topology-scheme"]');
            await wait_for(async () => !(await page.exists('[data-testid="scheme-empty"]')), 40, 250, "the scheme to draw");
            await page.shot_tall("04-redaktor-topolohii", TALL_HEIGHT);
            return `item ${item_id}`;
        });

        await step(5, "teacher: calendar", async () => {
            await as_teacher();
            await page.open(`${BASE}/calendar`);
            await page.wait_selector('[data-testid="calendar-entry"]');
            await page.shot("05-kalendar");
            return `${await page.count('[data-testid="calendar-entry"]')} entries`;
        });

        await step(6, "student10: 'Мої завдання'", async () => {
            await as_student();
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            await page.shot("06-moi-zavdannia");
            return `${student.name}: 9 rows`;
        });

        await step(7, "student10: one-machine assignment, commands typed", async () => {
            await as_student();
            await open_work(config, 1);
            await page.run("hostname lab-pc");
            await page.run("mkdir /tmp/lab");
            await page.run("uname -r > /tmp/lab/report.txt");
            await page.run("hostname", "lab-pc");
            await page.run("cat /tmp/lab/report.txt", undefined);
            await wait_for(async () => /\n\d+\.\d+\.\d+/.test((await page.console_lines()).join("\n")), 120, 250, "the kernel version in the console");
            await wait_for(async () => (await page.attr_of('[data-testid="save-status"]', "data-status")) === "saved", 60, 250, "save status saved");
            await page.shot("07-robota-odna-mashyna");
        });

        await step(8, "student10: rollback list (only opened)", async () => {
            await page.click('[data-testid="rollback-open"]');
            await page.wait_selector('[data-testid="rollback-option"]', 40);
            const labels = await page.evaluate(`[...document.querySelectorAll('[data-testid="rollback-option"]')].map(el => el.textContent)`);
            if(!labels.includes("До початку") || !labels.some(l => l.includes("hostname lab-pc"))) throw new Error(`options ${JSON.stringify(labels)}`);
            await page.shot("08-vidkat");
            await page.escape();
            await page.wait_gone('[data-testid="rollback-option"]');
            return `${labels.length} options`;
        });

        await step(9, "student10: submit the one-machine work", async () => {
            await page.click('[data-testid="submit-open"]');
            await page.wait_selector('[data-testid="submit-confirm"]', 20);
            await page.click('[data-testid="submit-confirm"]');
            await page.wait_selector('[data-testid="submission-block"]', 240);
            const id = Number(await page.attr_of('[data-testid="submission-block"]', "data-submission"));
            await verify_done(id);
            await wait_for(async () => !["queued", "running"].includes(await page.attr_of('[data-testid="submission-block"]', "data-verify")), 120, 250, "the verify state on the page");
            await page.shot("09-zdano");
            return `submission ${id}, verify ${await page.attr_of('[data-testid="submission-block"]', "data-verify")}`;
        });

        await step(10, "student10: two machines, ping from one to the other", async () => {
            await as_student();
            await open_work(link, 2);
            // The network setup (hw ether) runs a moment after the prompt appears; an `ifconfig ... up` typed before it makes
            // the setup fail with "Device or resource busy". The tile shows the MAC once the setup has answered.
            await wait_for(async () => (await page.evaluate(`[...document.querySelectorAll('[data-testid="machine-tile"]')].every(el => /([0-9a-f]{2}:){5}[0-9a-f]{2}/.test(el.innerText))`)), 120, 250, "the network setup of both machines");
            const tile_mac = node => page.evaluate(`document.querySelector('[data-testid="machine-tile"][data-node="${node}"]').innerText.match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/)?.[0] ?? ""`);
            const mac1 = await tile_mac("m1");
            const mac2 = await tile_mac("m2");
            await page.run("ifconfig eth0 10.0.0.1 netmask 255.255.255.0 up");
            await page.run("cat /sys/class/net/eth0/address", mac1); // the guest has the address the tile shows
            await page.click('[data-testid="machine-tile"][data-node="m2"]');
            await page.wait_selector('[data-testid="terminal"][data-node="m2"][data-state="live"]', 60);
            await page.wait_prompt();
            await page.run("ifconfig eth0 10.0.0.2 netmask 255.255.255.0 up");
            await page.run("cat /sys/class/net/eth0/address", mac2);
            await page.click('[data-testid="machine-tile"][data-node="m1"]');
            await page.wait_selector('[data-testid="terminal"][data-node="m1"][data-state="live"]', 60);
            await page.wait_prompt();
            await page.type_line("ping -c 2 -W 2 10.0.0.2");
            await wait_for(async () => { const text = (await page.console_lines()).join("\n"); return text.includes("2 packets received") || text.includes("0% packet loss"); }, 120, 250, "the ping summary in the console");
            await wait_for(async () => (await page.attr_of('[data-testid="save-status"]', "data-status")) === "saved", 60, 250, "save status saved");
            await page.shot("10-topolohiia-dvi-mashyny");
        });

        await step(11, "student10: 'У мене не працює' sent", async () => {
            await as_student();
            if(!(await page.evaluate("location.pathname")).endsWith(`/assignments/${link.id}`) || !(await page.exists('[data-testid="terminal"][data-state="live"]'))) await open_work(link, 2);
            await page.click('[data-testid="help-open"]');
            await page.wait_selector('[data-testid="help-text"]', 20);
            await page.fill('[data-testid="help-text"]', "Пінг на другий комп'ютер не проходить, хоча адреси я задав. Не розумію, що не так.");
            await page.click('[data-testid="help-send"]');
            await page.wait_selector('[data-testid="help-sent"]', 40);
            await page.wait_gone('[data-testid="help-dialog"]');
            const mine = await progress_of(link, student.id);
            if(!mine?.open_help) throw new Error("the server has no open help request of the student");
            await page.shot("11-ne-pratsiuie");
            return `help ${mine.open_help.id}`;
        });

        await step(12, "teacher: /review with the new submission and the request", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-row"]');
            const mine = await progress_of(config, student.id);
            const sub = mine?.latest_submission;
            if(!sub) throw new Error("no submission of student10 in the config assignment");
            await verify_done(sub.id);
            await wait_for(async () => (await page.body_text()).includes(student.name), 40, 250, `'${student.name}' in /review`);
            await page.shot("12-na-perevirku");
            const kinds = await page.evaluate(`[...document.querySelectorAll('[data-testid="review-row"]')].filter(el => el.innerText.includes(${JSON.stringify(student.name)})).map(el => el.dataset.kind)`);
            if(!kinds.includes("submission") || !kinds.includes("help")) throw new Error(`rows of the student: ${kinds}`);
            return `rows of the student: ${kinds.join(", ")}`;
        });

        await step(13, "teacher: submission panel with the check run", async () => {
            await as_teacher();
            const sub = (await progress_of(config, student.id))?.latest_submission;
            if(!sub) throw new Error("no submission");
            await page.open(student_page(config, student.id, `?submission=${sub.id}`));
            await page.wait_selector('[data-testid="check-start"]');
            await wait_for(async () => !(await page.evaluate(`document.querySelector('[data-testid="check-start"]').disabled`)), 120, 250, "the check button");
            if((await page.attr_of('[data-testid="check-section"]', "data-run-status")) === "none") await page.click('[data-testid="check-start"]');
            await wait_for(async () => (await page.attr_of('[data-testid="check-section"]', "data-run-status")) === "done", SERVER_TRIES, 250, "the check run to finish");
            await page.wait_selector('[data-testid="check-summary"]');
            await page.shot_tall("13-zdacha-studenta", TALL_HEIGHT);
            return await page.text_of('[data-testid="check-summary"]');
        });

        await step(14, "teacher: player of the submission, marks, seek to the middle", async () => {
            await as_teacher();
            const sub = (await progress_of(config, student.id))?.latest_submission;
            if(!sub) throw new Error("no submission");
            await page.open(`${BASE}/play/submission-${sub.id}-m1`);
            await page.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_TRIES);
            const idle = () => wait_for(async () => (await page.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
            await idle();
            await page.wait_selector('[data-testid="timeline-mark"]', 40);
            // The first seconds of a recording are the boot, so the middle of the commands is the useful "middle".
            const commands = await page.count('[data-testid="command-item"]');
            await page.evaluate(`document.querySelectorAll('[data-testid="command-item"]')[${Math.floor(commands / 2)}].setAttribute("data-e2e-target", "1")`);
            await page.click('[data-e2e-target="1"]');
            await idle();
            await wait_for(async () => (await page.console_lines()).filter(Boolean).length > 1, 120, 250, "the terminal to show output");
            const position = await page.attr_of('[data-testid="player"]', "data-position");
            await page.shot("14-pleier");
            return `${await page.count('[data-testid="timeline-mark"]')} marks, ${await page.count('[data-testid="command-item"]')} commands, position ${position} ms`;
        });

        await step(15, "teacher: reply to the request, branch in the player, answer sent", async () => {
            await as_teacher();
            await page.open(student_page(link, student.id));
            await page.wait_selector('[data-testid="help-reply"]');
            await wait_for(async () => !(await page.evaluate(`document.querySelector('[data-testid="help-reply"]').disabled`)), 40, 250, "the reply button");
            await page.click('[data-testid="help-reply"]');
            await wait_for(async () => (await page.evaluate("location.pathname")).startsWith("/play/branch-"), 80, 250, "the player");
            await page.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_TRIES);
            await wait_for(async () => (await page.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
            await page.wait_selector('[data-testid="fork"]');
            await page.shot("15a-pleier-vidpovid");
            await page.click('[data-testid="fork"]');
            await wait_for(async () => (await page.evaluate("location.pathname")) === `/classes/${klass.id}/assignments/${link.id}/students/${student.id}`, 80, 250, "the student page");
            await wait_for(async () => (await page.body_text()).includes("Відповідь надіслано"), 40, 250, "the notice 'Відповідь надіслано'");
            await wait_for(async () => (await page.body_text()).includes("відповідь викладача"), 40, 250, "the reply in the attempt tree");
            await sleep(6000); // the notice may be temporary; the picture is taken while it is up if it stays, else with the tree
            await page.shot("15-vidpovid-na-zapyt");
        });

        await step(16, "teacher: grade with a note saved", async () => {
            await as_teacher();
            const sub = (await progress_of(config, student.id))?.latest_submission;
            if(!sub) throw new Error("no submission");
            await page.open(student_page(config, student.id, `?submission=${sub.id}`));
            await page.wait_selector('[data-testid="grade-input"]');
            if(await page.exists('[data-testid="grade-accept"]')) await page.click('[data-testid="grade-accept"]');
            else await page.fill('[data-testid="grade-input"]', "9");
            await page.fill('[data-testid="grade-note"]', "Усе виконано правильно, команди набрано без зайвих спроб.");
            await page.click('[data-testid="grade-save"]');
            const saved = await wait_for(async () => {
                const now = (await api("GET", `/api/submissions/${sub.id}`, null, teacher_cookie)).json;
                return now.grade !== null ? now : null;
            }, 40, 250, "the grade on the server");
            await page.shot_tall("16-otsinka", TALL_HEIGHT);
            return `grade ${saved.grade}`;
        });

        await step(17, "teacher: 'Аналітика' view of the assignment", async () => {
            await as_teacher();
            await page.open(`${class_page}?a=${config.id}&view=analytics`);
            await page.wait_selector('[data-testid="analytics-view"]');
            await page.wait_selector('[data-testid="grade-bar"]');
            await page.evaluate(`document.querySelector('[data-testid="analytics-view"]').scrollIntoView({ block: "end" })`);
            await page.shot("17-analityka");
        });

        await step(18, "teacher: 'Оцінки' tab", async () => {
            await as_teacher();
            await page.open(`${class_page}?tab=grades`);
            await page.wait_selector('[data-testid="grade-row"]');
            await page.shot("18-otsinky-klasu");
            return `${await page.count('[data-testid="grade-row"]')} rows`;
        });

        await step(19, "student10: grade in 'Мої завдання'", async () => {
            await as_student();
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            const row = await page.text_of(`[data-testid="assignment-row"][data-assignment="${config.id}"]`);
            if(!/\d+ з \d+/.test(row)) throw new Error(`the row of the config assignment has no grade: ${JSON.stringify(row)}`);
            await page.shot("19-otsinka-u-studenta");
            return row.replace(/\s+/g, " ");
        });

        await step(20, "student10: lesson with step markup", async () => {
            await as_student();
            await page.open(`${BASE}/assignments/${lesson.id}`);
            await page.wait_selector('[data-testid="lesson-note"]', BOOT_TRIES);
            await wait_for(async () => (await page.text_of('[data-testid="lesson-note"]')).trim().length > 0, BOOT_TRIES, 250, "the lesson note");
            // The teacher's replay runs first ("play"); 'Далі' moves to the segment where the student acts.
            const phase = () => page.attr_of('[data-testid="lesson-panel"]', "data-lesson-phase");
            for(let i = 0; i < 12 && (await phase()) !== "student"; i++) {
                if(!(await page.evaluate(`document.querySelector('[data-testid="lesson-next"]')?.disabled ?? true`))) await page.click('[data-testid="lesson-next"]');
                await sleep(2500);
            }
            if((await phase()) !== "student") throw new Error(`the lesson did not reach the student's segment, phase ${await phase()}`);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', 120);
            await page.wait_prompt();
            await page.run("echo hello-lab > /tmp/hello.txt");
            await page.run("cat /tmp/hello.txt", "hello-lab");
            await page.shot("20-urok");
            return `phase ${await phase()}, task '${(await page.text_of('[data-testid="lesson-task"]')).slice(0, 60)}'`;
        });

        await step(21, "teacher: six-machine submission, topology scheme", async () => {
            await as_teacher();
            const first_student = (await api("GET", `/api/assignments/${net.id}/students`, null, teacher_cookie)).json.find(s => s.latest_submission);
            if(!first_student) throw new Error("no submission in the six-machine assignment");
            await page.open(student_page(net, first_student.user_id, `?submission=${first_student.latest_submission.id}`));
            await page.wait_selector('[data-testid="diagram"]');
            await page.wait_count('[data-testid="diagram-machine"]', 6, 40);
            await page.shot("21-shist-mashyn");
            return `${first_student.name}, ${await page.count('[data-testid="diagram-machine"]')} nodes`;
        });
        await step(22, "teacher: assignment picker with search, active ones on top", async () => {
            await as_teacher();
            await page.open(`${class_page}?a=${config.id}`);
            await page.wait_selector('[data-testid="assignment-picker"]');
            await page.click('[data-testid="assignment-picker"]');
            await page.wait_selector('[data-testid="assignment-option"]');
            const options = await page.count('[data-testid="assignment-option"]');
            if(options !== detail.assignments.length) throw new Error(`${options} options for ${detail.assignments.length} assignments`);
            await page.shot("22-vybir-zavdannia");
            return `${options} options`;
        });

        console.log(`RESULT: ${results.some(line => line.includes(" FAIL:")) ? "FAIL" : "DONE"} in ${Math.round((Date.now() - run_started) / 1000)} s`);
    }
    finally {
        cdp?.close();
        if(chrome) await close_browser(chrome, CDP_PORT);
        stop_server();
        await remove_profile(profile);
        if(!reuse) rmSync(dir, { recursive: true, force: true });
        console.log("\nSteps:");
        for(const line of results) console.log(line);
        console.log("\nScreenshots:");
        for(const file of files) console.log(file);
    }
}

main().catch(error => { console.log("RESULT: FAIL", error.message); process.exitCode = 1; });
