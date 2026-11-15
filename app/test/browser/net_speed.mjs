// Manual measurement (not a test): download speed of the guest through the real public relay,
// then replay of the recorded journal. Run: node app/test/browser/net_speed.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start_server } from "../../server.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8101;
const CDP_PORT = 9339;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const URL_TO_GET = process.env.GET_URL ?? "http://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86/APKINDEX.tar.gz";
const PROFILE = process.env.PROFILE ?? "buildroot";
const WAIT_MS = Number(process.env.WAIT_MS ?? 300000);
const POLL_MS = 300;
const KEY_DELAY_MS = 30;

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
    return {
        evaluate: async expression => {
            const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
            return reply.result.result.value;
        },
    };
}

const type_line = (tab, text) => tab.evaluate(`(async () => {
    for(const ch of ${JSON.stringify(text + "\r")}) { window.machine.type(ch); await new Promise(r => setTimeout(r, ${KEY_DELAY_MS})); }
    return true;
})()`);

async function measure(tab) {
    await wait_for("lab ready", () => tab.evaluate("typeof window.machine === 'object'"));
    await tab.evaluate(`window.out = ""; window.machine.on("serial", b => { window.out += new TextDecoder().decode(b); }); true`);
    await wait_for("relay connected", () => tab.evaluate(`document.getElementById("net").textContent.startsWith("інтернет: ") && !document.getElementById("net").textContent.includes("…")`));
    await wait_for("DHCP", () => tab.evaluate(`/lease of|adding dns/.test(window.out)`));
    console.log("DHCP OK");
    await type_line(tab, `time wget -q -O /dev/null ${URL_TO_GET}; echo END$?`);
    const started = Date.now();
    await wait_for("end of wget", () => tab.evaluate(`/\\nEND\\d+/.test(window.out)`));
    const wall_s = (Date.now() - started) / 1000;
    const out = await tab.evaluate("window.out");
    const tail = out.slice(out.lastIndexOf("time wget"));
    console.log("--- guest output ---" + tail + "\n---");
    console.log(`host wall clock: ${wall_s.toFixed(1)} s`);
    console.log("status:", JSON.stringify(await tab.evaluate("window.machine.status")));
}

async function replay_ok(tab) {
    const id = await tab.evaluate(`(async () => {
        const body = JSON.stringify(await window.machine.journal());
        const reply = await fetch("/journals", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        return (await reply.json()).id;
    })()`);
    const replay = await open_tab(`lab.html?task=/journals/${id}&name=replay&profile=${PROFILE}&relay=off`);
    await wait_for("replay to the end", () => replay.evaluate(`document.getElementById("banner").textContent === "Машина ваша"`));
    const error = await replay.evaluate(`document.getElementById("err").textContent`);
    if(error) throw new Error(`replay error: ${error}`);
    console.log("journal replayed to the end without error");
}

async function main() {
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "net-speed-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        const tab = await open_tab(`lab.html?profile=${PROFILE}`);
        await measure(tab);
        await replay_ok(tab);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
