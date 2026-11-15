// "Здати" in the middle of an active TCP transfer between two machines: on one network pc1 sends srv a file with nc,
// and
// halfway through the transfer a set of journals is taken (save_topology_journals, the same as the "Зберегти завдання"
// button). Two tabs are checked: the one where the set was taken (the transfer finishes after pause and resume) and a
// new tab that replays the set and goes live (the file on srv matches the sent one in size and md5, the TCP
// connection is not reset).
// Starts node app/server.mjs and headless Chromium (CDP). Run one at a time.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8117);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9347);
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const WAIT_MS = Number(process.env.WAIT_MS ?? 600000);
const FILE_KB = Number(process.env.FILE_KB ?? 3072);
const CHUNK_KB = 32;
const CHUNK_PAUSE_S = process.env.CHUNK_PAUSE_S ?? "0.1";
const POLL_MS = 500;
const SAVE_FROM = 0.25;
const SAVE_TO = 0.7;
const PORT = 5000;
const JOURNAL_DIR = join(ROOT, "app", "data", "journals");

const TOPOLOGY = {
    format: "v86-topology/1",
    title: "Два хости в одній мережі",
    machines: [
        { id: "pc1", profile: "net", setup: "ifconfig eth0 hw ether {mac} 10.0.10.2 netmask 255.255.255.0 up\n" },
        { id: "srv", profile: "net", setup: "ifconfig eth0 hw ether {mac} 10.0.10.3 netmask 255.255.255.0 up\n" },
    ],
    switches: [{ id: "sw1" }],
    links: [
        { machine: "pc1", switch: "sw1", mode: "access", vlan: 10 },
        { machine: "srv", switch: "sw1", mode: "access", vlan: 10 },
    ],
};
const MACHINE_IDS = TOPOLOGY.machines.map(machine => machine.id);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label) {
    const deadline = Date.now() + WAIT_MS;
    while(Date.now() < deadline) {
        const value = await check();
        if(value) return value;
        await sleep(POLL_MS);
    }
    throw new Error(`timeout: ${label}`);
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
        pending.get(message.id)?.(message);
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
        close: () => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`),
        evaluate: async expression => {
            const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
            return reply.result.result.value;
        },
    };
}

const machine_of = id => `window.topology.machines.get(${JSON.stringify(id)})`;
const text_of = id => `${machine_of(id)}.log.map(e => new TextDecoder().decode(e.data)).join("")`;

// Types a command into the machine and waits until a reply matching the pattern appears (new output only).
async function run(tab, id, command, pattern, label) {
    const offset = (await tab.evaluate(text_of(id))).length;
    await tab.evaluate(`${machine_of(id)}.type(${JSON.stringify(command + "\n")}); true`);
    return waitFor(async () => {
        const fresh = (await tab.evaluate(text_of(id))).slice(offset);
        return pattern.exec(fresh);
    }, label ?? `${id}: ${command}`);
}

function expect(actual, expected, label) {
    if(actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function setup_done(tab) {
    await waitFor(() => tab.evaluate(`window.topology?.ready !== undefined && window.topology.machines.size === ${MACHINE_IDS.length}`), "topology created");
    await tab.evaluate("window.topology.ready.then(() => true)");
    for(const id of MACHINE_IDS) await run(tab, id, "echo SETUP_$((1+1))", /\nSETUP_2\r/, `${id}: setup finished`);
}

// How many bytes srv has already written to the receiver's file.
async function received(tab) {
    return Number((await run(tab, "srv", "echo RX=$(wc -c < /tmp/rx)", /\nRX=(\d+)\r/, "srv: size of /tmp/rx"))[1]);
}

// The guest's TCP counters from /proc/net/snmp: {RetransSegs, EstabResets, ...}.
async function tcp_counters(tab, id) {
    const match = await run(tab, id, "echo SNMP; grep '^Tcp:' /proc/net/snmp; echo SNMP_END", /\nSNMP\r\n(Tcp:[^\n]*\n)(Tcp:[^\n]*\n)SNMP_END/, `${id}: /proc/net/snmp`);
    const names = match[1].trim().split(/\s+/).slice(1);
    const values = match[2].trim().split(/\s+/).slice(1).map(Number);
    return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

async function post_json(body) {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/journals`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    return (await response.json()).id;
}

// Waits until srv gets the whole file and compares size and md5 with the sent one. Returns the timeline (ms from start,
// bytes).
async function finish_transfer(tab, sent, label) {
    const started = Date.now();
    const timeline = [];
    let size = 0;
    while(size < sent.bytes) {
        size = await received(tab);
        timeline.push([Date.now() - started, size]);
        if(Date.now() - started > WAIT_MS) throw new Error(`timeout: ${label}: the receiver stopped at ${size} з ${sent.bytes}`);
    }
    const sum = (await run(tab, "srv", "echo SUM=$(md5sum < /tmp/rx)", /\nSUM=([0-9a-f]{32})/, "srv: md5"))[1];
    expect(size, sent.bytes, `${label}: file size on srv`);
    expect(sum, sent.md5, `${label}: file md5 on srv`);
    return timeline;
}

