// Browser check of a topology in a room: a student with two machines in one room, "student / machine" tiles at
// the teacher, teacher input into the chosen machine, per-machine reports sharing a group, "Роздати" of a topology
// description and "Почати" from the topology page and from lab.html.
// Starts node app/server.mjs and headless Chromium (CDP). Run one at a time.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8099);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const ROOM = "t11";
const STUDENT = "ivan";
const LAB_STUDENT = "olga";
const MACHINES = ["pc1", "pc2"];
const MARKER = "teacher-typed-here";
const PROMPT = "~% ";
const PLAYER_LINK = "player.html?j=";
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 500;
const ENTER_KEY_CODE = 13;

const TOPOLOGY = {
    format: "v86-topology/1",
    title: "Дві машини в одній мережі",
    machines: MACHINES.map(id => ({ id, profile: "net" })),
    switches: [{ id: "sw1" }],
    links: MACHINES.map(machine => ({ machine, switch: "sw1", mode: "access", vlan: 10 })),
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, check) {
    const deadline = Date.now() + WAIT_MS;
    while(Date.now() < deadline) {
        if(await check()) return;
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}`);
}

function expect(actual, expected, label) {
    if(JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

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
    await send("Page.navigate", { url: BASE + path });
    return {
        send,
        close: () => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`),
        activate: () => fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${target.id}`),
        evaluate: async expression => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value,
    };
}

// A second teacher without a UI: sees the protocol as the server sends it (machines, machine, group).
async function open_observer() {
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
    const seen = [];
    ws.onmessage = event => seen.push(JSON.parse(event.data));
    await new Promise(resolve => { ws.onopen = resolve; });
    ws.send(JSON.stringify({ type: "join", room: ROOM, role: "teacher", name: "observer" }));
    await wait_for("observer joined", () => seen.some(message => message.type === "joined"));
    return { seen, close: () => ws.close() };
}

async function post_json(body) {
    const reply = await fetch(`http://127.0.0.1:${SERVER_PORT}/journals`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return (await reply.json()).id;
}

async function type_line(tab, text) {
    await tab.send("Input.insertText", { text });
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE, text: "\r" };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: ENTER_KEY_CODE });
}

// Teacher tile: with a machine the label is "student / machine", without one it is just the name.
const tile_of = (name, machine) => `[...document.querySelectorAll('.tile')].find(t => {
    const label = t.querySelector('.label').textContent;
    return ${machine ? `label.startsWith('${name} / ${machine}')` : `label.startsWith('${name}') && !label.includes(' / ')`};
})`;
const tile_text = (name, machine) => `(${tile_of(name, machine)}?.querySelector('.xterm-rows')?.innerText ?? '')`;
const machine_log = id => `window.topology.machines.get('${id}').log.map(e => new TextDecoder().decode(e.data)).join('')`;
const items_of = (tab, list) => tab.evaluate(`[...document.querySelectorAll('#${list} li')].map(li => ({
    text: li.querySelector('a').textContent, href: li.querySelector('a').getAttribute('href'),
    machine: li.dataset.machine ?? null, group: li.dataset.group ?? null }))`);

async function wait_machines_ready(tab, label) {
    await wait_for(`${label}: machines created`, () => tab.evaluate(`window.topology?.ready !== undefined && window.topology.machines.size === ${MACHINES.length}`));
    await tab.evaluate("window.topology.ready.then(() => true)");
}

async function wait_prompts(teacher, name) {
    for(const machine of MACHINES) {
        await wait_for(`tile ${name} / ${machine} with the prompt`, () => teacher.evaluate(`${tile_text(name, machine)}.includes('${PROMPT}')`));
    }
}

function check_group(items, label) {
    expect(items.map(item => item.machine).sort(), MACHINES, `${label}: report machines`);
    if(!items[0].group || items[0].group !== items[1].group) throw new Error(`${label}: group does not match: ${items.map(item => item.group)}`);
    return items[0].group;
}

