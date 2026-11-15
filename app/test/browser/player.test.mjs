// Browser check of player.html: load, command jump, timeline seek, verify, go live and typing.
// Starts the room server in-process and headless Chromium (CDP).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start_server } from "../../server.mjs";
import { read_journal, event_times, duration_ms, commands } from "../../core/journal.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8099;
const CDP_PORT = 9337;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const JOURNAL_PATH = "/app/test/out/br1.json";
const JOURNAL_FILE = fileURLToPath(new URL("../out/br1.json", import.meta.url));
const ITEM_TIMEOUT_MS = 60000;
const WAIT_GRACE_MS = 2000;
const POLL_MS = 300;
const MS_PER_S = 1000;
const CLOCK_TOLERANCE_S = 1.5;
const JUMP_COMMAND_INDEX = 1;
const TIMELINE_RATIO = 1 / 3;
const END_NOTE = "Кінець запису";
const VERIFY_OK = "Перевірено";
const VERIFY_FAIL = "Розбіжність";
const LIVE_MODE = "жива";
const PLAY_PAUSED_LABEL = "Далі";
const OTHER_JOURNAL_FILE = fileURLToPath(new URL("../../../server/test/journals-fixtures/buildroot-1.json", import.meta.url));
// Replay reproduces the recorded clock jumps ("clock", up to 1.2 s in br1.json): vt stands still until real time
// catches up with them, so a 2.5 s window that covers a jump gives ≈0.56 at a true speed of 1.0. Take the median of the
// windows.
const SPEED_SAMPLE_MS = { 1: 2500, 4: 1200 };
const SPEED_SAMPLES = { 1: 5, 4: 3 };
const SPEED_TOLERANCE = 0.45;
const SEEK_SETTLE_MS = 500;
const TYPED = "echo hi$((6*7))";
const EXPECTED_OUTPUT = "hi42";
const ENTER_KEY_CODE = 13;
const NO_STATUS_MODE = "-";
const PAUSED_CHECK_MS = 2000;
const PAUSED_VT_DRIFT_S = 0.2;
// Holds the loading of the boot snapshot (.snap) until window.__release(): this exposes the moment before the Worker
// exists.
const GATE_BOOT_SNAPSHOT = `(() => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.__release = release;
    const native = window.fetch;
    window.fetch = (url, ...rest) => (String(url).includes(".snap") ? gate.then(() => native(url, ...rest)) : native(url, ...rest));
})()`;

let page = null;
let journal = null;
let duration_s = 0;
let command_times = [];
let deadline = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text_of = async id => (await page.evaluate(`document.getElementById('${id}').textContent`)) ?? "";
const vt_s = async () => Number(await text_of("vt"));
const near = (value, target) => Math.abs(value - target) <= CLOCK_TOLERANCE_S;
const click = id => page.evaluate(`document.getElementById('${id}').click()`);
const terminal_text = async () => (await page.evaluate("document.querySelector('#terminal .xterm-rows')?.innerText ?? ''")) ?? "";

async function wait_for(label, check) {
    while(Date.now() < deadline) {
        if(await check()) return;
        await sleep(POLL_MS);
    }
    const state = await page.evaluate("`#vt ${document.getElementById('vt').textContent}, #timeline ${document.getElementById('timeline').value}, #mode ${document.getElementById('mode').textContent}, #ev ${document.getElementById('ev').textContent}`");
    throw new Error(`timeout: ${label} (${state})`);
}

function print_page_log(message) {
    if(message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        console.log("EXC", details.exception?.description ?? details.text);
    }
    if(message.method === "Log.entryAdded") console.log("LOG", message.params.entry.level, message.params.entry.text, message.params.entry.url ?? "");
}

