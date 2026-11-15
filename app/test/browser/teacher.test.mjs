// Browser check of teacher.html: a student tile appears, teacher input reaches the student's shell, reports,
// the room survives a student socket drop, a silent drop, a hung WebSocket handshake, a server restart and a
// teacher page reload, "Роздати", rollback in the room, rollback in a room with a fake relay that answers DHCP
// with unicast frames.
// Starts node app/server.mjs and headless Chromium (CDP).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";
import { start_dhcp_relay } from "./fake_dhcp_relay.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_DOWN_MS = 3000;

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8098);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const ROOM = "t9";
const STUDENT = "ivan";
const MARKER = "teacher-was-here";
const RELAY_ROOM = "t10";
const RELAY_STUDENT = "olga";
const DHCP_COMMAND = "udhcpc -i eth0 -q -n -t 4 -T 3";
const LEASE_RE = /lease of 10\.5\.7\.221/g;
const PLAYER_LINK = "player.html?j=";
const JOURNAL_FORMAT = "v86-replay/9";
const PROMPT = "~% ";
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 500;
const ENTER_KEY_CODE = 13;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TILE = `[...document.querySelectorAll('.tile')].find(t => t.querySelector('.label').textContent.startsWith('${STUDENT}'))`;
const TILE_TEXT = `(${TILE}?.querySelector('.xterm-rows')?.innerText ?? '')`;

async function wait_for(label, check) {
    const deadline = Date.now() + WAIT_MS;
    while(Date.now() < deadline) {
        if(await check()) return;
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}`);
}

// Records the /ws sockets so that the test can cut a student's connection from the page. window.__mute = true imitates
// a Wi-Fi drop without closing: the socket stays open but neither receives nor sends, and new
// connections fail at once, as when offline. CDP Network.emulateNetworkConditions does not touch WebSockets that are
// already open.
// window.__hang = "ws://…" sends new connections to an address that accepts TCP and never answers the handshake.
const RECORD_SOCKETS = `(() => {
    window.__sockets = [];
    window.__mute = false;
    window.__hang = "";
    const Native = WebSocket;
    window.WebSocket = class extends Native {
        constructor(url, ...rest) {
            super(window.__hang || (window.__mute ? "ws://127.0.0.1:1/" : url), ...rest);
            window.__sockets.push(this);
        }
        send(data) { if(!window.__mute) super.send(data); }
        set onmessage(fn) { super.onmessage = fn && (event => { if(!window.__mute) fn(event); }); }
    };
})()`;

async function open_tab(path) {
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    const pending = new Map();
    let last_id = 0;
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if(message.method === "Runtime.exceptionThrown") console.log("EXC", message.params.exceptionDetails.exception?.description ?? "");
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
    };
    const send = (method, params = {}) => new Promise(resolve => {
        last_id += 1;
        pending.set(last_id, resolve);
        ws.send(JSON.stringify({ id: last_id, method, params }));
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: RECORD_SOCKETS });
    await send("Page.navigate", { url: BASE + path });
    return {
        id: target.id,
        send,
        close: () => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`),
        activate: () => fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${target.id}`),
        evaluate: async expression => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value,
    };
}

async function type_line(tab, text) {
    await tab.send("Input.insertText", { text });
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE, text: "\r" };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE });
}

async function item_link(tab, list) {
    return tab.evaluate(`[...document.querySelectorAll('#${list} li')].find(li => li.textContent.startsWith('${STUDENT},'))?.querySelector('a')?.getAttribute('href') ?? null`);
}

async function check_journal(href) {
    const journal_path = new URL(href, BASE).searchParams.get("j");
    const journal = await (await fetch(`http://127.0.0.1:${SERVER_PORT}${journal_path}`)).json();
    if(journal.header?.format !== JOURNAL_FORMAT) throw new Error(`journal by link: format ${journal.header?.format}`);
    if(!journal.events?.length) throw new Error("journal by link: events is empty");
    console.log(`PASS journal by link: ${JOURNAL_FORMAT}, events ${journal.events.length}`);
}