async function check_reports(teacher, observer, list, kind) {
    await wait_for(`${list}: ${MACHINES.length} reports with a shared group`, async () => (await items_of(teacher, list)).length >= MACHINES.length);
    const items = (await items_of(teacher, list)).slice(0, MACHINES.length);
    for(const item of items) {
        if(!item.text.startsWith(`${STUDENT} / ${item.machine},`) || !item.href.includes(PLAYER_LINK)) throw new Error(`#${list}: label or link: ${JSON.stringify(item)}`);
        const journal = await (await fetch(`http://127.0.0.1:${SERVER_PORT}${new URL(item.href, BASE).searchParams.get("j")}`)).json();
        if(!journal.events?.length) throw new Error(`#${list}: журнал ${item.machine} порожній`);
    }
    const group = check_group(items, `#${list}`);
    const raw = observer.seen.filter(message => message.type === "report" && message.kind === kind);
    expect(raw.map(message => message.machine).sort(), MACHINES, `${kind}: report for the observer`);
    expect(new Set(raw.map(message => message.group)).size, 1, `${kind}: group in the protocol`);
    return group;
}

async function test_bad_url() {
    const tab = await open_tab(`topology.html?topology_url=${encodeURIComponent("http://127.0.0.1:1/journals/abc")}&room=${ROOM}&name=bad`);
    await wait_for("a foreign topology_url address was rejected", async () => (await tab.evaluate("document.getElementById('err').textContent")).includes("topology_url"));
    await tab.close();
    console.log("PASS topology_url with a foreign address rejected");
}

async function test_input_and_machines(teacher, student, observer) {
    const joined = observer.seen.find(message => message.type === "joined");
    expect(joined.peers.find(peer => peer.name === STUDENT)?.machines, MACHINES, "joined.peers[].machines");
    console.log("PASS the server sent machines in joined.peers");
    await wait_prompts(teacher, STUDENT);
    // An observer joining wakes the student: it sends the full output history of each machine with the machine field.
    await wait_for("serial with machine in the protocol", () => MACHINES.every(id => observer.seen.some(message => message.type === "serial" && message.machine === id)));
    console.log("PASS tiles ivan / pc1 and ivan / pc2 with the prompt, serial arrives with machine");
    await teacher.evaluate(`${tile_of(STUDENT, "pc2")}.click(); true`);
    await sleep(300);
    await type_line(teacher, `echo ${MARKER}`);
    await wait_for("teacher input into pc2", async () => (await student.evaluate(machine_log("pc2"))).includes(`echo ${MARKER}`));
    await wait_for("pc2 output in the pc2 tile", () => teacher.evaluate(`${tile_text(STUDENT, "pc2")}.split('${MARKER}').length > 2`));
    if((await student.evaluate(machine_log("pc1"))).includes(MARKER)) throw new Error("teacher input went into pc1");
    if((await teacher.evaluate(tile_text(STUDENT, "pc1"))).includes(MARKER)) throw new Error("the pc1 tile shows input meant for pc2");
    console.log("PASS teacher input went only into pc2");
    await teacher.evaluate("document.getElementById('big_close').click(); true");
}

async function test_problem_report(teacher, student, observer) {
    await student.evaluate("document.getElementById('problem').click(); true");
    const group = await check_reports(teacher, observer, "reports", "problem");
    console.log("PASS \"У мене не працює\": one report per machine with a shared group", group);
    return group;
}