async function open_page(path, init = null) {
    const url = encodeURIComponent(init ? "about:blank" : BASE + path);
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${url}`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    const pending = new Map();
    let last_id = 0;
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        print_page_log(message);
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
    };
    const send = (method, params = {}) => new Promise(resolve => {
        last_id += 1;
        pending.set(last_id, resolve);
        ws.send(JSON.stringify({ id: last_id, method, params }));
    });
    await send("Runtime.enable");
    await send("Log.enable");
    if(init) {
        await send("Page.enable");
        await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
        await send("Page.navigate", { url: BASE + path });
    }
    return {
        id: target.id,
        send,
        evaluate: async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value,
        close: () => ws.close(),
    };
}

async function type_line(text) {
    await page.send("Input.insertText", { text });
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE, text: "\r" };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE });
}

function load_journal() {
    journal = read_journal(JSON.parse(readFileSync(JOURNAL_FILE, "utf8")));
    duration_s = duration_ms(journal) / MS_PER_S;
    const times = event_times(journal);
    command_times = commands(journal.events).map(cmd => times[cmd.index]);
}

async function check_load() {
    await wait_for(`#count = ${journal.events.length}`, async () => (await text_of("count")) === String(journal.events.length));
    await wait_for(`#note «${END_NOTE}»`, async () => (await text_of("note")).includes(END_NOTE));
    return `events ${journal.events.length}, end of recording`;
}

async function check_command_jump() {
    const items = await page.evaluate("document.querySelectorAll('#list li').length");
    if(items <= JUMP_COMMAND_INDEX) throw new Error(`in #list ${items} items, need more ${JUMP_COMMAND_INDEX}`);
    const target_s = command_times[JUMP_COMMAND_INDEX] / MS_PER_S;
    await click_command(JUMP_COMMAND_INDEX);
    await wait_for(`#vt near ${target_s.toFixed(1)} с`, async () => near(await vt_s(), target_s));
    return `#vt ${(await vt_s()).toFixed(1)} s, target ${target_s.toFixed(1)} с`;
}

async function click_command(index) {
    await page.evaluate(`document.querySelectorAll('#list li')[${index}].click()`);
}

async function seek_timeline(value_s) {
    await page.evaluate(`(() => { const slider = document.getElementById('timeline'); slider.value = ${value_s}; slider.dispatchEvent(new Event('change')); })()`);
}

async function check_timeline_seek() {
    const target_s = duration_s * TIMELINE_RATIO;
    await seek_timeline(duration_s);
    await wait_for("#vt near the end of the recording", async () => near(await vt_s(), duration_s));
    const before = await vt_s();
    await seek_timeline(target_s);
    await wait_for(`#vt near ${target_s.toFixed(1)} с`, async () => near(await vt_s(), target_s));
    return `до ${before.toFixed(1)} s, target ${target_s.toFixed(1)} s, #vt ${(await vt_s()).toFixed(1)} с`;
}

async function check_verify() {
    await click("verify");
    await wait_for("\"Перевірити\" result", async () => {
        const text = await text_of("verify_result");
        if(text.startsWith(VERIFY_FAIL)) throw new Error(text);
        return text.startsWith(VERIFY_OK);
    });
    return text_of("verify_result");
}

async function play_to_end() {
    await page.evaluate(`(() => { const play = document.getElementById('play'); if(play.textContent === '${PLAY_PAUSED_LABEL}') play.click(); })()`);
    await page.evaluate("document.querySelector('[data-speed=\"0\"]').click()");
    await wait_for("end of recording by #vt", async () => (await vt_s()) >= duration_s - CLOCK_TOLERANCE_S);
}

async function check_go_live() {
    await play_to_end();
    await click("go_live");
    await wait_for(`#mode «${LIVE_MODE}»`, async () => (await text_of("mode")) === LIVE_MODE);
    await page.evaluate("document.querySelector('.xterm-helper-textarea')?.focus()");
    await type_line(TYPED);
    await wait_for(`«${EXPECTED_OUTPUT}" in the terminal`, async () => (await terminal_text()).includes(EXPECTED_OUTPUT));
    const save_visible = await page.evaluate("!document.getElementById('save').hidden");
    if(!save_visible) throw new Error("#save button is hidden");
    return `#mode «${LIVE_MODE}», «${EXPECTED_OUTPUT}" in the terminal, #save visible`;
}