const count_items = (tab, list) => tab.evaluate(`document.querySelectorAll('#${list} li').length`);
const text_of = async (tab, id) => (await tab.evaluate(`document.getElementById('${id}')?.textContent ?? ''`)) ?? "";
const tile_has = (teacher, text, times = 2) => teacher.evaluate(`${TILE_TEXT}.split('${text}').length > ${times}`);

async function type_to_student(teacher, text) {
    await teacher.evaluate(`document.getElementById('big').hidden && ${TILE}.click(); true`);
    await sleep(300);
    await type_line(teacher, text);
}

async function test_reload(teacher, before) {
    await teacher.evaluate("location.reload()");
    await sleep(1000);
    await wait_for("after the teacher reload the report lists are in place", async () =>
        await count_items(teacher, "reports") === before.reports && await count_items(teacher, "submits") === before.submits);
    await wait_for("after the reload the tile has the student's output", async () => teacher.evaluate(`${TILE} !== undefined && ${TILE_TEXT}.includes('${PROMPT}') && ${TILE_TEXT}.split('${MARKER}').length > 2`));
    console.log(`PASS teacher reload: reports ${before.reports}, здач ${before.submits}, output history in the tile`);
}

async function test_student_drop(teacher, lab) {
    const sockets_before = await lab.evaluate("window.__sockets.length");
    await lab.evaluate(`window.__sockets.filter(s => s.url.endsWith('/ws')).at(-1).close(); true`);
    await wait_for("student reconnected", async () => await lab.evaluate("window.__sockets.length") > sockets_before && await text_of(lab, "room_state") === "");
    await wait_for("tile alive after the drop", async () => teacher.evaluate(`!${TILE}.classList.contains('gone')`));
    await type_to_student(teacher, "echo after-blip");
    await wait_for("teacher input arrived after the student drop", async () => tile_has(teacher, "after-blip"));
    console.log("PASS student socket drop: tile alive, teacher input arrives");
}

const SILENCE_LOST_MS = 25000;

async function test_silent_drop(teacher, lab) {
    const address = () => text_of(lab, "net");
    const address_before = await address();
    await lab.evaluate("window.__mute = true; true");
    const muted_at = Date.now();
    await wait_for("student status line: connection lost (socket not closed)", async () => (await text_of(lab, "room_state")).includes("зв'язок втрачено"));
    const seconds = (Date.now() - muted_at) / 1000;
    if(Date.now() - muted_at > SILENCE_LOST_MS) throw new Error(`the watchdog fired after ${seconds.toFixed(1)} s, expected at most ${SILENCE_LOST_MS / 1000} с`);
    await lab.evaluate("window.__mute = false; true");
    await wait_for("student back in the room", async () => await text_of(lab, "room_state") === "");
    await wait_for("same address after the silent drop", async () => await address() === address_before);
    await wait_for("tile alive after the silent drop", async () => teacher.evaluate(`!${TILE}.classList.contains('gone')`));
    await type_to_student(teacher, "echo after-silent");
    await wait_for("teacher input arrived after the silent drop", async () => tile_has(teacher, "after-silent"));
    console.log(`PASS silent drop without closing the socket: "зв'язок втрачено" after ${seconds.toFixed(1)} s, after coming back the address ${address_before} is the same, teacher input arrives`);
}

const CONNECT_TIMEOUT_S = 10;
const SOCKET_CONNECTING = 0;
const SOCKET_CLOSED = 3;

// A server that accepts TCP and stays silent: the client socket stays in CONNECTING.
async function start_silent_tcp() {
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { url: `ws://127.0.0.1:${server.address().port}/ws`, accepted: () => sockets.size, close: () => { sockets.forEach(socket => socket.destroy()); server.close(); } };
}

