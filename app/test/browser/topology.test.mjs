// Browser check of the router-on-a-stick topology: the client in VLAN 10, the server in VLAN 20, the router on a trunk.
// Starts node app/server.mjs and headless Chromium (CDP). Run one at a time.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";
import { start_dhcp_relay } from "./fake_dhcp_relay.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8097);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335);
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 500;
const SNAPSHOT_SETTLE_MS = 20000;
const PING_OK = /(\d+) (?:packets )?received/;
const MACHINE_IDS = ["pc1", "srv", "r1"];

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

async function test_topology() {
    const started = Date.now();
    const tab = await open_tab("topology.html?topology=router-on-a-stick");
    await waitFor(() => tab.evaluate("window.topology?.ready !== undefined && window.topology.machines.size === 3"), "topology created");
    await tab.evaluate("window.topology.ready.then(() => true)");
    for(const id of MACHINE_IDS) await run(tab, id, "echo SETUP_$((1+1))", /\nSETUP_2\r/, `${id}: setup finished`);
    console.log(`1 OK three machines set up in ${((Date.now() - started) / 1000).toFixed(1)} с від відкриття сторінки`);

    expect(await ping(tab, "pc1", "10.0.20.2", "ping through the router"), 2, "ping pc1 -> srv through the router");
    console.log("2 OK pc1 pings srv through the router, 2 packets received");

    // A full frame with a VLAN tag is 1518 bytes: check that the guest's ne2k accepts it.
    expect(await ping(tab, "pc1", "-s 1472 10.0.20.2", "large ping through the router"), 2, "1472-byte ping through the router");
    console.log("2b OK ping -s 1472 (1518-byte tagged frames) passes");

    await run(tab, "pc1", "ifconfig eth0:1 10.0.20.99 netmask 255.255.255.0 up", /~% $/, "VLAN 20 alias on pc1");
    expect(await ping(tab, "pc1", "10.0.20.2", "direct ping between VLANs"), 0, "directly between VLANs");
    await run(tab, "pc1", "ifconfig eth0:1 down", /~% $/, "alias removed");
    console.log("3 OK frames do not go directly between VLANs (an address from the VLAN 20 network on pc1 does not see srv)");

    await run(tab, "r1", "echo 0 > /proc/sys/net/ipv4/ip_forward", /~% $/, "ip_forward=0");
    expect(await ping(tab, "pc1", "10.0.20.2", "ping without forwarding"), 0, "without ip_forward");
    await run(tab, "r1", "echo 1 > /proc/sys/net/ipv4/ip_forward", /~% $/, "ip_forward=1");
    expect(await ping(tab, "pc1", "10.0.20.2", "ping with forwarding"), 2, "with ip_forward again");
    console.log("4 OK without forwarding on the router ping fails, with forwarding it passes");

    await sleep(SNAPSHOT_SETTLE_MS);
    const snaps = await tab.evaluate(`[...window.topology.machines.values()].map(m => m.snaps.length).join("/")`);
    console.log("snapshots of pc1/srv/r1 before the rollback:", snaps);
    const index = await tab.evaluate(`${machine_of("r1")}.journal().then(j => j.events.length)`);
    await run(tab, "r1", "echo after-rollback-marker", /\nafter-rollback-marker\r/, "command after the rollback point");
    await tab.evaluate(`${machine_of("r1")}.rollback(${index}).then(() => true)`);
    expect(await ping(tab, "pc1", "10.0.20.2", "ping after the router rollback"), 2, "ping after the r1 rollback");
    console.log("5 OK rollback of r1 to index", index, "ping through the router works");

    const journal = await tab.evaluate(`${machine_of("r1")}.journal().then(j => JSON.stringify(j))`);
    const dir = mkdtempSync(join(tmpdir(), "topology-journal-"));
    const file = join(dir, "r1.json");
    writeFileSync(file, journal);
    const replay = spawnSync("node", [join(ROOT, "app/test/engine.node.mjs"), "replay", file, join(ROOT, "images/net-boot.snap")], { encoding: "utf8" });
    const summary = replay.stdout.trim().split("\n").at(-1);
    if(replay.status !== 0 || !summary.includes('"ok":true')) throw new Error(`replay of the r1 journal in Node: ${summary || replay.stderr}`);
    console.log("6 OK r1 journal replayed in Node:", summary.slice(0, 120));
    await tab.close();
}