async function vt_after(ms) {
    const began_s = await vt_s();
    const began = Date.now();
    await sleep(ms);
    const ended_s = await vt_s();
    return (ended_s - began_s) / ((Date.now() - began) / MS_PER_S);
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function sample_speed(speed) {
    const ratios = [];
    for(let i = 0; i < SPEED_SAMPLES[speed]; i += 1) ratios.push(await vt_after(SPEED_SAMPLE_MS[speed]));
    return ratios;
}

async function check_speed_buttons() {
    // The journal was recorded from the boot snapshot: seeking to 0 stops there, that is, at the first event.
    const start_s = event_times(journal)[0] / MS_PER_S;
    const lines = [];
    for(const speed of [1, 4]) {
        await seek_timeline(0);
        await wait_for(`#vt near the start of the recording ${start_s.toFixed(1)} с`, async () => near(await vt_s(), start_s));
        // The "paused" status arrives before machine.run_to sends the Worker its own pause: a click on "Далі" in this
        // gap (milliseconds, a person will not hit it) is cancelled, and playback stands still with vt = const.
        await sleep(SEEK_SETTLE_MS);
        await page.evaluate(`(() => { const play = document.getElementById('play'); if(play.textContent === '${PLAY_PAUSED_LABEL}') play.click(); })()`);
        await page.evaluate(`document.querySelector('[data-speed="${speed}"]').click()`);
        const on = await page.evaluate("[...document.querySelectorAll('[data-speed].on')].map(button => button.dataset.speed).join()");
        if(on !== String(speed)) throw new Error(`after clicking ${speed}× highlighted buttons "${on}»`);
        const ratios = await sample_speed(speed);
        const ratio = median(ratios);
        if(Math.abs(ratio - speed) > speed * SPEED_TOLERANCE) {
            const state = await page.evaluate("`vt ${document.getElementById('vt').textContent}, ${document.getElementById('play').textContent}, ${document.getElementById('mode').textContent}, ev ${document.getElementById('ev').textContent}`");
            throw new Error(`${speed}×: median ${ratio.toFixed(2)} (windows ${ratios.map(r => r.toFixed(2)).join(", ")}); ${state}`);
        }
        lines.push(`${speed}× → median ${ratio.toFixed(2)} (windows ${ratios.map(r => r.toFixed(2)).join(", ")})`);
    }
    await page.evaluate("document.querySelector('[data-speed=\"0\"]').click()");
    await wait_for("end of recording at \"макс\"", async () => (await vt_s()) >= duration_s - CLOCK_TOLERANCE_S);
    const on = await page.evaluate("[...document.querySelectorAll('[data-speed].on')].map(button => button.dataset.speed).join()");
    if(on !== "0") throw new Error(`after clicking "макс" highlighted buttons "${on}»`);
    return `guest/real speed: ${lines.join("; ")}; "макс" reached the end`;
}

async function check_open_file() {
    const other = read_journal(JSON.parse(readFileSync(OTHER_JOURNAL_FILE, "utf8")));
    const input = (await page.send("Runtime.evaluate", { expression: "document.getElementById('file')" })).result;
    await page.send("DOM.setFileInputFiles", { files: [OTHER_JOURNAL_FILE], objectId: input.objectId });
    await wait_for(`#count = ${other.events.length}`, async () => (await text_of("count")) === String(other.events.length));
    await wait_for(`#note «${END_NOTE}»`, async () => (await text_of("note")).includes(END_NOTE));
    const shown = await text_of("machine");
    if(shown !== other.header.machine) throw new Error(`#machine «${shown}", expected "${other.header.machine}»`);
    const items = await page.evaluate("document.querySelectorAll('#list li').length");
    const expected = commands(other.events).length;
    if(items !== expected) throw new Error(`in #list ${items} commands, expected ${expected}`);
    return `opened file ${other.header.machine}: events ${other.events.length}, commands ${items}, replay reached the end`;
}

async function check_pause_before_worker() {
    const main_page = page;
    page = await open_page(`player.html?j=${JOURNAL_PATH}`, GATE_BOOT_SNAPSHOT);
    try {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${page.id}`);
        await wait_for("\"Пауза\" button available while there is no Worker yet", async () =>
            (await text_of("count")) === String(journal.events.length) && await page.evaluate("!document.getElementById('replay').disabled"));
        if((await text_of("mode")) !== NO_STATUS_MODE) throw new Error("Worker already started, the test cannot see the moment before it exists");
        await click("play");
        await page.evaluate("window.__release(); true");
        await wait_for("first machine status", async () => (await text_of("mode")) !== NO_STATUS_MODE);
        await wait_for("the button shows \"Далі\" (the pause was not lost)", async () => (await text_of("play")) === PLAY_PAUSED_LABEL);
        const before = await vt_s();
        await sleep(PAUSED_CHECK_MS);
        const drift = (await vt_s()) - before;
        if(drift > PAUSED_VT_DRIFT_S || (await text_of("note")).includes(END_NOTE)) throw new Error(`the machine runs after a pause pressed before the Worker started: vt +${drift.toFixed(1)} с`);
        await page.evaluate("document.querySelector('[data-speed=\"0\"]').click(); true");
        await click("play");
        await wait_for("replay after \"Далі\" reached the end", async () => (await text_of("note")).includes(END_NOTE));
        return `pause before the Worker was created is kept (vt +${drift.toFixed(2)} s in ${PAUSED_CHECK_MS / MS_PER_S} s), "Далі" resumes replay to the end`;
    } finally {
        page.close();
        page = main_page;
    }
}

async function with_timeout(task) {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${ITEM_TIMEOUT_MS / MS_PER_S} с`)), ITEM_TIMEOUT_MS);
    });
    try {
        return await Promise.race([task(), expired]);
    } finally {
        clearTimeout(timer);
    }
}

