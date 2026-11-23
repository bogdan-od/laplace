// The product on a phone: 390x844 CSS px, scale 3, demo data. Pictures: out/e2e/mobile-shots/NN-name.png (E2E_OUT).
// Every picture also checks that the page does not scroll sideways: neither the document nor the main column, and no
// element sticks out of the screen unless a scrolling container (a terminal, the grades table) holds it.
// The same server setup as screenshots.mjs (demo:reset into a temporary folder, the built server on port 8094, headless
// Chromium over CDP, no Vite). STEPS=2,5-7 runs only those steps.
// Needs: cd server && npm run build; cd web && npx vite build. Needs free ports 8094 (server) and 9345 (CDP).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create_kit, sleep } from "./cdp-kit.mjs";
import { out_dir } from "./out_dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_DIST = join(ROOT, "server/dist/server/src");
const PORT = 8094;
const CDP_PORT = 9345;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = out_dir("mobile-shots");
const WIDTH = 390;
const HEIGHT = 844;
const SCALE = 3;
const BOOT_TRIES = 480;
const PLAYER_TRIES = 720;
const PASSWORD = "student-demo";
const TEACHER = { login: "teacher", password: "teacher-demo" };
const student_login = number => ({ login: `student${String(number).padStart(2, "0")}`, password: PASSWORD });
const user_id_of = number => number + 2; // fixed by the demo seed (student01 = 3)

const { wait_for, api, open_browser } = create_kit({ base: BASE, width: WIDTH, height: HEIGHT, scale: SCALE, mobile: true, boot_tries: BOOT_TRIES, player_tries: PLAYER_TRIES });

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
const results = [];
let failure_hook = null;
let current_step = 0;

// The page must not scroll sideways. A part of the page may be wider than the screen only inside a container that scrolls
// itself (overflow-x: auto/scroll/hidden) and that is not wider than the screen.
const OVERFLOW_PROBE = `(() => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const main = document.querySelector("main");
    const clips = el => { const x = getComputedStyle(el).overflowX; return x !== "visible"; };
    const leaks = [];
    for(const el of document.body.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if(rect.width === 0 || rect.height === 0 || rect.right <= width + 1 || rect.left >= width) continue;
        const style = getComputedStyle(el);
        if(style.visibility === "hidden" || style.position === "fixed" || el.closest("[data-sonner-toaster]")) continue;
        let held = false;
        for(let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
            if(clips(box) && box.getBoundingClientRect().right <= width + 1) { held = true; break; }
        }
        if(held) continue;
        const name = el.tagName.toLowerCase() + (el.dataset.testid ? '[' + el.dataset.testid + ']' : "") + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").slice(0, 3).join(".") : "");
        leaks.push(name + " right=" + Math.round(rect.right));
    }
    return {
        document: doc.scrollWidth > doc.clientWidth,
        body: document.body.scrollWidth > doc.clientWidth,
        main: main ? main.scrollWidth > main.clientWidth : false,
        leaks: leaks.slice(0, 8),
    };
})()`;

async function step(n, name, job) {
    if(!wanted(n)) return;
    current_step = n;
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
        await failure_hook?.(String(n).padStart(2, "0"));
    }
}

