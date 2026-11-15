// Browser check of lessons in player.html: the student run (note, "now yourself" segment, retry, solution, continue),
// a lesson with two "now yourself" segments, a segment that lasts to the end of the journal and the teacher's markup
// saved into header.lesson.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start_server } from "../../server.mjs";
import { read_journal, commands, event_times } from "../../core/journal.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8102;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const JOURNAL_PATH = "/app/test/out/br1.json";
const JOURNAL_FILE = fileURLToPath(new URL("../out/br1.json", import.meta.url));
const WAIT_MS = Number(process.env.WAIT_MS ?? 120000);
const POLL_MS = 300;
const MS_PER_S = 1000;
// Segment bounds come from the commands of journal br1: [0] ifconfig, [1] uname, [2] sleep, [3] loop, [4] head.
const JOURNAL = read_journal(JSON.parse(readFileSync(JOURNAL_FILE, "utf8")));
const TOTAL = JOURNAL.events.length;
const COMMANDS = commands(JOURNAL.events);
const AFTER_LOOP_MARGIN = 4;
const LOOP_DONE = COMMANDS[4].start - AFTER_LOOP_MARGIN;
const NOTE = { t: "note", at: COMMANDS[0].index, text: "Спершу uname -r" };
const ENTER_KEY_CODE = 13;
const SELF = { t: "self", from: COMMANDS[1].start, to: COMMANDS[2].index, text: "Виконайте: echo mine" };
// A lesson with two segments: "Далі" after the first one leads to the teacher's state once the loop has finished,
// and 1x playback reaches `from` of the second segment.
const FIRST = { t: "self", from: COMMANDS[1].start, to: LOOP_DONE, text: "Виконайте: echo alpha" };
const SECOND = { t: "self", from: COMMANDS[4].start, to: COMMANDS[4].index, text: "Виконайте: echo beta" };
const NOTE_AFTER_FIRST = { t: "note", at: LOOP_DONE, text: "Цикл відпрацював" };
const LOOP_RESULT = "100000";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, check) {
    const deadline = Date.now() + WAIT_MS;
    let last_error = "";
    while(Date.now() < deadline) {
        // A page that was just opened may not have the needed elements yet.
        try {
            const value = await check();
            if(value) return value;
        } catch(error) { last_error = error.message; }
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}${last_error && ` (last error: ${last_error})`}`);
}

async function open_tab(path) {
    const url = encodeURIComponent(BASE + path);
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${url}`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    const pending = new Map();
    let last_id = 0;
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if(message.method === "Runtime.exceptionThrown") console.log("EXC", message.params.exceptionDetails.exception?.description ?? "");
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    };
    const send = (method, params = {}) => new Promise(resolve => {
        last_id += 1;
        pending.set(last_id, resolve);
        ws.send(JSON.stringify({ id: last_id, method, params }));
    });
    await send("Runtime.enable");
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${target.id}`);
    const evaluate = async expression => {
        const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
        return reply.result.result.value;
    };
    const type_line = async text => {
        await evaluate("document.querySelector('.xterm-helper-textarea')?.focus(); true");
        await send("Input.insertText", { text });
        const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE, text: "\r" };
        await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE });
    };
    return { evaluate, type_line };
}

const text_of = (tab, id) => tab.evaluate(`document.getElementById("${id}").textContent`);
const phase_of = tab => tab.evaluate("document.body.dataset.lessonPhase");
const screen_of = tab => tab.evaluate("document.querySelector('#terminal .xterm-rows')?.innerText ?? ''");
const click = (tab, id) => tab.evaluate(`document.getElementById("${id}").click(); true`);
const count_of = async (tab, word) => ((await screen_of(tab)).match(new RegExp(word, "g")) ?? []).length;
const count_mine = tab => count_of(tab, "mine");

async function expect_clean(tab, what) {
    const error = await text_of(tab, "err");
    if(error) throw new Error(`${what}: #err «${error}»`);
}