async function test_connect_timeout(teacher, lab) {
    const silent = await start_silent_tcp();
    try {
        const address_before = await text_of(lab, "net");
        const count = () => lab.evaluate("window.__sockets.length");
        const ready_state = index => lab.evaluate(`window.__sockets[${index}].readyState`);
        const hung_index = await count();
        await lab.evaluate(`window.__hang = ${JSON.stringify(silent.url)}; window.__sockets.filter(s => s.url.endsWith('/ws')).at(-1).close(); true`);
        await wait_for("student created a hanging socket", async () => await count() > hung_index);
        const hung_at = Date.now();
        await wait_for("student status line: connection lost", async () => (await text_of(lab, "room_state")).includes("зв'язок втрачено"));
        await sleep(2000);
        if(await ready_state(hung_index) !== SOCKET_CONNECTING) throw new Error("the socket should hang in CONNECTING, but it is already closed (the test does not reproduce a hung handshake)");
        await wait_for("hung socket closed by timeout", async () => await ready_state(hung_index) === SOCKET_CLOSED);
        const seconds = (Date.now() - hung_at) / 1000;
        if(seconds < CONNECT_TIMEOUT_S - 1 || seconds > CONNECT_TIMEOUT_S + 5) throw new Error(`hung socket closed after ${seconds.toFixed(1)} s, expected ≈ ${CONNECT_TIMEOUT_S} с`);
        await wait_for("a new attempt after closing", async () => await count() > hung_index + 1);
        if(!(await text_of(lab, "room_state")).includes("зв'язок втрачено")) throw new Error("during hung attempts the status line does not show \"зв'язок втрачено\"");
        await lab.evaluate("window.__hang = ''; true");
        await wait_for("student back in the room", async () => await text_of(lab, "room_state") === "");
        await wait_for("same address after the hang", async () => await text_of(lab, "net") === address_before);
        await wait_for("tile alive after the hang", async () => teacher.evaluate(`!${TILE}.classList.contains('gone')`));
        await type_to_student(teacher, "echo after-hang");
        await wait_for("teacher input arrived after the hang", async () => tile_has(teacher, "after-hang"));
        console.log(`PASS hung handshake: the socket in CONNECTING was closed after ${seconds.toFixed(1)} s, a new attempt, "зв'язок втрачено" shown, the address did not change after recovery, teacher input arrives (TCP connections to the silent server ${silent.accepted()})`);
    } finally {
        await lab.evaluate("window.__hang = ''; true");
        silent.close();
    }
}

async function test_server_outage(servers, teacher, lab) {
    const address = () => text_of(lab, "net");
    const address_before = await address();
    const submits_before = await count_items(teacher, "submits");
    await servers.stop();
    await wait_for("student status line: connection lost", async () => (await text_of(lab, "room_state")).includes("зв'язок втрачено"));
    await wait_for("teacher status line: connection lost", async () => (await text_of(teacher, "room_state")).includes("зв'язок втрачено"));
    await lab.evaluate(`document.getElementById('submit').click()`);
    await wait_for("\"Не надіслано\" during the drop", async () => (await text_of(lab, "note")).includes("Не надіслано"));
    if((await text_of(lab, "note")).includes("Здано")) throw new Error("\"Здано\" shown without confirmation");
    console.log("PASS \"Здати\" without a connection: the student sees \"Не надіслано\", not \"Здано\"");
    await sleep(SERVER_DOWN_MS);
    servers.start();
    await wait_for("report arrived after recovery", async () => await count_items(teacher, "submits") === submits_before + 1);
    await wait_for("student sees \"Здано\" after confirmation", async () => await text_of(lab, "note") === "Здано");
    await wait_for("status lines are empty", async () => await text_of(lab, "room_state") === "" && await text_of(teacher, "room_state") === "");
    if(await count_items(teacher, "submits") !== submits_before + 1) throw new Error("submissions list: a duplicate after resending");
    await wait_for("same address after the restart", async () => await address() === address_before);
    await wait_for("tile alive after the server restart", async () => teacher.evaluate(`!${TILE}.classList.contains('gone')`));
    await type_to_student(teacher, "echo after-restart");
    await wait_for("teacher input arrived after the server restart", async () => tile_has(teacher, "after-restart"));
    console.log("PASS server restart: the queued report arrived, \"Здано\" after confirmation, the address", address_before, "did not change, teacher input arrives");
}

