// Browser checks of lab.html: rollback (the button, the list of commands, the exact cut of the journal, the live
// machine after it, replay of the resulting journal), the session that survives a reload (IndexedDB) and the
// recovery of a dead Worker, a crashed tab (Page.crash) restored from IndexedDB.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start_server } from "../../server.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8100;
const CDP_PORT = 9338;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const PROMPT = "~% ";
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, check) {
    const deadline = Date.now() + WAIT_MS;
    while(Date.now() < deadline) {
        const value = await check();
        if(value) return value;
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}`);
}

async function connect_target(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    const pending = new Map();
    let last_id = 0;
    let crashed = false;
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if(message.method === "Inspector.targetCrashed") crashed = true;
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
    return {
        send,
        crashed: () => crashed,
        evaluate: async expression => {
            const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if(!reply.result) throw new Error(`eval: ${JSON.stringify(reply.error)}`);
            if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
            return reply.result.result.value;
        },
    };
}

async function open_tab(path) {
    const url = encodeURIComponent(BASE + path);
    return connect_target(await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${url}`, { method: "PUT" })).json());
}

// confirm() answers from localStorage["test-confirm"] and logs the question to localStorage["test-asked"];
// window.machine is hooked on assignment so that window.out collects the whole serial output, replay included.
const PAGE_HOOKS = `
    window.confirm = question => {
        const asked = JSON.parse(localStorage.getItem("test-asked") ?? "[]");
        localStorage.setItem("test-asked", JSON.stringify([...asked, question]));
        return localStorage.getItem("test-confirm") !== "no";
    };
    let hooked = null;
    Object.defineProperty(window, "machine", { configurable: true, get: () => hooked, set: value => {
        hooked = value;
        window.out = "";
        value.on("serial", bytes => { window.out += new TextDecoder().decode(bytes); });
    } });
`;