async function test_student_run(tab) {
    await wait_for("note", async () => (await text_of(tab, "lesson_note")) === NOTE.text);
    await wait_for("student phase", async () => (await phase_of(tab)) === "student");
    if(!(await text_of(tab, "lesson_task_text")).includes(SELF.text)) throw new Error("no task text");
    await wait_for("machine live", async () => (await text_of(tab, "mode")) === "жива");
    const next = await text_of(tab, "ev");
    if(!next.startsWith(`${SELF.from} з ${SELF.from}`)) throw new Error(`stop is not at from: #ev "${next}»`);
    await tab.type_line("echo mine");
    await wait_for("answer mine", async () => (await count_mine(tab)) >= 2);
    console.log("1 OK note, stop at event", SELF.from, ", machine live, echo mine answers");

    await click(tab, "lesson_retry");
    await wait_for("student again", async () => (await phase_of(tab)) === "student" && (await text_of(tab, "mode")) === "жива");
    if(await count_mine(tab)) throw new Error("after \"Спробувати знову\" mine is still on screen");
    await tab.type_line("echo mine");
    await wait_for("mine after retry", async () => (await count_mine(tab)) >= 2);
    console.log("2 OK \"Спробувати знову\": clean screen, machine live, input works");

    await click(tab, "lesson_solution");
    await wait_for("solution shown", async () => (await phase_of(tab)) === "solved");
    if(await count_mine(tab)) throw new Error("the teacher's solution contains mine");
    await expect_clean(tab, "solution");
    console.log("3 OK \"Показати розв'язок\" reached the end of the segment without error");

    await click(tab, "lesson_next");
    await wait_for("end of lesson", async () => (await phase_of(tab)) === "done");
    const final = await text_of(tab, "ev");
    if(!final.startsWith(`${TOTAL} з ${TOTAL}`)) throw new Error(`did not reach the end of the journal: #ev "${final}»`);
    await expect_clean(tab, "Далі");
    console.log("4 OK \"Далі\": replay reached the end of the journal (", final, ") without error");
}