async function set_task_file(teacher, file) {
    const { root } = await teacher.send("DOM.getDocument");
    const { nodeId } = await teacher.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#task_file" });
    await teacher.send("DOM.setFileInputFiles", { nodeId, files: [file] });
}

// After following the task link, the tail of the #net line changes (internet: no → the default relay); the address
// stays.
function guest_address(net_line) {
    return /10\.0\.0\.\d+/.exec(net_line)?.[0] ?? null;
}

async function test_distribute(teacher, lab, scratch) {
    const journal = await lab.evaluate("window.machine.journal().then(j => JSON.stringify(j))");
    const file = join(scratch, "task.json");
    writeFileSync(file, journal);
    await set_task_file(teacher, file);
    await teacher.evaluate(`document.getElementById('task_send').click()`);
    await wait_for("teacher handed out the task", async () => (await text_of(teacher, "task_status")).startsWith("Роздано"));
    await wait_for("student sees the \"Почати\" button", async () => lab.evaluate(`document.querySelector('#task button')?.textContent === 'Почати'`));
    const address = guest_address(await text_of(lab, "net"));
    if(!address) throw new Error("the student's #net has no 10.0.0.N address before \"Почати\"");
    await lab.evaluate(`document.querySelector('#task button').click()`);
    await sleep(1000);
    await wait_for("task replayed, machine live", async () => ((await lab.evaluate(`location.search`)) ?? "").includes("task=") && await text_of(lab, "banner") === "Машина ваша");
    const search = await lab.evaluate(`location.search`);
    if(!search.includes("relay=off")) throw new Error(`"Почати" lost relay=off: ${search}`);
    await wait_for("same address after moving to the task", async () => guest_address(await text_of(lab, "net")) === address).catch(async error => {
        console.log("diagnostics:", JSON.stringify({ before: address, net: await text_of(lab, "net"), room: await text_of(lab, "room_state"), err: await text_of(lab, "err") }));
        throw error;
    });
    await wait_for("tile alive after \"Почати\"", async () => teacher.evaluate(`${TILE} !== undefined && !${TILE}.classList.contains('gone') && ${TILE_TEXT}.includes('${PROMPT}')`));
    console.log("PASS \"Роздати\" → \"Почати\": task replayed, the student is in the room with the same address", address);
}

async function test_rollback(teacher, lab) {
    await lab.evaluate(`window.machine.type("echo keep-mark\\n"); true`);
    await wait_for("keep-mark in the tile", async () => tile_has(teacher, "keep-mark"));
    await lab.evaluate(`window.machine.type("echo drop-mark\\n"); true`);
    await wait_for("drop-mark in the tile", async () => tile_has(teacher, "drop-mark"));
    await lab.evaluate(`window.confirm = () => true; true`);
    await wait_for("rollback button available", async () => lab.evaluate(`!document.getElementById('rollback').disabled`));
    await lab.evaluate(`document.getElementById('rollback').click()`);
    await wait_for("rollback list", async () => lab.evaluate(`[...document.querySelectorAll('#rollback_list li')].some(li => li.textContent.includes('echo drop-mark'))`));
    await lab.evaluate(`[...document.querySelectorAll('#rollback_list li')].find(li => li.textContent.includes('echo drop-mark')).click()`);
    await wait_for("rollback done", async () => (await text_of(lab, "note")).startsWith("Відкочено")).catch(async error => {
        console.log("diagnostics:", JSON.stringify({ note: await text_of(lab, "note"), err: await text_of(lab, "err"), banner: await text_of(lab, "banner"), room: await text_of(lab, "room_state"), rollback_disabled: await lab.evaluate(`document.getElementById('rollback').disabled`) }));
        throw error;
    });
    await wait_for("tile after the rollback without drop-mark", async () => teacher.evaluate(`${TILE_TEXT}.includes('keep-mark') && !${TILE_TEXT}.includes('drop-mark')`));
    console.log("PASS rollback in a room: the teacher tile shows the output before the rollback (keep-mark present, drop-mark gone)");
}