async function main() {
    if(!existsSync(join(SERVER_DIST, "main.js")) || !existsSync(join(ROOT, "web/dist/index.html"))) {
        console.log("Build first: cd server && npm run build; cd web && npx vite build");
        process.exitCode = 1;
        return;
    }
    const reuse = process.env.E2E_REUSE;
    const dir = reuse ?? mkdtempSync(join(tmpdir(), "mobile-"));
    mkdirSync(OUT, { recursive: true });
    if(!process.env.STEPS) for(const name of readdirSync(OUT)) rmSync(join(OUT, name), { force: true });
    const env = { ...process.env, PORT: String(PORT), LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") };
    let server = null;
    let browser = null;
    const stop_server = () => { if(server) { try { process.kill(-server.pid); } catch { /* already gone */ } } };
    process.on("SIGINT", () => { stop_server(); process.exit(130); });

    try {
        const reset = reuse ? { status: 0 } : spawnSync("node", [join(SERVER_DIST, "demo/reset.js")], { cwd: ROOT, env, encoding: "utf8" });
        if(reset.status !== 0) throw new Error(`demo:reset failed: ${reset.stderr?.slice(-500)}`);
        server = spawn("node", [join(SERVER_DIST, "main.js")], { cwd: ROOT, env, stdio: "ignore", detached: true });
        await wait_for(async () => (await fetch(`${BASE}/api/images`)).ok, 120, 250, "the server");

        browser = await open_browser(CDP_PORT, "phone");
        const { page, sign_in, sign_out } = browser;
        failure_hook = async label => {
            const { data } = await page.cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(OUT, `fail-${label}.png`), Buffer.from(data, "base64"));
            console.log("PAGE", await page.evaluate("location.href"), JSON.stringify((await page.body_text()).slice(0, 400)));
        };

        const teacher_cookie = (await api("POST", "/api/auth/login", TEACHER)).cookie;
        const classes = (await api("GET", "/api/classes", null, teacher_cookie)).json;
        const class_kn = classes.find(c => c.name.startsWith("КН"));
        const detail_kn = (await api("GET", `/api/classes/${class_kn.id}`, null, teacher_cookie)).json;
        const by_title = prefix => {
            const found = detail_kn.assignments.find(a => a.title.startsWith(prefix));
            if(!found) throw new Error(`no assignment '${prefix}'`);
            return found;
        };
        const config = by_title("Налаштування");
        const vlan = by_title("VLAN");
        const class_page = (query = "") => `${BASE}/classes/${class_kn.id}${query}`;
        const student_page = (assignment, number, query = "") => `${class_page()}/assignments/${assignment.id}/students/${user_id_of(number)}${query}`;
        const submission_of = async (assignment, number) => {
            const found = (await api("GET", `/api/assignments/${assignment.id}/students`, null, teacher_cookie)).json.find(s => s.user_id === user_id_of(number));
            if(!found?.latest_submission) throw new Error(`student ${number} has no submission in assignment ${assignment.id}`);
            return found.latest_submission;
        };
        const as_teacher = () => sign_in(TEACHER);
        const as_student = number => sign_in(student_login(number));
        const open_work = async assignment => {
            await page.open(`${BASE}/assignments/${assignment.id}`);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await page.wait_prompt();
        };

        // Takes the picture and checks the page for sideways scrolling.
        const shot = async (slug, opts = {}) => {
            await page.settle(opts.toast);
            const text = await page.body_text();
            if(!opts.error_ok && /Помилка/.test(text)) throw new Error(`'Помилка' on the page of ${slug}`);
            const { data } = await page.cdp.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(OUT, `${String(current_step).padStart(2, "0")}-${slug}.png`), Buffer.from(data, "base64"));
            const probe = await page.evaluate(OVERFLOW_PROBE);
            const problems = [];
            if(probe.document) problems.push("the document scrolls sideways");
            if(probe.body) problems.push("the body is wider than the screen");
            if(probe.main) problems.push("the main column scrolls sideways");
            if(probe.leaks.length > 0) problems.push(`sticks out: ${probe.leaks.join("; ")}`);
            if(problems.length > 0) throw new Error(`${slug}: ${problems.join(" | ")}`);
        };
        // The page grows to its whole height for the picture (a long page keeps its header and shows below the fold).
        const tall = async (height, job) => {
            await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: true });
            await sleep(500);
            try { await job(); } finally {
                await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: true });
                await sleep(300);
            }
        };

        await step(1, "login", async () => {
            await sign_out();
            await shot("vkhid");
        });
        await step(2, "teacher: review queue as cards", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-card"]');
            await shot("na-perevirku");
        });
        await step(3, "teacher: the menu", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-card"]');
            await page.click('button[title="Показати меню"]');
            await page.wait_text("Мої класи");
            await shot("menu");
        });
        await step(4, "teacher: class tiles", async () => {
            await as_teacher();
            await page.open(class_page(`?a=${vlan.id}`));
            await page.wait_count('[data-testid="student-tile"]', 14);
            await shot("klas-plytky");
        });
        await step(5, "teacher: class grades", async () => {
            await as_teacher();
            await page.open(class_page("?tab=grades"));
            await page.wait_selector('[data-testid="grade-row"]');
            await shot("klas-otsinky");
        });
        await step(6, "teacher: class activity log", async () => {
            await as_teacher();
            await page.open(class_page("?tab=activity"));
            await page.wait_selector('[data-testid="activity-card"]');
            await shot("klas-zhurnal");
        });
        await step(7, "teacher: student page", async () => {
            await as_teacher();
            await page.open(student_page(vlan, 4));
            await page.wait_selector('[data-testid="attempt-tree"]');
            await page.wait_selector('[data-testid="branch-tree"], [data-testid="branch-flat"], [data-testid="branch"]');
            await tall(2200, () => shot("storinka-studenta"));
        });
        await step(8, "teacher: player with the command list", async () => {
            await as_teacher();
            const sub = await submission_of(config, 1);
            await page.open(`${BASE}/play/submission-${sub.id}-m1`);
            await page.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_TRIES);
            await wait_for(async () => (await page.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
            await page.wait_selector('[data-testid="command-item"]', 40);
            await page.wait_selector('[data-testid="timeline-mark"]', 40);
            await tall(1700, () => shot("pleier"));
        });
        await step(9, "teacher: notifications", async () => {
            await as_teacher();
            await page.open(`${BASE}/review`);
            await page.wait_selector('[data-testid="review-card"]');
            await page.click('button[title="Сповіщення"]');
            await page.wait_text("Сповіщення");
            await wait_for(async () => (await page.evaluate(`document.querySelectorAll('[role="dialog"] button').length`)) > 3, 40, 250, "the notifications");
            await shot("spovishchennia");
        });
        await step(10, "student: my assignments", async () => {
            await as_student(1);
            await page.open(`${BASE}/`);
            await page.wait_count('[data-testid="assignment-row"]', 9);
            await shot("moi-zavdannia");
        });
        await step(11, "student: the assignment with the grade and the comments", async () => {
            await as_student(1);
            await open_work(config);
            await page.wait_selector('[data-testid="submission-block"]', 60);
            await page.wait_selector('[data-testid="submission-comment"]', 60);
            await tall(1900, () => shot("zavdannia-otsinka"));
        });
        await step(12, "student: live machines of a network task", async () => {
            await as_student(9);
            await page.open(`${BASE}/assignments/${vlan.id}`);
            await page.wait_count('[data-testid="machine-tile"][data-state="live"]', 3, BOOT_TRIES);
            await page.wait_selector('[data-testid="terminal"][data-state="live"]', BOOT_TRIES);
            await page.wait_prompt();
            await wait_for(async () => (await page.evaluate(`[...document.querySelectorAll('[data-testid="machine-tile"]')].every(el => /([0-9a-f]{2}:){5}[0-9a-f]{2}/.test(el.innerText))`)), 120, 250, "the network setup of the machines");
            await page.run("ifconfig eth0 192.168.10.2 netmask 255.255.255.0 up");
            await page.run("ping -c 2 -W 2 192.168.10.1");
            await page.wait_selector('[data-testid="frame-row"]', 80);
            await tall(2600, () => shot("zhyva-mashyna"));
        });
        await step(13, "teacher: library", async () => {
            await as_teacher();
            await page.open(`${BASE}/library`);
            await page.wait_selector('[data-testid="library-row"]');
            await shot("biblioteka");
        });

        // The rest of the screens, to see them on a phone too.
        await step(14, "teacher: the class table view", async () => {
            await as_teacher();
            await page.open(class_page(`?a=${vlan.id}&view=table`));
            await page.wait_selector('[data-testid="student-row"]');
            await tall(1700, () => shot("klas-tablytsia"));
        });
        await step(15, "teacher: the class analytics", async () => {
            await as_teacher();
            await page.open(class_page(`?a=${vlan.id}&view=analytics`));
            await page.wait_selector('[data-testid="analytics-view"]');
            await wait_for(async () => (await page.count('[data-testid="an-row"]')) > 0, 40, 250, "the analytics rows");
            await tall(1700, () => shot("klas-analityka"));
        });
        await step(16, "teacher: the class students", async () => {
            await as_teacher();
            await page.open(class_page("?tab=students"));
            await page.wait_selector('[data-testid="member-row"]');
            await tall(1700, () => shot("klas-studenty"));
        });
        await step(17, "teacher: compare two submissions", async () => {
            await as_teacher();
            const first = await submission_of(config, 1);
            const second = await submission_of(config, 2);
            await page.open(`${BASE}/compare?a=submission-${first.id}-m1&b=submission-${second.id}-m1`);
            await wait_for(async () => (await page.count('[data-testid="player"][data-phase="ready"][data-seeking="false"]')) === 2, PLAYER_TRIES, 250, "both players ready");
            await tall(2200, () => shot("porivnyannia"));
        });
        await step(18, "teacher: calendar", async () => {
            await as_teacher();
            await page.open(`${BASE}/calendar`);
            await page.wait_selector('[data-testid="calendar-entry"]');
            await tall(1700, () => shot("kalendar"));
        });
        await step(19, "teacher: settings", async () => {
            await as_teacher();
            await page.open(`${BASE}/settings`);
            await page.wait_text("Налаштування");
            await tall(1500, () => shot("nalashtuvannia"));
        });
        await step(20, "teacher: a library item", async () => {
            await as_teacher();
            const item = (await api("GET", `/api/assignments/${vlan.id}`, null, teacher_cookie)).json.item_id;
            await page.open(`${BASE}/library/${item}`);
            await page.wait_selector('[data-testid="topology-scheme"]');
            await tall(2600, () => shot("predmet-biblioteky"));
        });
        await step(21, "teacher: class tiles with the assignment bar", async () => {
            await as_teacher();
            await page.open(class_page(`?a=${config.id}`));
            await page.wait_count('[data-testid="student-tile"]', 14);
            await page.click('[data-testid="assignment-picker"]');
            await page.wait_selector('[data-testid="assignment-option"]');
            await shot("vybir-zavdannia");
        });
        await step(22, "student: the join page", async () => {
            await sign_out();
            await page.open(`${BASE}/join/${detail_kn.invite_code}`);
            await page.wait_selector('input[autocomplete="new-password"]');
            await shot("zaproshennia");
        });
    } finally {
        await browser?.close().catch(() => {});
        stop_server();
    }
    const failed = results.filter(line => / FAIL: /.test(line));
    console.log(`\n${results.length - failed.length} of ${results.length} steps ok`);
    if(failed.length > 0) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