async function run_item(label, check) {
    deadline = Date.now() + ITEM_TIMEOUT_MS - WAIT_GRACE_MS;
    let outcome;
    try {
        outcome = { ok: true, text: await with_timeout(check) };
    } catch (error) {
        outcome = { ok: false, text: error.message };
    }
    const shown = await text_of("err");
    if(shown) outcome = { ok: false, text: `${outcome.text}; #err: ${shown}` };
    console.log(`${outcome.ok ? "PASS" : "FAIL"} ${label}: ${outcome.text}`);
    return outcome.ok;
}

const ITEMS = [
    ["1 loading", check_load],
    ["2 jump to a command", check_command_jump],
    ["3 seek with the timeline", check_timeline_seek],
    ["4 \"Перевірити\"", check_verify],
    ["5 speed buttons 1×/4×/макс", check_speed_buttons],
    ["6 \"Продовжити звідси\"", check_go_live],
    ["7 opening a journal through the \"Файл\" field", check_open_file],
    ["8 \"Пауза\" before the Worker is created", check_pause_before_worker],
];

async function main() {
    load_journal();
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "player-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        deadline = Date.now() + ITEM_TIMEOUT_MS;
        await wait_for("chromium", async () => {
            try {
                return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok;
            } catch (error) {
                if(!(error instanceof TypeError)) throw error;
                return false;
            }
        });
        page = await open_page(`player.html?j=${JOURNAL_PATH}`);
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${page.id}`);
        let failures = 0;
        for(const [label, check] of ITEMS) {
            if(process.env.ONLY && !label.startsWith(process.env.ONLY)) continue;
            if(!(await run_item(label, check))) failures += 1;
        }
        console.log(failures ? `FAILED ${failures} of ${ITEMS.length}` : `ALL PASS ${ITEMS.length}`);
        process.exitCode = failures ? 1 : 0;
    }
    finally {
        page?.close();
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => {
    console.error("FAIL", error.message);
    process.exitCode = 1;
});