const guest_text = tab => tab.evaluate(`window.machine.log.map(e => new TextDecoder().decode(e.data)).join("")`);
const lease_count = async tab => ((await guest_text(tab)) ?? "").match(LEASE_RE)?.length ?? 0;

// A replay error ("розбіжність") lands in #err, and the rollback then never finishes: wait for either outcome.
async function wait_rollback_done(lab) {
    await wait_for("rollback done or replay error", async () => {
        const err = await text_of(lab, "err");
        if(err) throw new Error(`error after the rollback: ${err}`);
        return (await text_of(lab, "note")).startsWith("Відкочено");
    });
}

// A guest in a room with a relay that answers DHCP with unicast frames. The guest gets its MAC from a room command
// before
// the snapshot; the snapshot is taken before the second DHCP exchange; a rollback to a command after the exchange makes
// the DHCP frames repeat from the snapshot. Without preserve_mac_from_state_image the network card does not know the
// guest's MAC after a restore and drops unicast replies.
async function test_rollback_relay() {
    const relay = await start_dhcp_relay();
    const lab = await open_tab(`lab.html?room=${RELAY_ROOM}&name=${RELAY_STUDENT}&relay=ws://127.0.0.1:${relay.port}/`);
    try {
        // The first exchange goes over the system channel (its output is not in the student's console): the relay's ACK
        // shows it happened.
        await wait_for("guest got an address from the relay", async () => relay.stats.acks >= 1);
        const journal_length = () => lab.evaluate("window.machine.journal().then(j => j.events.length)");
        const first_exchange_end = await journal_length();
        const mac_command = await lab.evaluate(`window.machine.journal().then(j => j.events.findIndex(e => e.t === "serial" && e.p === 1 && atob(e.data.split(" ")[2] ?? "").includes("hw ether")))`);
        if(mac_command < 0 || mac_command >= first_exchange_end) throw new Error("no room command with the MAC before the first DHCP in the journal");
        await wait_for("snapshot after the first DHCP exchange", () => lab.evaluate(`window.machine.snapshots.some(s => s.next >= ${first_exchange_end})`));
        const exchanges_before = relay.stats.acks;
        await lab.evaluate(`window.machine.type(${JSON.stringify(DHCP_COMMAND + "\n")}); true`);
        await wait_for("second DHCP exchange", async () => relay.stats.acks > exchanges_before && await lease_count(lab) >= 1);
        if(relay.stats.unicast < 4) throw new Error(`the relay replayed ${relay.stats.unicast} unicast replies of the expected ≥ 4`);
        await lab.evaluate(`window.machine.type("echo keep-relay\\n"); true`);
        await wait_for("keep-relay in the guest output", async () => ((await guest_text(lab)) ?? "").split("keep-relay").length > 2);
        await lab.evaluate(`window.machine.type("echo drop-relay\\n"); true`);
        await wait_for("drop-relay in the guest output", async () => ((await guest_text(lab)) ?? "").split("drop-relay").length > 2);
        await lab.evaluate(`window.confirm = () => true; true`);
        await wait_for("rollback button available", async () => lab.evaluate(`!document.getElementById('rollback').disabled`));
        await lab.evaluate(`document.getElementById('rollback').click()`);
        await wait_for("rollback list", async () => lab.evaluate(`[...document.querySelectorAll('#rollback_list li')].some(li => li.textContent.includes('echo drop-relay'))`));
        await lab.evaluate(`[...document.querySelectorAll('#rollback_list li')].find(li => li.textContent.includes('echo drop-relay')).click()`);
        await wait_rollback_done(lab);
        await lab.evaluate(`window.machine.type("echo after-$((20+22))\\n"); true`);
        await wait_for("machine runs commands after the rollback", async () => ((await guest_text(lab)) ?? "").includes("after-42"));
        const acks_before = relay.stats.acks;
        await lab.evaluate(`window.machine.type(${JSON.stringify(DHCP_COMMAND + "\n")}); true`);
        await wait_for("DHCP after the rollback", async () => relay.stats.acks > acks_before);
        console.log(`PASS rollback with a relay: snapshot before DHCP, rollback after the unicast replies (OFFER ${relay.stats.offers}, ACK ${relay.stats.acks}, unicast ${relay.stats.unicast}) without "розбіжність", the command runs, DHCP works after the rollback`);
    } catch(error) {
        console.log("diagnostics:", JSON.stringify({ err: await text_of(lab, "err"), note: await text_of(lab, "note"), net: await text_of(lab, "net"), relay: relay.stats }));
        throw error;
    } finally {
        await lab.close();
        relay.close();
    }
}

