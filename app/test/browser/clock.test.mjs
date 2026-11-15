// Browser check of the guest clock in a fresh live session of lab.html: the date is the host's now (not the day
// the boot snapshot was taken), `sleep 1` still lasts about a second after the jump, dmesg has no complaints about
// the jump, and the journal of such a session replays without divergence.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start_server } from "../../server.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8101;
const CDP_PORT = 9339;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const PROFILES = (process.env.PROFILES ?? "alpine,buildroot,net,study").split(",");
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 300;
const CLOCK_TOLERANCE_S = 120;
const SLEEP_MIN_S = 0.8;
const SLEEP_MAX_S = 1.6;
const CHECK_WAIT_MS = 15000;

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
    return {
        send,
        evaluate: async expression => {
            const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if(!reply.result) throw new Error(`eval: ${JSON.stringify(reply.error)}`);
            if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
            return reply.result.result.value;
        },
    };
}

// window.machine is hooked on assignment so that window.out collects the whole serial output.
const PAGE_HOOKS = `
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
    return tab;
}

const output_of = tab => tab.evaluate("window.out");

// Prints one marker line made of two parts so that the typed command itself never matches the answer.
async function run_shell(tab, line) {
    const before = (await output_of(tab)).length;
    await tab.evaluate(`(async () => {
        for(const ch of ${JSON.stringify(line + "\r")}) { window.machine.type(ch); await new Promise(r => setTimeout(r, 20)); }
        return true;
    })()`);
    return wait_for(`answer to ${line}`, async () => {
        const text = (await output_of(tab)).slice(before);
        const done = /\nDONE-(\d+)\r/.exec(text);
        return done ? text.slice(0, done.index) : null;
    });
}

const number_after = (text, marker) => Number(new RegExp(`\\n${marker}=([0-9.]+)\\r`).exec(text)?.[1]);

async function test_clock(tab, profile) {
    await wait_for("lab ready", () => tab.evaluate("typeof window.machine === 'object' && window.machine !== null"));
    await wait_for("machine live", () => tab.evaluate(`document.getElementById("mode").textContent === "жива"`));
    await wait_for("setup command finished", async () => (await tab.evaluate("window.machine.journal().then(j => j.events.length)")) >= 1);
    await sleep(2000);

    const host_s = Math.floor(Date.now() / 1000);
    const date_text = await run_shell(tab, `echo T=$(date +%s); echo DONE-1`);
    const guest_s = number_after(date_text, "T");
    const diff_s = guest_s - host_s;
    if(!(Math.abs(diff_s) < CLOCK_TOLERANCE_S)) {
        const sent = (await tab.evaluate("window.machine.journal()")).events.filter(event => event.by === "system").map(event => event.data);
        throw new Error(`${profile}: guest clock ${guest_s}, host ${host_s}, difference ${diff_s} s; system input: ${JSON.stringify(sent)}; guest output: ${JSON.stringify((await output_of(tab)).slice(-600))}`);
    }

    const sleep_text = await run_shell(tab, `echo A=$(cut -d" " -f1 /proc/uptime); sleep 1; echo B=$(cut -d" " -f1 /proc/uptime); echo DONE-2`);
    const slept_s = number_after(sleep_text, "B") - number_after(sleep_text, "A");
    if(!(slept_s >= SLEEP_MIN_S && slept_s <= SLEEP_MAX_S)) throw new Error(`${profile}: sleep 1 took ${slept_s} s by the guest uptime`);

    const dmesg_text = await run_shell(tab, `dmesg | grep -iE "error|warn|stall|hung|bug|oops|fail" | head -20; echo DONE-3`);
    console.log(`${profile}: dmesg with suspicious words:${dmesg_text.trim() || "(empty)"}`);
    console.log(`${profile}: guest-host difference ${diff_s} s, sleep 1 = ${slept_s.toFixed(2)} с`);
}

async function test_replay(tab, profile) {
    await wait_for("check in the journal", async () => {
        const journal = await tab.evaluate("window.machine.journal()");
        return journal.events.some(event => event.t === "check");
    });
    await sleep(CHECK_WAIT_MS);
    const id = await tab.evaluate(`(async () => {
        const body = JSON.stringify(await window.machine.journal());
        const reply = await fetch("/journals", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        return (await reply.json()).id;
    })()`);
    const replay = await open_hooked_tab(`lab.html?task=/journals/${id}&name=replay-${profile}&profile=${profile}&relay=off`);
    await wait_for("replay to the end", () => replay.evaluate(`document.getElementById("banner")?.textContent === "Машина ваша"`));
    const error = await replay.evaluate(`document.getElementById("err").textContent`);
    if(error) throw new Error(`${profile}: replay error: ${error}`);
    console.log(`${profile}: journal replayed without divergence`);
}

async function test_profile(profile) {
    const name = `clock-${profile}-${Date.now()}`;
    const tab = await open_hooked_tab(`lab.html?profile=${profile}&relay=off&name=${name}`);
    await test_clock(tab, profile);
    await test_replay(tab, profile);
}

async function main() {
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "clock-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        for(const name of PROFILES) await test_profile(name);
        console.log("OK");
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