async function test_distribute_and_submit(teacher, student, observer, scratch, problem_group) {
    const file = join(scratch, "topology.json");
    writeFileSync(file, JSON.stringify(TOPOLOGY));
    const { root } = await teacher.send("DOM.getDocument");
    const { nodeId } = await teacher.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#task_file" });
    await teacher.send("DOM.setFileInputFiles", { nodeId, files: [file] });
    await teacher.evaluate("document.getElementById('task_send').click(); true");
    await wait_for("teacher handed out the description", async () => (await teacher.evaluate("document.getElementById('task_status').textContent")).startsWith("Роздано"));
    await wait_for("student sees \"Почати\"", () => student.evaluate("document.querySelector('#task button')?.textContent === 'Почати'"));
    await student.evaluate("document.querySelector('#task button').click(); true");
    // The initial address has topology_url with plain slashes, the "Почати" address has them encoded.
    await wait_for("\"Почати\" opened the topology by topology_url", () => student.evaluate("location.search.includes('topology_url=%2Fjournals%2F')"));
    const search = await student.evaluate("location.search");
    if(!search.includes("relay=off")) throw new Error(`"Почати" lost relay=off: ${search}`);
    await wait_machines_ready(student, "after \"Почати\"");
    await wait_prompts(teacher, STUDENT);
    console.log("PASS \"Роздати\" → \"Почати\": machines started from the handed-out description, tiles in place");
    await student.evaluate("document.getElementById('submit').click(); true");
    const group = await check_reports(teacher, observer, "submits", "submit");
    if(group === problem_group) throw new Error("\"Здати\" reused the group of the previous report");
    console.log("PASS \"Здати\": one report per machine with a shared group different from the previous one", group);
}

// A student in lab.html (one machine) receives a topology description: "Почати" takes them to the topology page,
// and the teacher's tile without a machine is replaced by per-machine tiles.
async function test_start_from_lab(teacher) {
    const lab = await open_tab(`lab.html?room=${ROOM}&name=${LAB_STUDENT}&relay=off`);
    // xterm does not redraw a tile if output came while the teacher's tab was hidden (lab has just covered it).
    // So the teacher tab is brought to the front, and lab is asked for a fresh line of output while the teacher is
    // visible.
    await wait_for("olga tile with the prompt", async () => {
        await teacher.activate();
        await lab.evaluate(`window.machine?.type("\\n", "system"); true`);
        return teacher.evaluate(`${tile_text(LAB_STUDENT)}.includes('${PROMPT}')`);
    });
    await wait_for("lab sees \"Почати\"", () => lab.evaluate("document.querySelector('#task button')?.textContent === 'Почати'"));
    await lab.evaluate("document.querySelector('#task button').click(); true");
    await wait_machines_ready(lab, "olga");
    await wait_prompts(teacher, LAB_STUDENT);
    if(await teacher.evaluate(`${tile_of(LAB_STUDENT)} !== undefined`)) throw new Error("the olga tile without a machine stayed after moving to the topology");
    await lab.close();
    console.log("PASS lab.html → \"Почати\" → topology page: the olga tile replaced by the olga / pc1 and olga / pc2 tiles");
}

async function main() {
    const scratch = mkdtempSync(join(tmpdir(), "topology-room-cdp-"));
    const server = spawn("node", [join(ROOT, "app", "server.mjs"), String(SERVER_PORT)], { stdio: "ignore" });
    await sleep(1500);
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(scratch, "profile")}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        await test_bad_url();
        const topology_id = await post_json(TOPOLOGY);
        const teacher = await open_tab(`teacher.html?room=${ROOM}`);
        const student = await open_tab(`topology.html?topology_url=/journals/${topology_id}&room=${ROOM}&name=${STUDENT}&relay=off`);
        // A new tab covers the teacher's tab, and xterm draws only in a visible one.
        await teacher.activate();
        await wait_machines_ready(student, STUDENT);
        const observer = await open_observer();
        await test_input_and_machines(teacher, student, observer);
        const problem_group = await test_problem_report(teacher, student, observer);
        await test_distribute_and_submit(teacher, student, observer, scratch, problem_group);
        observer.close();
        await test_start_from_lab(teacher);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.kill();
        await remove_profile(scratch);
    }
}

main().catch(error => {
    console.error("FAIL", error.message);
    process.exitCode = 1;
});