async function main() {
    const scratch = mkdtempSync(join(tmpdir(), "teacher-cdp-"));
    const servers = {
        child: null,
        start() { this.child = spawn("node", [join(ROOT, "app", "server.mjs"), String(SERVER_PORT)], { stdio: "ignore" }); },
        async stop() {
            const old = this.child;
            old.kill();
            await new Promise(resolve => old.once("exit", resolve));
        },
    };
    servers.start();
    await sleep(1500);
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(scratch, "profile")}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        if(process.env.ONLY === "relay_rollback") return await test_rollback_relay();
        const teacher = await open_tab(`teacher.html?room=${ROOM}`);
        const lab = await open_tab(`lab.html?room=${ROOM}&name=${STUDENT}&relay=off`);
        // A new tab covers the teacher's one; xterm draws on requestAnimationFrame, which a hidden tab never gets.
        await teacher.activate();
        await wait_for("student tile with prompt", async () => teacher.evaluate(`${TILE} !== undefined && ${TILE_TEXT}.includes('${PROMPT}')`));
        console.log("PASS ivan tile with the shell prompt");
        if(process.env.ONLY === "rollback") return await test_rollback(teacher, lab);
        if(process.env.ONLY === "silent") return await test_silent_drop(teacher, lab);
        if(process.env.ONLY === "connect") return await test_connect_timeout(teacher, lab);
        await teacher.evaluate(`${TILE}.click()`);
        await type_line(teacher, `echo ${MARKER}`);
        await wait_for("marker in tile output", async () => teacher.evaluate(`${TILE_TEXT}.split('${MARKER}').length > 2`));
        console.log(`PASS appeared in the tile buffer ${MARKER}`);
        const link_ready = list => async () => (await item_link(teacher, list))?.includes(PLAYER_LINK) ?? false;
        const count = list => count_items(teacher, list);
        await lab.evaluate(`document.getElementById('problem').click()`);
        await wait_for("ivan in #reports with a link to the player", link_ready("reports"));
        console.log("PASS \"У мене не працює\": ivan in #reports, link to player.html?j=");
        const reports_before = await count("reports");
        await lab.evaluate(`document.getElementById('submit').click()`);
        await wait_for("ivan in #submits", link_ready("submits"));
        const reports_after = await count("reports");
        if(reports_after !== reports_before) throw new Error(`#reports grew: ${reports_before} → ${reports_after}`);
        console.log("PASS \"Здати\": ivan in #submits, #reports did not grow");
        for(const list of ["reports", "submits"]) await check_journal(await item_link(teacher, list));
        await test_reload(teacher, { reports: await count_items(teacher, "reports"), submits: await count_items(teacher, "submits") });
        await test_student_drop(teacher, lab);
        await test_silent_drop(teacher, lab);
        await test_connect_timeout(teacher, lab);
        await test_server_outage(servers, teacher, lab);
        await test_distribute(teacher, lab, scratch);
        await test_rollback(teacher, lab);
        await test_rollback_relay();
    }
    finally {
        await close_browser(chrome, CDP_PORT);
        servers.child.kill();
        await remove_profile(scratch);
    }
}

main().catch(error => {
    console.error("FAIL", error.message);
    process.exitCode = 1;
});
