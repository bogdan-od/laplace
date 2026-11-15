// Browser check of the "study" profile in lab.html: Alpine with the learning tools reaches its prompt,
// gcc builds and runs hello, g++ does the same, `man ls` shows a page.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start_server } from "../../server.mjs";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const SERVER_PORT = 8110;
const CDP_PORT = 9345;
const BASE = `http://127.0.0.1:${SERVER_PORT}/app/`;
const PROMPT = "localhost:~# ";
const WAIT_MS = Number(process.env.WAIT_MS ?? 600000);
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
    const evaluate = async expression => {
        const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if(!reply.result) throw new Error(`eval: ${JSON.stringify(reply.error)}`);
        if(reply.result.exceptionDetails) throw new Error(`eval: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
        return reply.result.result.value;
    };
    return { send, evaluate };
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

const at_prompt = async tab => (await output_of(tab)).replace(/\x1b\[6n$/, "").endsWith(PROMPT);

// Types a line and returns the output between the echo of the line and the next prompt.
async function run_command(tab, text) {
    const before = (await output_of(tab)).length;
    await tab.evaluate(`(async () => {
        for(const ch of ${JSON.stringify(text + "\r")}) { window.machine.type(ch); await new Promise(r => setTimeout(r, ${KEY_DELAY_MS})); }
    })()`);
    await wait_for(`prompt after "${text}»`, async () => (await output_of(tab)).length > before + text.length && await at_prompt(tab));
    return (await output_of(tab)).slice(before);
}

function expect_output(label, output, pattern) {
    if(!pattern.test(output)) throw new Error(`${label}: expected ${pattern}, got ${JSON.stringify(output.slice(-300))}`);
    console.log(`OK ${label}`);
}

async function main() {
    const server = await start_server(SERVER_PORT);
    const profile = mkdtempSync(join(tmpdir(), "study-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    try {
        await wait_for("chromium", async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).ok; } catch { return false; } });
        const began = Date.now();
        const tab = await open_hooked_tab("lab.html?profile=study&relay=off");
        await wait_for("study prompt", async () => {
            try { return await at_prompt(tab); } catch { return false; }
        });
        console.log(`OK prompt "${PROMPT}" in ${((Date.now() - began) / 1000).toFixed(1)} с`);
        const hello_c = String.raw`printf '#include <stdio.h>\nint main(){puts("hello from gcc");}\n' > /tmp/h.c && gcc /tmp/h.c -o /tmp/h && /tmp/h`;
        expect_output("gcc: compile and run hello", await run_command(tab, hello_c), /\nhello from gcc\r/);
        const hello_cpp = String.raw`printf '#include <iostream>\nint main(){std::cout << "hello from g++" << std::endl;}\n' > /tmp/h.cpp && g++ /tmp/h.cpp -o /tmp/hpp && /tmp/hpp`;
        expect_output("g++: compile and run hello", await run_command(tab, hello_cpp), /\nhello from g\+\+\r/);
        expect_output("man ls", await run_command(tab, "man ls | head -5"), /LS\(1\)|ls - list directory contents/i);
        expect_output("bash as a command, the default shell is not replaced", await run_command(tab, "bash -c 'echo $BASH_VERSION'; echo $0"), /\n5\.2[^\r]*\r\n[^\r]*sh\r/);
    } finally {
        await close_browser(chrome, CDP_PORT);
        server.close();
        await remove_profile(profile);
    }
}

main().catch(error => { console.error("FAIL", error.message); process.exitCode = 1; });