async function post_lesson(journal, lesson) {
    const body = JSON.stringify({ header: { ...journal.header, lesson }, events: journal.events });
    const reply = await fetch(`http://127.0.0.1:${SERVER_PORT}/journals`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return (await reply.json()).id;
}

async function test_two_segments(tab) {
    await wait_for("student phase 1", async () => (await phase_of(tab)) === "student");
    if(!(await text_of(tab, "lesson_task_text")).includes(FIRST.text)) throw new Error("no text of the first task");
    await wait_for("machine live 1", async () => (await text_of(tab, "mode")) === "жива");
    const first_stop = await text_of(tab, "ev");
    if(!first_stop.startsWith(`${FIRST.from} з ${FIRST.from}`)) throw new Error(`first stop is not at from: #ev "${first_stop}»`);
    await tab.type_line("echo alpha");
    await wait_for("answer alpha", async () => (await count_of(tab, "alpha")) >= 2);
    await click(tab, "lesson_solution");
    await wait_for("solution of the first", async () => (await phase_of(tab)) === "solved");
    await click(tab, "lesson_next");
    await wait_for("play phase after Далі", async () => (await phase_of(tab)) === "play");
    await wait_for("student phase 2", async () => (await phase_of(tab)) === "student");
    await wait_for("machine live 2", async () => (await text_of(tab, "mode")) === "жива");
    const second_stop = await text_of(tab, "ev");
    if(!second_stop.startsWith(`${SECOND.from} з ${SECOND.from}`)) throw new Error(`second stop is not at from: #ev "${second_stop}»`);
    if(!(await text_of(tab, "lesson_task_text")).includes(SECOND.text)) throw new Error("no text of the second task");
    if(await text_of(tab, "lesson_note") !== NOTE_AFTER_FIRST.text) throw new Error(`after Далі the note is not shown "${NOTE_AFTER_FIRST.text}»`);
    if(await count_of(tab, "alpha")) throw new Error("student input from the first segment stayed on screen after \"Далі\"");
    // The terminal renders output asynchronously: the loop result may arrive on screen a moment after the phase changes.
    await wait_for("the result of the teacher's loop after \"Далі\" (the teacher's state was reached)", async () => (await count_of(tab, LOOP_RESULT)) >= 2);
    await expect_clean(tab, "Далі of the first segment");
    console.log("5 OK two segments: \"Далі\" led to the teacher's state, student without alpha, stop at", SECOND.from);

    await tab.type_line("echo beta");
    await wait_for("answer beta", async () => (await count_of(tab, "beta")) >= 2);
    await click(tab, "lesson_retry");
    await wait_for("student 2 after retry", async () => (await phase_of(tab)) === "student" && (await text_of(tab, "mode")) === "жива");
    if(await count_of(tab, "beta")) throw new Error("after \"Спробувати знову\" in the second segment beta is still there");
    await wait_for("the teacher's state after a retry of the second segment", async () => (await count_of(tab, LOOP_RESULT)) >= 2);
    await click(tab, "lesson_solution");
    await wait_for("solution of the second", async () => (await phase_of(tab)) === "solved");
    await click(tab, "lesson_next");
    await wait_for("end of lesson", async () => (await phase_of(tab)) === "done");
    const final = await text_of(tab, "ev");
    if(!final.startsWith(`${TOTAL} з ${TOTAL}`)) throw new Error(`did not reach the end of the journal: #ev "${final}»`);
    await expect_clean(tab, "Далі of the second segment");
    console.log("6 OK retry of the second segment, solution, \"Далі\" to the end of the journal (", final, ")");
}

async function test_segment_to_end(tab, total) {
    await wait_for("student phase", async () => (await phase_of(tab)) === "student");
    await wait_for("machine live", async () => (await text_of(tab, "mode")) === "жива");
    await tab.type_line("echo omega");
    await wait_for("answer omega", async () => (await count_of(tab, "omega")) >= 2);
    await click(tab, "lesson_solution");
    await wait_for("solution to the end of the journal", async () => (await phase_of(tab)) === "solved");
    const at_end = await text_of(tab, "ev");
    if(!at_end.startsWith(`${total} з ${total}`)) throw new Error(`the solution did not reach the end of the journal: #ev "${at_end}»`);
    if(await count_of(tab, "omega")) throw new Error("the teacher's solution contains omega");
    await expect_clean(tab, "solution to the end of the journal");
    await click(tab, "lesson_next");
    await wait_for("end of lesson after the segment to the end", async () => (await phase_of(tab)) === "done");
    await expect_clean(tab, "Далі after the segment to the end of the journal");
    if((await text_of(tab, "mode")) === "жива") throw new Error("after the last segment to the end the machine stayed live");
    if(!(await text_of(tab, "ev")).startsWith(`${total} з ${total}`)) throw new Error("after \"Далі\" the position is not at the end of the journal");
    console.log("7 OK segment to the end of the journal: the solution and \"Далі\" reach", total, "without hanging or error");
}

async function marked_event(tab) {
    await sleep(800);
    return Number((await text_of(tab, "ev")).split(" ")[0]);
}

async function test_markup(journal) {
    const tab = await open_tab(`player.html?j=${JOURNAL_PATH}`);
    await wait_for("journal loaded", async () => (await text_of(tab, "note")).includes("Кінець запису"));
    const times = event_times(journal);
    const list = commands(journal.events);
    const jump = async index => {
        await tab.evaluate(`document.querySelectorAll('#list li')[${index}].click(); true`);
        await sleep(500);
        await wait_for("pause after the jump", async () => (await text_of(tab, "play")) === "Далі");
        return marked_event(tab);
    };
    await click(tab, "mark_to");
    if(!(await text_of(tab, "err")).includes("Спочатку")) throw new Error("\"Сам: кінець\" without a start gave no error");
    const set_text = text => tab.evaluate(`document.getElementById("lesson_text").value = ${JSON.stringify(text)}; true`);

    const at = await jump(1);
    await set_text("Пояснення про sleep");
    await click(tab, "mark_note");
    await set_text("extra");
    await click(tab, "mark_note");
    if((await tab.evaluate("document.querySelectorAll('#lesson_items li').length")) !== 2) throw new Error("the list of marks does not have 2 items");
    await tab.evaluate(`[...document.querySelectorAll('#lesson_items li')].find(li => li.textContent.includes("extra")).querySelector("button").click(); true`);
    const from = await jump(2);
    await click(tab, "mark_from");
    const to = await jump(3);
    await set_text("Зробіть самі");
    await click(tab, "mark_to");
    if(await text_of(tab, "err")) throw new Error(`markup error: ${await text_of(tab, "err")}`);

    await tab.evaluate(`window.saved = null; URL.createObjectURL = blob => { window.saved = blob; return "blob:test"; }; true`);
    await click(tab, "save_lesson");
    const saved = JSON.parse(await tab.evaluate(`window.saved.text()`));
    read_journal(saved);
    const expected = [{ t: "note", at, text: "Пояснення про sleep" }, { t: "self", from, to, text: "Зробіть самі" }];
    if(JSON.stringify(saved.header.lesson) !== JSON.stringify(expected)) throw new Error(`header.lesson: ${JSON.stringify(saved.header.lesson)}, expected ${JSON.stringify(expected)}`);
    if(saved.events.length !== journal.events.length) throw new Error("journal events changed");
    if(!(at <= from && from < to)) throw new Error(`indices out of order: ${at} ${from} ${to}`);
    console.log("8 OK markup: header.lesson =", JSON.stringify(saved.header.lesson), `(command times ${[1, 2, 3].map(i => (times[list[i].index] / MS_PER_S).toFixed(1))} s)`);
}

async function main() {
    const journal = JOURNAL;
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "lesson-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        const lesson = { header: { ...journal.header, lesson: [NOTE, SELF] }, events: journal.events };
        const id = (await (await fetch(`http://127.0.0.1:${SERVER_PORT}/journals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lesson) })).json()).id;
        await test_student_run(await open_tab(`player.html?lesson=/journals/${id}`));
        const two = await post_lesson(journal, [NOTE, FIRST, NOTE_AFTER_FIRST, SECOND]);
        await test_two_segments(await open_tab(`player.html?lesson=/journals/${two}`));
        const total = journal.events.length;
        const to_end = await post_lesson(journal, [{ t: "self", from: LOOP_DONE, to: total, text: "Виконайте: echo omega" }]);
        await test_segment_to_end(await open_tab(`player.html?lesson=/journals/${to_end}`), total);
        await test_markup(journal);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