async function open_hooked_tab(path) {
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const tab = await connect_target(target);
    await tab.send("Page.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS });
    await tab.send("Page.navigate", { url: BASE + path });
    return { ...tab, reload: () => tab.send("Page.reload") };
}

// Every key is its own journal event, as in a real terminal.
const type_line = (tab, text) => tab.evaluate(`(async () => {
    for(const ch of ${JSON.stringify(text + "\r")}) { window.machine.type(ch); await new Promise(r => setTimeout(r, 30)); }
    return true;
})()`);

const output_of = tab => tab.evaluate("window.out");
const journal_of = tab => tab.evaluate("window.machine.journal()");
const student_text = journal => journal.events.filter(e => e.t === "serial" && !e.by).map(e => e.data).join("");

async function run_command(tab, text, answer) {
    const before = (await output_of(tab)).length;
    await type_line(tab, text);
    await wait_for(`answer ${answer}`, async () => (await output_of(tab)).slice(before).includes(`\n${answer}\r`));
}

async function wait_snapshot_after_now(tab) {
    const events = (await journal_of(tab)).events.length;
    await wait_for("snapshot after the current events", () => tab.evaluate(`window.machine.snapshots.some(s => s.next >= ${events})`));
}

async function roll_back(tab, label) {
    await tab.evaluate(`window.confirm = () => true; document.getElementById("note").textContent = ""; document.getElementById("rollback").click()`);
    await wait_for("command list", () => tab.evaluate(`!document.getElementById("rollback_list").hidden`));
    const clicked = await tab.evaluate(`(() => {
        const item = [...document.querySelectorAll("#rollback_list li")].find(li => li.textContent.endsWith(${JSON.stringify(label)}));
        item?.click();
        return Boolean(item);
    })()`);
    if(!clicked) throw new Error(`no item in the list ${label}`);
    await wait_for("rollback finished", () => tab.evaluate(`document.getElementById("note").textContent.startsWith("Відкочено")`));
    await wait_for("machine live again", () => tab.evaluate(`document.getElementById("mode").textContent === "жива"`));
}

async function replay_ok(tab) {
    const id = await tab.evaluate(`(async () => {
        const body = JSON.stringify(await window.machine.journal());
        const reply = await fetch("/journals", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        return (await reply.json()).id;
    })()`);
    const replay = await open_tab(`lab.html?task=/journals/${id}&name=replay&profile=buildroot&relay=off`);
    await wait_for("replay to the end", () => replay.evaluate(`document.getElementById("banner").textContent === "Машина ваша"`));
    const error = await replay.evaluate(`document.getElementById("err").textContent`);
    if(error) throw new Error(`replay error: ${error}`);
}

async function test_rollback(tab) {
    await wait_for("lab ready", () => tab.evaluate("typeof window.machine === 'object'"));
    await tab.evaluate(`window.out = ""; window.machine.on("serial", b => { window.out += new TextDecoder().decode(b); }); true`);
    await wait_for("prompt", async () => (await tab.evaluate("window.machine.journal().then(j => j.events.length)")) >= 1);
    await run_command(tab, "echo one", "one");
    await wait_snapshot_after_now(tab);
    await run_command(tab, "echo two", "two");
    await run_command(tab, "echo three", "three");
    await wait_snapshot_after_now(tab);

    await roll_back(tab, "echo two");
    const journal = await journal_of(tab);
    const typed = student_text(journal);
    if(!typed.endsWith("echo one\r")) throw new Error(`the journal after the rollback does not end at echo one: ${JSON.stringify(typed)}`);
    if(/two|three/.test(typed)) throw new Error(`two/three left in the journal: ${JSON.stringify(typed)}`);
    console.log("1 OK rollback to echo two: the student's last serial -", JSON.stringify(typed.slice(-12)));

    await run_command(tab, "echo four", "four");
    await replay_ok(tab);
    console.log("2 OK after the rollback the machine is live (four), the journal replayed to the end without error");

    await roll_back(tab, "До початку");
    if((await journal_of(tab)).events.some(e => e.t === "serial" && !e.by)) throw new Error("student input left after a rollback to the start");
    await run_command(tab, "echo five", "five");
    const text = student_text(await journal_of(tab));
    if(text !== "echo five\r") throw new Error(`after a rollback to the start the journal has: ${JSON.stringify(text)}`);
    await replay_ok(tab);
    console.log("3 OK rollback to the start: echo five works, the journal replayed without error");
}


// Page state that survives a reload: the stores of the "v86-replay" IndexedDB.
const idb_session = (tab, name) => tab.evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("v86-replay");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const all = store => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const mine = row => row.key.includes(${JSON.stringify(JSON.stringify(name))});
    const meta = (await all("sessions")).find(mine) ?? null;
    const chunks = (await all("events")).filter(mine).sort((a, b) => a.start - b.start);
    db.close();
    return { meta, chunks: chunks.length, events: chunks.flatMap(chunk => chunk.events) };
})()`);

const asked_of = tab => tab.evaluate(`JSON.parse(localStorage.getItem("test-asked") ?? "[]")`);
const set_answer = (tab, answer) => tab.evaluate(`localStorage.setItem("test-confirm", ${JSON.stringify(answer)}); localStorage.removeItem("test-asked")`);
const save_now = tab => tab.evaluate(`dispatchEvent(new Event("pagehide"))`);

async function wait_live(tab) {
    await wait_for("machine live", async () => {
        try { return await tab.evaluate(`typeof window.machine === "object" && document.getElementById("mode").textContent === "жива"`); }
        catch { return false; }
    });
}

async function wait_saved(tab, name, predicate, label) {
    await wait_for(label, async () => predicate(await idb_session(tab, name)));
}

const same_events = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function test_persist(set_up) {
    const name = "persist-yes";
    const tab = await set_up(`lab.html?profile=buildroot&relay=off&name=${name}`);
    await wait_live(tab);
    await wait_for("prompt", async () => (await tab.evaluate("window.machine.journal().then(j => j.events.length)")) >= 1);
    await run_command(tab, "echo one", "one");
    await wait_saved(tab, name, saved => student_text(saved).includes("echo one\r"), "periodic save (15 s)");
    console.log("4 OK the journal was appended to IndexedDB by the timer");
    await run_command(tab, "echo two", "two");
    await sleep(1000);
    await save_now(tab);
    await wait_saved(tab, name, saved => student_text(saved).includes("echo two\r"), "save on pagehide");
    const saved = await idb_session(tab, name);
    const out_before = await output_of(tab);

    await set_answer(tab, "yes");
    const began = Date.now();
    await tab.reload();
    await wait_live(tab);
    const restore_ms = Date.now() - began;
    const asked = await asked_of(tab);
    if(asked.length !== 1 || !asked[0].startsWith("Відновити попередню сесію")) throw new Error(`question at startup: ${JSON.stringify(asked)}`);
    const out_after = await output_of(tab);
    if(!out_after.startsWith(out_before)) throw new Error(`output after the restore differs:${JSON.stringify(out_before.slice(-80))}\n${JSON.stringify(out_after.slice(-80))}`);
    await run_command(tab, "echo three", "three");
    const journal = await journal_of(tab);
    if(student_text(journal) !== "echo one\recho two\recho three\r") throw new Error(`journal after the restore: ${JSON.stringify(student_text(journal))}`);
    if(!same_events(journal.events.slice(0, saved.events.length), saved.events)) throw new Error("old events in the journal changed");
    await save_now(tab);
    await wait_saved(tab, name, now => student_text(now).includes("echo three\r"), "save after the restore");
    const persisted = await idb_session(tab, name);
    if(!same_events(persisted.events, (await journal_of(tab)).events.slice(0, persisted.events.length))) throw new Error("the saved journal is not a prefix of the live one");
    console.log(`5 OK "так": same output, machine live, journal = ${saved.events.length} old + ${journal.events.length - saved.events.length} new events; restore ${restore_ms} ms`);

    await set_answer(tab, "no");
    await tab.reload();
    await wait_live(tab);
    if((await asked_of(tab)).length !== 1) throw new Error("with \"ні\" the question was not asked exactly once");
    await run_command(tab, "echo four", "four");
    await save_now(tab);
    await wait_saved(tab, name, now => student_text(now).includes("echo four\r"), "save of the new session");
    const fresh = await idb_session(tab, name);
    if(/one|two|three/.test(student_text(fresh))) throw new Error(`old session not deleted: ${JSON.stringify(student_text(fresh))}`);
    if(/one|two|three/.test(student_text(await journal_of(tab)))) throw new Error("with \"ні\" the machine started with the old journal");
    console.log("6 OK \"ні\": old session deleted, new machine");

    await set_answer(tab, "yes");
    await tab.evaluate(`document.getElementById("submit").click()`);
    await wait_for("session deleted after \"Здати\"", async () => (await idb_session(tab, name)).meta === null);
    await tab.reload();
    await wait_live(tab);
    if((await asked_of(tab)).length !== 0) throw new Error("after \"Здати\" the restore question is still asked");
    console.log("7 OK after \"Здати\" the session is not offered");
}

// The window of the mirror is one status message (~100 ms): wait before killing the Worker.
async function ready_for_crash(tab, name) {
    await wait_live(tab);
    await wait_for("prompt", async () => (await tab.evaluate("window.machine.journal().then(j => j.events.length)")) >= 1);
    await run_command(tab, "echo one", "one");
    await sleep(1000);
    return journal_of(tab);
}

async function check_recovered(tab, before, word) {
    await wait_for("restore report", () => tab.evaluate(`document.getElementById("note").textContent.startsWith("Машину відновлено")`));
    await wait_live(tab);
    await run_command(tab, `echo ${word}`, word);
    const after = await journal_of(tab);
    const keep = before.events.length - 3;
    if(!same_events(after.events.slice(0, keep), before.events.slice(0, keep))) throw new Error("after the restore the start of the journal changed");
    if(student_text(after) !== `echo one\recho ${word}\r`) throw new Error(`journal after the restore: ${JSON.stringify(student_text(after))}`);
    const error = await tab.evaluate(`document.getElementById("err").textContent`);
    if(error) throw new Error(`error on the page: ${error}`);
}

async function test_crash(set_up) {
    const tab = await set_up("lab.html?profile=buildroot&relay=off&name=crash-a");
    const before = await ready_for_crash(tab);
    await tab.evaluate(`window.machine.worker.dispatchEvent(new ErrorEvent("error", { message: "test: uncaught error in Worker" })); true`);
    await check_recovered(tab, before, "two");
    console.log("8 OK error event from the Worker: the machine was rebuilt from the snapshot and the journal, is live, the command ran");

    await tab.evaluate(`window.machine.silence_ms = 1500; window.machine.worker.terminate(); true`);
    await wait_for("error of the second crash", () => tab.evaluate(`document.getElementById("err").textContent.includes("вдруге поспіль")`));
    await sleep(3000);
    if(await tab.evaluate("window.machine.recovering")) throw new Error("the second crash started a new restore");
    console.log("9 OK second crash in a row: error shown, no loop");

    const silent = await set_up("lab.html?profile=buildroot&relay=off&name=crash-c");
    const journal = await ready_for_crash(silent);
    await silent.evaluate(`window.machine.silence_ms = 1500; window.machine.worker.terminate(); true`);
    await check_recovered(silent, journal, "three");
    console.log("10 OK silent Worker (terminate without an event): the watchdog brought the machine back");
}

const SAVE_PERIOD_S = 15;
const CRASH_AFTER_SAVE_MS = 9000;

// Time of the session's last write to IndexedDB (meta.updated changes on every append, even an empty one).
async function next_save(tab, name, after) {
    return wait_for("next session write", async () => {
        const { meta } = await idb_session(tab, name);
        return meta && meta.updated > after ? meta.updated : 0;
    });
}

// Page.crash ends the tab process without pagehide, like running out of memory: only what the timer managed to write is
// kept.
async function test_page_crash(set_up) {
    const name = "crash-page";
    const tab = await set_up(`lab.html?profile=buildroot&relay=off&name=${name}`);
    await tab.send("Inspector.enable");
    await wait_live(tab);
    await wait_for("prompt", async () => (await tab.evaluate("window.machine.journal().then(j => j.events.length)")) >= 1);
    await run_command(tab, "echo one", "one");
    await run_command(tab, "echo two", "two");
    await wait_saved(tab, name, saved => student_text(saved).includes("echo two\r"), "periodic save of two commands");
    const saved_at = await next_save(tab, name, (await idb_session(tab, name)).meta.updated);
    const clock = Date.now();
    const since_save = () => (Date.now() - clock) / 1000;
    await run_command(tab, "echo three", "three");
    await sleep(3000);
    await run_command(tab, "echo four", "four");
    await sleep(Math.max(0, CRASH_AFTER_SAVE_MS - (Date.now() - clock)));
    const stored = await idb_session(tab, name);
    if(stored.meta.updated !== saved_at) throw new Error("another save happened between the last save and the crash: the test does not measure the loss");
    const live = await journal_of(tab);
    const out_before = await output_of(tab);
    await set_answer(tab, "yes");
    const crash_after_s = since_save();
    tab.send("Page.crash");
    await wait_for("tab crashed (Inspector.targetCrashed)", async () => tab.crashed());
    await sleep(500);

    const began = Date.now();
    const restored = await set_up(`lab.html?profile=buildroot&relay=off&name=${name}`);
    await wait_live(restored);
    const asked = await asked_of(restored);
    if(asked.length !== 1 || !asked[0].startsWith("Відновити попередню сесію")) throw new Error(`question at startup after the crash: ${JSON.stringify(asked)}`);
    const after = await journal_of(restored);
    const typed = student_text(after);
    if(typed !== "echo one\recho two\r") throw new Error(`after the crash the restored journal has ${JSON.stringify(typed)}, expected the first two commands`);
    if(!same_events(after.events.slice(0, stored.events.length), stored.events)) throw new Error("the restored journal does not equal the saved one");
    const out_after = await output_of(restored);
    if(!out_after.includes("\none\r") || !out_after.includes("\ntwo\r")) throw new Error("no one/two in the output of the restored machine");
    await run_command(restored, "echo five", "five");
    const lost_events = live.events.length - stored.events.length;
    const lost_commands = ["three", "four"].filter(word => !typed.includes(word));
    console.log(`11 OK Page.crash: "Відновити" asked, "так" brought the machine back (${stored.events.length} of ${live.events.length} events), echo one/two in place, echo five works; lost ${lost_events} events and ${lost_commands.length} commands (${lost_commands.join(", ")}), crash ${crash_after_s.toFixed(1)} s after the write (period ${SAVE_PERIOD_S} s); restore ${Date.now() - began} ms (output before the crash ${out_before.length} bytes)`);
}

async function main() {
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "lab-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        if(process.env.ONLY === "pagecrash") return await test_page_crash(open_hooked_tab);
        await test_rollback(await open_tab("lab.html?profile=buildroot&relay=off"));
        await test_persist(open_hooked_tab);
        await test_crash(open_hooked_tab);
        await test_page_crash(open_hooked_tab);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
