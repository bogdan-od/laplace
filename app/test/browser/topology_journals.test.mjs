// Browser check of a topology from a set of journals: the teacher sets up router-on-a-stick, breaks the VLAN on the
// router and saves the journals of all machines in one call; the student opens the resulting task (via POST /journals,
// as after "Роздати"), the journals replay without divergence, in live mode ping fails, the student fixes the VLAN.
// Starts node app/server.mjs and headless Chromium (CDP). Run one at a time.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8098);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 500;
const PING_OK = /(\d+) (?:packets )?received/;
const MACHINE_IDS = ["pc1", "srv", "r1"];
const PROMPT = /~% $/;
const FIX_VLAN = id => `ip link del eth0.20; ip link add link eth0 name eth0.20 type vlan id ${id}; ip addr add 10.0.20.1/24 dev eth0.20; ip link set eth0.20 up`;

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

async function ping(tab, from, target, label) {
    const match = await run(tab, from, `ping -c 2 -W 3 ${target}`, PING_OK, label);
    return Number(match[1]);
}

function expect(actual, expected, label) {
    if(actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function setup_done(tab) {
    await waitFor(() => tab.evaluate("window.topology?.ready !== undefined && window.topology.machines.size === 3"), "topology created");
    await tab.evaluate("window.topology.ready.then(() => true)");
    for(const id of MACHINE_IDS) await run(tab, id, "echo SETUP_$((1+1))", /\nSETUP_2\r/, `${id}: setup finished`);
}

// Teacher: a configured topology, a broken VLAN, the journals of all machines in one call.
async function teacher_task() {
    const tab = await open_tab("topology.html?topology=router-on-a-stick");
    await setup_done(tab);
    expect(await ping(tab, "pc1", "10.0.20.2", "ping before the breakage"), 2, "ping pc1 -> srv before the breakage");
    console.log("1 OK teacher: pc1 pings srv through the router");
    await run(tab, "r1", FIX_VLAN(99), PROMPT, "VLAN broken on r1");
    expect(await ping(tab, "pc1", "10.0.20.2", "ping after the breakage"), 0, "ping pc1 -> srv after the breakage");
    console.log("2 OK teacher: with VLAN 99 on eth0.20 ping fails");
    const task = await tab.evaluate(`import("/app/net/topology_journals.mjs")
        .then(m => m.save_topology_journals(window.topology.desc, window.topology.machines))
        .then(desc => JSON.stringify(desc))`);
    await tab.close();
    const parsed = JSON.parse(task);
    for(const id of MACHINE_IDS) {
        const events = parsed.journals[id].events;
        const checks = events.filter(event => event.t === "check").length;
        if(checks === 0) throw new Error(`${id}: no check in the journal`);
        console.log(`3 OK journal ${id}: ${events.length} подій, ${checks} check, ${events.filter(event => event.t === "net").length} net`);
    }
    return { task, parsed };
}

async function post_task(task) {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/journals`, { method: "POST", body: task });
    return (await response.json()).id;
}

// Student: all journals replay, in live mode ping fails, after the VLAN fix it passes.
async function student(task_id, parsed) {
    const tab = await open_tab(`topology.html?topology_url=/journals/${task_id}`);
    await waitFor(() => tab.evaluate("window.topology?.ready !== undefined"), "topology created");
    await waitFor(() => tab.evaluate(`window.topology.phase === "live" || document.getElementById("err").textContent !== ""`), "end of journal replay");
    const err = await tab.evaluate(`document.getElementById("err").textContent`);
    if(err) throw new Error(`student: ${err}`);
    expect(await tab.evaluate(`document.getElementById("phase").textContent`), "живий режим", "status line");
    // The Worker sends a status every 100 ms, so right after go_live it may still show replay.
    await waitFor(() => tab.evaluate(`[...window.topology.machines.values()].every(m => m.live && m.status.mode === "live")`), "status live on all machines");
    const state = await tab.evaluate(`Promise.all([...window.topology.machines].map(async ([id, m]) => {
        const events = (await m.journal()).events;
        return { id, mode: m.status.mode, live_from: m.live_from, replay_net: events.slice(0, m.live_from).filter(e => e.t === "net").length };
    })).then(list => JSON.stringify(list))`);
    for(const item of JSON.parse(state)) {
        const source = parsed.journals[item.id].events;
        expect(item.mode, "live", `${item.id}: режим`);
        expect(item.live_from, source.length, `${item.id}: events at the moment of the switch`);
        expect(item.replay_net, source.filter(event => event.t === "net").length, `${item.id}: net events during replay`);
    }
    console.log("4 OK student: all machines replayed their journals without divergence and are live; no more net events during replay than in the journals");

    expect(await ping(tab, "pc1", "10.0.20.2", "ping in the broken topology"), 0, "ping after going live");
    console.log("5 OK student: the broken state is restored, pc1 does not ping srv");
    await run(tab, "r1", FIX_VLAN(20), PROMPT, "VLAN fixed on r1");
    expect(await ping(tab, "pc1", "10.0.20.2", "ping after the fix"), 2, "ping after the VLAN fix");
    console.log("6 OK the student fixed the VLAN, ping passes");
    await tab.close();
}

async function main() {
    const server = spawn("node", [join(ROOT, "app", "server.mjs"), String(SERVER_PORT)], { stdio: "ignore" });
    const profile = mkdtempSync(join(tmpdir(), "topology-journals-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await sleep(2000);
        const { task, parsed } = await teacher_task();
        await student(await post_task(task), parsed);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.kill();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