// Teacher: the server listens, the client sends a file in the background; halfway through the transfer the set of
// journals is taken.
async function teacher(topology_id) {
    const tab = await open_tab(`topology.html?topology_url=/journals/${topology_id}`);
    await setup_done(tab);
    await run(tab, "pc1", `dd if=/dev/urandom of=/tmp/tx bs=1024 count=${FILE_KB} 2>/dev/null; echo TX=$(md5sum < /tmp/tx)`, /\nTX=([0-9a-f]{32})/, "pc1: file created")
        .then(match => { sent.md5 = match[1]; });
    sent.bytes = FILE_KB * 1024;
    await run(tab, "srv", `sleep 3600 | nc -l -p ${PORT} > /tmp/rx & sleep 1; echo LISTEN`, /\nLISTEN\r/, "srv: nc is listening");
    const before = await tcp_counters(tab, "pc1");
    await run(tab, "pc1", `(i=0; while [ $i -lt ${FILE_KB / CHUNK_KB} ]; do dd if=/tmp/tx bs=${CHUNK_KB * 1024} skip=$i count=1 2>/dev/null; i=$((i+1)); sleep ${CHUNK_PAUSE_S}; done) | nc 10.0.10.3 ${PORT} & sleep 1; echo SENDING`, /\nSENDING\r/, "pc1: transfer started");
    console.log(`1 OK teacher: file ${sent.bytes} bytes, md5 ${sent.md5}, transfer started`);

    let at_save = 0;
    const started = Date.now();
    while(at_save < sent.bytes * SAVE_FROM) {
        at_save = await received(tab);
        if(Date.now() - started > WAIT_MS) throw new Error(`timeout: the receiver stopped at ${at_save} з ${sent.bytes}`);
        if(at_save > sent.bytes * SAVE_TO) throw new Error(`the transfer went too fast: before the journals were taken there were already ${at_save} з ${sent.bytes}`);
    }
    const saved_at = Date.now();
    const task = await tab.evaluate(`import("/app/net/topology_journals.mjs")
        .then(m => m.save_topology_journals(window.topology.desc, window.topology.machines))
        .then(desc => JSON.stringify(desc))`);
    console.log(`2 OK teacher: the set of journals taken in ${Date.now() - saved_at} ms, the receiver had ≥ ${at_save} з ${sent.bytes} bytes (${Math.round(100 * at_save / sent.bytes)} %)`);
    const parsed = JSON.parse(task);
    for(const id of MACHINE_IDS) {
        const events = parsed.journals[id].events;
        console.log(`  журнал ${id}: ${events.length} подій, ${events.filter(event => event.t === "check").length} check, ${events.filter(event => event.t === "net").length} net`);
    }
    const timeline = await finish_transfer(tab, sent, "the tab where the journals were taken");
    const after = await tcp_counters(tab, "pc1");
    console.log(`3 OK teacher: after the journals were taken the transfer finished, size and md5 match (${timeline.length} polls; RetransSegs pc1: ${before.RetransSegs} -> ${after.RetransSegs}, EstabResets ${before.EstabResets} -> ${after.EstabResets})`);
    await tab.close();
    return task;
}

// Student: a new tab replays the journals of both machines, both go live, the transfer finishes.
async function student(task_id) {
    const tab = await open_tab(`topology.html?topology_url=/journals/${task_id}`);
    await waitFor(() => tab.evaluate("window.topology?.ready !== undefined"), "topology created");
    await waitFor(() => tab.evaluate(`window.topology.phase === "live" || document.getElementById("err").textContent !== ""`), "end of journal replay");
    const err = await tab.evaluate(`document.getElementById("err").textContent`);
    if(err) throw new Error(`student: ${err}`);
    await waitFor(() => tab.evaluate(`[...window.topology.machines.values()].every(m => m.live && m.status.mode === "live")`), "status live on all machines");
    const live_at = Date.now();
    const at_live = await received(tab);
    console.log(`4 OK student: journals replayed without divergence, both machines live; the receiver after the replay has ${at_live} з ${sent.bytes} bytes`);
    if(at_live <= 0 || at_live >= sent.bytes) throw new Error(`at the moment of the switch the transfer must be in the middle, and the receiver has ${at_live} з ${sent.bytes}`);
    const before = await tcp_counters(tab, "pc1");
    const timeline = await finish_transfer(tab, sent, "new tab");
    const after = await tcp_counters(tab, "pc1");
    console.log(`5 OK student: the file arrived intact in ${Date.now() - live_at} ms after the switch (size ${sent.bytes}, md5 ${sent.md5}); RetransSegs pc1: ${before.RetransSegs} -> ${after.RetransSegs}, EstabResets ${before.EstabResets} -> ${after.EstabResets}`);
    expect(after.EstabResets, before.EstabResets, "student: EstabResets (connections not reset)");
    await tab.close();
}

const sent = { bytes: 0, md5: "" };

async function main() {
    const server = spawn("node", [join(ROOT, "app", "server.mjs"), String(SERVER_PORT)], { stdio: "ignore" });
    const profile = mkdtempSync(join(tmpdir(), "topology-tcp-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    const posted = [];
    try {
        await sleep(2000);
        posted.push(await post_json(TOPOLOGY));
        const task = await teacher(posted[0]);
        posted.push(await post_json(task));
        await student(posted[1]);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.kill();
        await remove_profile(profile);
        for(const id of posted) rmSync(join(JOURNAL_DIR, `${id}.json`), { force: true });
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