// Opens the topology with an uplink and a fake DHCP relay, waits for the lease on eth0.30 in r1 and runs the check.
async function with_uplink(topology, machine_count, check) {
    const relay = await start_dhcp_relay();
    try {
        const tab = await open_tab(`topology.html?topology=${topology}&relay=ws://127.0.0.1:${relay.port}/`);
        await waitFor(() => tab.evaluate(`window.topology?.ready !== undefined && window.topology.machines.size === ${machine_count}`), "topology with uplink created");
        await waitFor(() => tab.evaluate(`document.getElementById("uplink").textContent.startsWith("інтернет: 127.0.0.1")`), "relay connected");
        await tab.evaluate("window.topology.ready.then(() => true)");
        // Setup goes over the system channel: its output does not reach the console, so the lease shows as the
        // interface address.
        await waitFor(async () => /inet addr:\d+\.\d+\.\d+\.\d+/.test(await tab.evaluate(`${machine_of("r1")}.system("ifconfig eth0.30").then(r => r.output)`)), "DHCP lease on eth0.30");
        await check(tab, relay);
        await tab.close();
    } finally {
        relay.close();
    }
}

// The router on the trunk and the uplink in VLAN 30: the fake relay's DHCP replies reach the router through the switch
// tagged 30, and the router's frames leave untagged.
async function test_uplink() {
    await with_uplink("router-uplink", 2, async (tab, relay) => {
        const tagged = relay.frames.filter(frame => frame.readUInt16BE(12) === 0x8100);
        if(tagged.length > 0) throw new Error(`the relay got ${tagged.length} frames with a VLAN tag`);
        if(relay.stats.acks < 1) throw new Error("the relay did not replay ACK");
        const addr = await run(tab, "r1", "ip -br addr show eth0.30", /eth0\.30@eth0\s+UP\s+(\d+\.\d+\.\d+\.\d+)\/\d+/, "eth0.30 address");
        console.log(`7 OK uplink: r1 got a DHCP lease ${addr[1]} on eth0.30 through VLAN 30 (OFFER ${relay.stats.offers}, ACK ${relay.stats.acks}), untagged frames to the relay`);
    });
}

// NAT on the router: a client packet going out hits the MASQUERADE rule (the rule counter grows).
async function test_nat() {
    await with_uplink("router-nat", 2, async tab => {
        const masquerade_count = async () => Number((await run(tab, "r1", "iptables -t nat -vnL POSTROUTING", /\n\s*(\d+)\s+\d+\s+MASQUERADE/, "MASQUERADE counter"))[1]);
        // The fake DHCP hands out gateway 10.5.0.1 outside the lease subnet 10.5.7.0/24, so the default route is added
        // by hand.
        await run(tab, "r1", "ip route add default dev eth0.30; echo ROUTE_$((1+1))", /\nROUTE_2\r/, "маршрут за замовчуванням");
        const before = await masquerade_count();
        await ping(tab, "pc1", "93.184.216.34", "ping outside (no reply expected)");
        const after = await masquerade_count();
        if(after <= before) throw new Error(`MASQUERADE counter did not grow: ${before} -> ${after}`);
        console.log(`8 OK NAT: pc1 packets going out passed MASQUERADE (counter ${before} -> ${after})`);
    });
}

async function main() {
    const server = spawn("node", [join(ROOT, "app", "server.mjs"), String(SERVER_PORT)], { stdio: "ignore" });
    const profile = mkdtempSync(join(tmpdir(), "topology-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await sleep(2000);
        await test_topology();
        await test_uplink();
        await test_nat();
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.kill();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
